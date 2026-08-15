//! Tauri entry point + commands (port of the Electron main process).

mod cache;
mod fernet;
mod http_client;
mod proxy;
mod site_client;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use cache::{DiskCache, CACHE_MAX_BYTES};
use http_client::new_client;
use proxy::start_proxy;
use site_client::{
    fetch_latest_update, Episode, PlayTarget, SiteClient, UpdateInfo, VideoDetail, VideoItem,
    GITEE_UPDATE_API_URL, GITHUB_UPDATE_API_URL,
};

// ---- Settings ---------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub preload_minutes: i32,
    pub beta_mode: bool,
    pub auto_update_check: bool,
    pub last_auto_update_check: i64,
    pub recent_watches: Vec<VideoItem>,
    pub cache_dir: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            preload_minutes: 3,
            beta_mode: true,
            auto_update_check: false,
            last_auto_update_check: 0,
            recent_watches: Vec::new(),
            cache_dir: String::new(),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub dir: String,
    pub size: u64,
    pub max_bytes: u64,
    pub size_label: String,
    pub max_label: String,
}

// ---- App state --------------------------------------------------------------

const CATALOG_CACHE_TTL: Duration = Duration::from_secs(300); // 5 minutes

struct CatalogCacheEntry {
    items: Vec<VideoItem>,
    fetched_at: Instant,
}

pub struct AppState {
    pub client: reqwest::blocking::Client,
    pub settings: Mutex<Settings>,
    pub cache_dir: Arc<RwLock<PathBuf>>,
    pub proxy_port: u16,
    pub catalog_cache: Mutex<HashMap<String, CatalogCacheEntry>>,
}

fn format_bytes(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.2}GB", bytes as f64 / 1024.0 / 1024.0 / 1024.0)
    } else if bytes >= 1024 * 1024 {
        format!("{:.1}MB", bytes as f64 / 1024.0 / 1024.0)
    } else if bytes >= 1024 {
        format!("{:.1}KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes}B")
    }
}

fn resolve_cache_dir(app: &AppHandle, settings: &Settings) -> PathBuf {
    if settings.cache_dir.is_empty() {
        app.path()
            .app_data_dir()
            .unwrap_or_default()
            .join("video_cache")
    } else {
        PathBuf::from(&settings.cache_dir)
    }
}

fn settings_file(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_default()
        .join("settings.json")
}

fn load_settings(app: &AppHandle) -> Settings {
    let file = settings_file(app);
    match fs::read_to_string(&file) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

fn save_settings(app: &AppHandle, s: &Settings) {
    let file = settings_file(app);
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(raw) = serde_json::to_string_pretty(s) {
        let _ = fs::write(file, raw);
    }
}

// ---- Commands ---------------------------------------------------------------

#[tauri::command]
async fn fetch_catalog(state: State<'_, AppState>, path: String) -> Result<Vec<VideoItem>, String> {
    {
        let cache = state.catalog_cache.lock().unwrap();
        if let Some(entry) = cache.get(&path) {
            if entry.fetched_at.elapsed() < CATALOG_CACHE_TTL {
                return Ok(entry.items.clone());
            }
        }
    }
    let client = state.client.clone();
    let path_for_closure = path.clone();
    let items = match tauri::async_runtime::spawn_blocking(move || {
        SiteClient::new(client).fetch_catalog(&path_for_closure)
    })
    .await
    {
        Ok(result) => result?,
        Err(e) => return Err(format!("task join error: {e}")),
    };
    {
        let mut cache = state.catalog_cache.lock().unwrap();
        cache.insert(
            path,
            CatalogCacheEntry {
                items: items.clone(),
                fetched_at: Instant::now(),
            },
        );
    }
    Ok(items)
}

#[tauri::command]
async fn fetch_detail(state: State<'_, AppState>, item: VideoItem) -> Result<VideoDetail, String> {
    let client = state.client.clone();
    match tauri::async_runtime::spawn_blocking(move || SiteClient::new(client).fetch_detail(&item))
        .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("task join error: {e}")),
    }
}

#[tauri::command]
async fn resolve_play(state: State<'_, AppState>, episode: Episode) -> Result<PlayTarget, String> {
    let client = state.client.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        SiteClient::new(client).resolve_play_target(&episode)
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("task join error: {e}")),
    }
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn set_settings(state: State<AppState>, app: AppHandle, value: Settings) -> Settings {
    let mut s = state.settings.lock().unwrap();
    let dir_changed = value.cache_dir != s.cache_dir;
    *s = value;
    save_settings(&app, &s);
    if dir_changed {
        let new_dir = resolve_cache_dir(&app, &s);
        *state.cache_dir.write().unwrap() = new_dir;
    }
    s.clone()
}

