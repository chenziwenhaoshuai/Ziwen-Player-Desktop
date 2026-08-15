//! Local HTTP proxy: forwards requests in Node-style (trust-all TLS, custom
//! Referer), rewrites m3u8 manifests so every segment/key also routes through
//! the proxy, and serves Fernet-encrypted `.image` files. Full (non-range)
//! binary responses are cached to disk.

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use regex::Regex;
use reqwest::blocking::Client;
use tiny_http::{Header, Method, Request, Response, Server};
use url::Url;

use crate::cache::{DiskCache, CACHE_MAX_BYTES};
use crate::fernet::fernet_decrypt;
use crate::site_client::PEACH_FERNET_KEY;

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn absolutize_uri(uri: &str, base: &str) -> String {
    match Url::parse(base) {
        Ok(b) => b.join(uri).map(|u| u.to_string()).unwrap_or_else(|_| uri.to_string()),
        Err(_) => uri.to_string(),
    }
}

fn proxy_url_for(url: &str, referer: &str, proxy_base: &str) -> String {
    format!(
        "{proxy_base}/proxy?url={}&referer={}",
        urlencode(url),
        urlencode(referer)
    )
}

fn ends_with_suffix(url: &str, suffix: &str) -> bool {
    let without_query = url.split('?').next().unwrap_or(url);
    without_query.to_lowercase().ends_with(suffix)
}

fn looks_like_m3u8(url: &str, body: &[u8]) -> bool {
    if ends_with_suffix(url, ".m3u8") {
        return true;
    }
    let head = String::from_utf8_lossy(&body[..body.len().min(256)]);
    head.trim_start().starts_with("#EXTM3U")
}

fn rewrite_m3u8(text: &str, base_url: &str, proxy_base: &str) -> String {
    let key_re = Regex::new(r#"^(#EXT-X-KEY:.*URI=")([^"]+)(".*)$"#).unwrap();
    text.lines()
        .map(|line| {
            let t = line.trim();
            if t.is_empty() || t.starts_with('#') {
                if let Some(c) = key_re.captures(t) {
                    let uri = c.get(2).map(|m| m.as_str()).unwrap_or("");
                    let abs = absolutize_uri(uri, base_url);
                    return format!(
                        "{}{}{}",
                        c.get(1).map(|m| m.as_str()).unwrap_or(""),
                        proxy_url_for(&abs, base_url, proxy_base),
                        c.get(3).map(|m| m.as_str()).unwrap_or("")
                    );
                }
                return line.to_string();
            }
            let abs = absolutize_uri(t, base_url);
            proxy_url_for(&abs, base_url, proxy_base)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn decode_encrypted_image(text: &str) -> (String, Vec<u8>) {
    let mut data_url = if let Some(split) = text.find("@@@") {
        fernet_decrypt(&text[..split], PEACH_FERNET_KEY).unwrap_or_default() + &text[split + 3..]
    } else {
        fernet_decrypt(text.trim(), PEACH_FERNET_KEY).unwrap_or_default()
    };
    if !data_url.starts_with("data:") {
        data_url = format!("data:image/jpeg;base64,{data_url}");
    }
    let comma = data_url.find(',').unwrap_or(data_url.len());
    let mut mime = data_url[5..comma]
        .split(';')
        .next()
        .unwrap_or("image/jpeg")
        .to_string();
    if mime == "image/jpg" {
        mime = "image/jpeg".to_string();
    }
    let payload = data_url[comma + 1..].trim();
    let bytes = STANDARD.decode(payload.as_bytes()).unwrap_or_default();
    (mime, bytes)
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

fn respond(request: Request, status: u16, content_type: &str, body: Vec<u8>) {
    let mut response = Response::from_data(body).with_status_code(status);
    response.add_header(header("Content-Type", content_type));
    response.add_header(header("Access-Control-Allow-Origin", "*"));
    response.add_header(header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"));
    response.add_header(header("Access-Control-Allow-Headers", "*"));
    let _ = request.respond(response);
}

fn handle_proxy(
    request: Request,
    client: Client,
    cache_dir: Arc<RwLock<PathBuf>>,
    proxy_base: String,
) {
    let full = request.url().to_string();
    let parsed = Url::parse(&format!("http://127.0.0.1{full}"));
    let (url, referer) = match parsed {
        Ok(u) => {
            let url = u
                .query_pairs()
                .find(|(k, _)| k == "url")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            let referer = u
                .query_pairs()
                .find(|(k, _)| k == "referer")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            (url, referer)
        }
        Err(_) => (String::new(), String::new()),
    };

    if url.is_empty() {
        respond(request, 400, "text/plain", b"missing url".to_vec());
        return;
    }

    let cache = {
        let dir = cache_dir.read().unwrap().clone();
        DiskCache::new(dir, CACHE_MAX_BYTES)
    };

    let resp = match client
        .get(&url)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml,image/*,*/*;q=0.8",
        )
        .header("Referer", referer.as_str())
        .send()
    {
        Ok(r) => r,
        Err(e) => {
            respond(request, 502, "text/plain", format!("proxy error: {e}").into_bytes());
            return;
        }
    };

    let upstream_ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let upstream_bytes = match resp.bytes() {
        Ok(b) => b.to_vec(),
        Err(e) => {
            respond(request, 502, "text/plain", format!("proxy error: {e}").into_bytes());
            return;
        }
    };

    // Encrypted peach image.
    if ends_with_suffix(&url, ".image") {
        if let Some(hit) = cache.get(&url) {
            respond(request, 200, &hit.content_type, hit.data);
            return;
        }
        let (mime, bytes) = decode_encrypted_image(&String::from_utf8_lossy(&upstream_bytes));
        cache.put(&url, &bytes, &mime);
        respond(request, 200, &mime, bytes);
        return;
    }

    // m3u8 manifest.
    if looks_like_m3u8(&url, &upstream_bytes) {
        let rewritten = rewrite_m3u8(&String::from_utf8_lossy(&upstream_bytes), &url, &proxy_base);
        respond(
            request,
            200,
            "application/vnd.apple.mpegurl; charset=utf-8",
            rewritten.into_bytes(),
        );
        return;
    }

    // Binary passthrough with optional cache.
    let mut data = upstream_bytes;
    let mut content_type = upstream_ct;
    let is_range = request.headers().iter().any(|h| h.field.equiv("Range"));
    if !is_range {
        if let Some(hit) = cache.get(&url) {
            data = hit.data;
            content_type = if hit.content_type.is_empty() {
                content_type
            } else {
                hit.content_type
            };
        } else {
            cache.put(&url, &data, &content_type);
        }
    }
    respond(request, 200, &content_type, data);
}

pub fn start_proxy(client: Client, cache_dir: Arc<RwLock<PathBuf>>) -> u16 {
    let server = Server::http("127.0.0.1:0").expect("failed to bind proxy");
    let port = server.server_addr().to_ip().unwrap().port();

    std::thread::spawn(move || {
        loop {
            let request = match server.recv() {
                Ok(r) => r,
                Err(_) => break,
            };
            if request.method() == &Method::Options {
                let mut response = Response::from_data(Vec::new()).with_status_code(204);
                response.add_header(header("Access-Control-Allow-Origin", "*"));
                response.add_header(header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"));
                response.add_header(header("Access-Control-Allow-Headers", "*"));
                let _ = request.respond(response);
                continue;
            }
            let client = client.clone();
            let cache_dir = cache_dir.clone();
            let proxy_base = format!("http://127.0.0.1:{port}");
            std::thread::spawn(move || {
                handle_proxy(request, client, cache_dir, proxy_base);
            });
        }
    });

    port
}
