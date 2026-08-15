//! Minimal LRU disk cache (keyed by URL sha1) for video segments / images.
//! Mirrors the Android app's 1GB SimpleCache behaviour.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sha1::{Digest, Sha1};

pub const CACHE_MAX_BYTES: u64 = 1024 * 1024 * 1024; // 1GB

#[derive(Clone)]
pub struct CacheEntry {
    pub data: Vec<u8>,
    pub content_type: String,
}

pub struct DiskCache {
    pub dir: PathBuf,
    max_bytes: u64,
    // Serialize eviction / size scans.
    lock: Mutex<()>,
}

fn is_meta_file(p: &Path) -> bool {
    p.extension()
        .and_then(|x| x.to_str())
        .map(|s| s == "meta")
        .unwrap_or(false)
}

impl DiskCache {
    pub fn new(dir: PathBuf, max_bytes: u64) -> Self {
        DiskCache {
            dir,
            max_bytes,
            lock: Mutex::new(()),
        }
    }

    fn key_for(url: &str) -> String {
        let mut hasher = Sha1::new();
        hasher.update(url.as_bytes());
        hex_encode(&hasher.finalize())
    }

    fn data_file(&self, url: &str) -> PathBuf {
        self.dir.join(Self::key_for(url))
    }

    fn meta_file(&self, url: &str) -> PathBuf {
        self.dir.join(format!("{}.meta", Self::key_for(url)))
    }

    pub fn get(&self, url: &str) -> Option<CacheEntry> {
        let file = self.data_file(url);
        let data = fs::read(&file).ok()?;
        let content_type = fs::read_to_string(self.meta_file(url))
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("contentType").and_then(|c| c.as_str()).map(String::from))
            .unwrap_or_default();
        Some(CacheEntry { data, content_type })
    }

    pub fn put(&self, url: &str, data: &[u8], content_type: &str) {
        let _guard = self.lock.lock().unwrap();
        if fs::create_dir_all(&self.dir).is_err() {
            return;
        }
        let _ = fs::write(self.data_file(url), data);
        let meta = format!("{{\"contentType\":\"{}\"}}", content_type.replace('"', ""));
        let _ = fs::write(self.meta_file(url), meta);
        self.evict();
    }

    fn evict(&self) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        let mut files: Vec<(u64, u64, PathBuf)> = Vec::new();
        let mut total = 0u64;
        for e in entries.flatten() {
            let p = e.path();
            if is_meta_file(&p) {
                continue;
            }
            if let Ok(meta) = fs::metadata(&p) {
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                files.push((mtime, meta.len(), p));
                total += meta.len();
            }
        }
        if total <= self.max_bytes {
            return;
        }
        files.sort_by_key(|f| f.0); // oldest first
        for (_, size, p) in files {
            if total <= self.max_bytes {
                break;
            }
            let _ = fs::remove_file(&p);
            let _ = fs::remove_file(p.with_extension("meta"));
            total = total.saturating_sub(size);
        }
    }

    pub fn size(&self) -> u64 {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return 0;
        };
        entries
            .flatten()
            .filter(|e| !is_meta_file(&e.path()))
            .map(|e| fs::metadata(e.path()).map(|m| m.len()).unwrap_or(0))
            .sum()
    }

    pub fn clear(&self) {
        let _guard = self.lock.lock().unwrap();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