#[tauri::command]
fn save_recent_watch(state: State<AppState>, app: AppHandle, item: VideoItem) -> Vec<VideoItem> {
    let mut s = state.settings.lock().unwrap();
    if item.url.is_empty() {
        return s.recent_watches.clone();
    }
    let mut list: Vec<VideoItem> = s
        .recent_watches
        .iter()
        .filter(|w| w.url != item.url)
        .cloned()
        .collect();
    list.insert(0, item);
    list.truncate(40);
    s.recent_watches = list;
    save_settings(&app, &s);
    s.recent_watches.clone()
}

#[tauri::command]
fn clear_recent_watches(state: State<AppState>, app: AppHandle) -> Vec<VideoItem> {
    let mut s = state.settings.lock().unwrap();
    s.recent_watches = Vec::new();
    save_settings(&app, &s);
    Vec::new()
}

#[tauri::command]
fn get_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn get_proxy_base(state: State<AppState>) -> String {
    format!("http://127.0.0.1:{}", state.proxy_port)
}

#[tauri::command]
async fn check_update(state: State<'_, AppState>, source: String) -> Result<UpdateInfo, String> {
    let api_url = if source == "gitee" {
        GITEE_UPDATE_API_URL
    } else {
        GITHUB_UPDATE_API_URL
    };
    let display = if source == "gitee" { "Gitee" } else { "GitHub" };
    let current = env!("CARGO_PKG_VERSION").to_string();
    let client = state.client.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        fetch_latest_update(&client, api_url, display, &current)
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("task join error: {e}")),
    }
}

#[tauri::command]
fn open_external(url: String) -> bool {
    if url.starts_with("http://") || url.starts_with("https://") {
        let _ = open::that(url);
        true
    } else {
        false
    }
}

#[tauri::command]
async fn get_cache_info(state: State<'_, AppState>) -> Result<CacheInfo, String> {
    let dir = state.cache_dir.read().unwrap().clone();
    match tauri::async_runtime::spawn_blocking(move || {
        let cache = DiskCache::new(dir.clone(), CACHE_MAX_BYTES);
        let size = cache.size();
        CacheInfo {
            dir: dir.to_string_lossy().to_string(),
            size,
            max_bytes: CACHE_MAX_BYTES,
            size_label: format_bytes(size),
            max_label: format_bytes(CACHE_MAX_BYTES),
        }
    })
    .await
    {
        Ok(info) => Ok(info),
        Err(e) => Err(format!("task join error: {e}")),
    }
}

#[tauri::command]
async fn clear_cache(state: State<'_, AppState>) -> Result<CacheInfo, String> {
    let dir = state.cache_dir.read().unwrap().clone();
    match tauri::async_runtime::spawn_blocking(move || {
        DiskCache::new(dir.clone(), CACHE_MAX_BYTES).clear();
        let cache = DiskCache::new(dir.clone(), CACHE_MAX_BYTES);
        let size = cache.size();
        CacheInfo {
            dir: dir.to_string_lossy().to_string(),
            size,
            max_bytes: CACHE_MAX_BYTES,
            size_label: format_bytes(size),
            max_label: format_bytes(CACHE_MAX_BYTES),
        }
    })
    .await
    {
        Ok(info) => Ok(info),
        Err(e) => Err(format!("task join error: {e}")),
    }
}

// ---- Entry ------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = new_client();

    tauri::Builder::default()
        .setup(|app| {
            let settings = load_settings(app.handle());
            let cache_dir = resolve_cache_dir(app.handle(), &settings);
            let cache_dir = std::sync::Arc::new(RwLock::new(cache_dir));
            let proxy_port = start_proxy(client.clone(), cache_dir.clone());

            app.manage(AppState {
                client,
                settings: Mutex::new(settings),
                cache_dir,
                proxy_port,
                catalog_cache: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fetch_catalog,
            fetch_detail,
            resolve_play,
            get_settings,
            set_settings,
            save_recent_watch,
            clear_recent_watches,
            get_version,
            get_proxy_base,
            check_update,
            open_external,
            get_cache_info,
            clear_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
