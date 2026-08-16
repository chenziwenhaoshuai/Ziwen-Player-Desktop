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
use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

use cache::{DiskCache, CACHE_MAX_BYTES};
use http_client::new_client;
use proxy::start_proxy;
use site_client::{
    fetch_latest_update, Episode, PlayTarget, SiteClient, UpdateInfo, VideoDetail, VideoItem,
    GITEE_UPDATE_API_URL, GITHUB_UPDATE_API_URL,
};

// ---- Settings ---------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub preload_minutes: i32,
    pub beta_mode: bool,
    pub auto_update_check: bool,
    pub last_auto_update_check: i64,
    pub recent_watches: Vec<VideoItem>,
    pub cache_dir: String,
    pub boss_margin: f64,
    pub boss_delay_ms: f64,
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
            boss_margin: 80.0,
            boss_delay_ms: 450.0,
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
fn hide_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn show_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Returns true when the global cursor is still within the window's bounds
/// expanded by `margin` physical pixels. Used by boss mode so that moving the
/// mouse onto the title bar / resize border (to drag or resize) doesn't count
/// as "leaving" the window.
#[tauri::command]
fn cursor_near_window(app: AppHandle, margin: f64) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    let Ok(pos) = window.inner_position() else {
        return false;
    };
    let Ok(size) = window.inner_size() else {
        return false;
    };
    // cursor_position() returns the GLOBAL screen coordinates; make it
    // relative to the window's client area before comparing.
    let Ok(cursor) = window.cursor_position() else {
        return false;
    };
    let x = cursor.x - pos.x as f64;
    let y = cursor.y - pos.y as f64;
    let w = size.width as f64;
    let h = size.height as f64;
    x >= -margin && x <= w + margin && y >= -margin && y <= h + margin
}

/// Shows a transparent border overlay around the main window so the user can
/// visually see the boss-mode boundary while adjusting it.
#[tauri::command]
fn preview_boundary(app: AppHandle, margin: f64) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(preview) = app.get_webview_window("boundary-preview") else {
        return;
    };
    let Ok(pos) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let m = margin.round() as i32;
    let _ = preview.set_position(tauri::PhysicalPosition::new(pos.x - m, pos.y - m));
    let _ = preview.set_size(tauri::PhysicalSize::new(
        size.width + 2 * m as u32,
        size.height + 2 * m as u32,
    ));
    let _ = preview.set_ignore_cursor_events(true);
    let _ = preview.show();
    let _ = window.set_focus();
}

#[tauri::command]
fn hide_boundary_preview(app: AppHandle) {
    if let Some(preview) = app.get_webview_window("boundary-preview") {
        let _ = preview.hide();
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

            // System tray icon: clicking it restores the hidden window (boss mode).
            let tray_icon = app.default_window_icon().cloned().unwrap_or_else(|| {
                // Fallback: 32x32 solid gold square.
                let mut rgba = vec![0u8; 32 * 32 * 4];
                for px in rgba.chunks_mut(4) {
                    px[0] = 247;
                    px[1] = 200;
                    px[2] = 67;
                    px[3] = 255;
                }
                Image::new_owned(rgba, 32, 32)
            });
            match TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .tooltip("子文播放器")
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)
            {
                Ok(tray) => {
                    // Keep the tray handle alive for the whole app lifetime.
                    app.manage(tray);
                }
                Err(e) => {
                    eprintln!("failed to create tray icon: {e}");
                }
            }

            // Boundary preview overlay (transparent border shown around the
            // window while adjusting the boss-mode margin). Kept hidden until
            // `preview_boundary` is called.
            let _ = WebviewWindowBuilder::new(
                app,
                "boundary-preview",
                WebviewUrl::App("preview.html".into()),
            )
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .closable(false)
            .visible(false)
            .build();

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
            clear_cache,
            hide_window,
            show_window,
            cursor_near_window,
            preview_boundary,
            hide_boundary_preview
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Closing the main window should fully quit the app (and remove the
            // tray icon), rather than leaving the process running in the tray.
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = event
            {
                if label == "main" {
                    app_handle.exit(0);
                }
            }
        });
}
