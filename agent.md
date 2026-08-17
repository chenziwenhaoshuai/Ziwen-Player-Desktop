# 子文播放器 Windows 桌面版（Tauri）— Agent 交接文档

> 本文件是给后续接手此项目的 agent / 开发者的完整交接说明，覆盖**编译方法**、**项目架构**和**关键设计点与坑**。改代码前请先通读第 6 节「关键设计点与坑」。

---

## 1. 项目概览

- **来源**：Android TV 版 [Ziwen-Player](https://github.com/chenziwenhaoshuai/Ziwen-Player)（Java + ExoPlayer）移植为 Windows 桌面应用。
- **当前实现**：**Tauri 2**（Rust 后端 + 系统 WebView2 渲染前端），不再打包 Chromium。
- **GitHub 仓库**：`chenziwenhaoshuai/Ziwen-Player-Desktop`（远程为 SSH `git@github.com:chenziwenhaoshuai/Ziwen-Player-Desktop.git`）。
- **当前版本**：`v1.0.24`。

### 两个目录（勿混淆）

| 目录 | 说明 |
| --- | --- |
| `C:\Users\13040\Desktop\Ziwen-Player-Tauri` | **主项目**（本文档所述）。 |
| `C:\Users\13040\Desktop\Ziwen-player-desktop` | 早期 Electron 版，**已废弃、不要改动**。 |

### 核心功能

- 爱壹帆（yfvod.com）首页 / 电影 / 连续剧 / 综艺 / 动漫分类浏览 + 关键词搜索。
- 「你懂的」内测频道（peach API，Fernet 加密）。
- m3u8 / mp4 / flv / webm 播放（hls.js + 本地代理解决跨域与 Referer）。
- 最近观看、断点续播、提前缓冲设置、1GB LRU 磁盘缓存。
- 画中画（PiP）、老板模式（鼠标离开自动暂停+隐藏到托盘）。
- GitHub / Gitee 更新检查。

---

## 2. 目录结构

```
Ziwen-Player-Tauri/
├── agent.md                        本交接文档
├── rust-toolchain.toml             固定 GNU 工具链（必须保留）
├── .cargo/config.toml              固定 build target 为 x86_64-pc-windows-gnu（必须保留）
├── .gitignore
├── README.md
├── package.json                    Tauri CLI（devDependency）
├── generate-icons.js               图标生成脚本
├── download-mingw.js               mingw-w64 下载脚本（首次搭环境用）
├── src/                            前端（frontendDist 直接指向这里，构建时被内嵌进 exe）
│   ├── index.html                  界面外壳
│   ├── styles.css                  深色主题样式
│   ├── app.js                      界面与播放逻辑（核心前端文件）
│   ├── preview.html                老板模式边界预览（透明虚线框）页面
│   ├── vendor/hls.min.js           hls.js（m3u8 播放）
│   └── assets/donation_qr.png
└── src-tauri/                      Rust 后端
    ├── Cargo.toml
    ├── Cargo.lock
    ├── tauri.conf.json             应用配置（窗口/打包/版本）
    ├── build.rs                    由 tauri-build 生成
    ├── capabilities/default.json   权限配置（core:default）
    ├── icons/
    ├── vendor/webview2-com-sys/    改造过的 WebView2 绑定（见 6.1，重点）
    └── src/
        ├── main.rs                 入口（调用 ziwen_player_lib::run()）
        ├── lib.rs                  Tauri 命令 + AppState + setup（核心后端文件）
        ├── site_client.rs          yfvod HTML 解析 + peach API + Fernet + 更新检查
        ├── proxy.rs                本地 HTTP 代理（m3u8 重写 / CORS / 加密图片 / 缓存）
        ├── fernet.rs               Fernet 解密（AES-128-CBC + HMAC-SHA256）
        ├── http_client.rs          信任任意 TLS 的 HTTP 客户端
        └── cache.rs                1GB LRU 磁盘缓存
```

---

## 3. 编译环境与编译方法（重点）

### 3.1 环境现状（本机）

- **无管理员权限**，**无 MSVC**（没有 VS Build Tools，`cl.exe` / `link.exe` 均不存在）。
- 使用 **Rust GNU 工具链** + **winlibs mingw-w64**（提供 `dlltool.exe` / `ld.exe` / `gcc.exe` / `objdump.exe`）。
- 工具链版本：rustc 1.97.1（`stable-x86_64-pc-windows-gnu`，默认工具链）；mingw 在 `C:\Users\13040\mingw64\mingw64\bin`。
- Node.js v24（用于 `npx tauri` CLI）。

### 3.2 工具链配置（已在仓库中固定）

- `rust-toolchain.toml`：
  ```toml
  [toolchain]
  channel = "stable"
  profile = "minimal"
  targets = ["x86_64-pc-windows-gnu"]
  ```
- `.cargo/config.toml`：
  ```toml
  [build]
  target = "x86_64-pc-windows-gnu"
  ```

> ⚠️ 这两个文件**必须保留且必须是 GNU**。历史上曾一度被改成 MSVC，导致所有构建报 `failed to find tool "cl.exe"`。本机没有 MSVC，永远不要改成 msvc 目标。

### 3.3 编译命令

所有编译前都要先把 cargo 和 mingw 加进 PATH：

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;C:\Users\13040\mingw64\mingw64\bin;$env:PATH"
```

**只编译 exe（快，~35s–1min 增量）**，在 `src-tauri` 目录下：

```powershell
cargo build --release
```

**完整打包（exe + NSIS 安装包）**，在项目根目录下：

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;C:\Users\13040\mingw64\mingw64\bin;$env:PATH"
$env:HTTP_PROXY = "http://127.0.0.1:7078"   # 下载 NSIS 需要代理（见 6.8）
$env:HTTPS_PROXY = "http://127.0.0.1:7078"
npx tauri build
```

### 3.4 构建产物位置

> 因为 `.cargo/config.toml` 固定了 target，产物在 **`target\x86_64-pc-windows-gnu\`** 下（不是 `target\release\`）。

```
src-tauri\target\x86_64-pc-windows-gnu\release\ziwen-player.exe            # 单文件便携版
src-tauri\target\x86_64-pc-windows-gnu\release\bundle\nsis\Ziwen-Player_1.0.24_x64-setup.exe  # NSIS 安装包
src-tauri\target\x86_64-pc-windows-gnu\release\WebView2Loader.dll          # tauri-build 拷出来的（开发便利，见 6.1）
```

### 3.5 编译常见错误与解决

| 错误 | 原因 | 解决 |
| --- | --- | --- |
| `failed to find tool "cl.exe"` / `CC_x86_64-pc-windows-msvc` | 目标被改成了 MSVC | 确认 `rust-toolchain.toml` 与 `.cargo/config.toml` 都是 gnu |
| `error calling dlltool 'dlltool.exe': program not found` | PATH 里没有 mingw | 把 `C:\Users\13040\mingw64\mingw64\bin` 加进 PATH |
| `export ordinal too large`（cargo test） | crate-type 含 cdylib/staticlib 时 GNU 链接报错 | 已改为 `crate-type = ["rlib"]`，不要加回 cdylib/staticlib |
| `.rsrc merge failure: multiple non-default manifests` | GNU ld 的**警告**，可忽略 | 无影响 |
| `failed to remove file ... 拒绝访问 (os error 5)` | exe 正在运行被锁定 | 先 `Stop-Process ziwen-player` 再编译 |

---

## 4. 后端架构（Rust）

### 4.1 `lib.rs` — 入口、状态与命令

**AppState**（`app.manage()` 注入）：

```rust
pub struct AppState {
    pub client: reqwest::blocking::Client,   // 共享 HTTP 客户端
    pub settings: Mutex<Settings>,           // 用户设置
    pub cache_dir: Arc<RwLock<PathBuf>>,     // 缓存目录
    pub proxy_port: u16,                     // 本地代理端口
    pub catalog_cache: Mutex<HashMap<String, CatalogCacheEntry>>, // 目录 5 分钟内存缓存
}
```

**Settings**（`#[serde(rename_all = "camelCase", default)]`，字段见下）：

`preload_minutes`(默认3)、`beta_mode`(默认true)、`auto_update_check`(默认false)、`last_auto_update_check`、`recent_watches`、`cache_dir`、`boss_margin`(默认80.0)、`boss_delay_ms`(默认450.0)。

设置持久化在 `app_data_dir()/settings.json`；缓存目录默认 `app_data_dir()/video_cache`。

**命令清单**（`invoke_handler` 注册，前端通过 `window.__TAURI__.core.invoke` 调用）：

| 命令 | 说明 |
| --- | --- |
| `fetch_catalog(path)` | 异步，`spawn_blocking` 抓目录，5 分钟内存缓存 |
| `fetch_detail(item)` | 抓详情 + 剧集列表 |
| `resolve_play(episode)` | 解析真实播放地址（`PlayTarget`） |
| `get_settings` / `set_settings(value)` | 读写设置（set 时若 cache_dir 变化会更新缓存目录） |
| `save_recent_watch(item)` / `clear_recent_watches` | 最近观看（去重、最多 40 条） |
| `get_version` | 返回版本号（来自 `CARGO_PKG_VERSION`） |
| `get_proxy_base` | 返回 `http://127.0.0.1:{port}` |
| `check_update(source)` | GitHub/Gitee 最新 Release 检查 |
| `open_external(url)` | 用系统浏览器打开 |
| `hide_window` / `show_window` | 老板模式隐藏/恢复主窗口 |
| `cursor_near_window(margin)` | 判断全局鼠标是否还在窗口外扩 margin 的范围内（老板模式） |
| `preview_boundary(margin)` / `hide_boundary_preview` | 显示/隐藏老板模式边界预览框 |
| `get_cache_info` / `clear_cache` | 缓存统计/清空 |

**setup 关键逻辑**（顺序很重要）：

1. `load_settings` → `resolve_cache_dir` → `start_proxy`（绑定 127.0.0.1:0 随机端口）。
2. 创建系统托盘图标（`app.manage(tray)` 保持句柄存活，否则托盘点击会闪退）。
3. 创建 `boundary-preview` 透明预览窗口（`visible(false)` 隐藏，不要改成懒创建，否则预览框失效）。
4. `app.manage(AppState{...})` —— **必须放在这里，见 6.2 的启动竞态**。

**关闭行为**：`.build(...).run(|app_handle, event| { ... })` 中监听 `RunEvent::WindowEvent{ event: WindowEvent::Destroyed, label: "main" }` → `app_handle.exit(0)`（点 X 完全退出并移除托盘图标）。**不要**改回 `.on_window_event(CloseRequested => exit)`，那会导致黑屏（见 6.3）。

### 4.2 `site_client.rs` — 站点解析

- 常量：`BASE_URL=https://www.yfvod.com`、四个分类路径、`PEACH_PATH="peach://catalog"`、`PEACH_FERNET_KEY`、更新 API URL。
- 数据模型：`VideoItem`、`Episode`、`VideoDetail`、`PlayTarget`、`UpdateInfo`（均 `rename_all = "camelCase"`）。
- `SiteClient::{fetch_catalog, fetch_detail, resolve_play_target}` 是三条主路径；peach 走 `fetch_peach_*`（sm-api.wieuc.com，Fernet 解密后解析 JSON）。
- 关键细节：
  - **正则全部用 `once_cell::sync::Lazy` 预编译**（历史上每调用一次 `Regex::new` 导致解析慢 1.4–3s，这是性能瓶颈）。
  - `attr(tag, name)` 用**手写字节查找**解析属性（曾用正则吞掉了开引号导致 off-by-one，返回空目录）。
  - `str_val` 会**把 JSON 数字/布尔强转字符串**（peach 的 `id` 字段是数字，曾因只处理字符串导致分类为空）。
  - `normalize_version_name` / `compare_version_names`：版本号分段比较（供更新检查用）。

### 4.3 `proxy.rs` — 本地代理（解决跨域/Referer）

- `start_proxy(client, cache_dir) -> u16`：`tiny_http` 监听 `127.0.0.1:0`，spawn 线程处理请求，返回端口。
- `GET /proxy?url=...&referer=...`：转发请求，带自定义 Referer，返回时加 CORS 头。
- **m3u8 重写**：把清单里的分段 / 密钥 URI 全部改成经代理的绝对地址，让每个分片也走代理（`rewrite_m3u8`）。
- `.image` 结尾：Fernet 解密图片数据再返回（`decode_encrypted_image`）。
- 完整（非 Range）的 GET 响应写入磁盘缓存（`DiskCache`）。

### 4.4 其它模块

- `fernet.rs`：`fernet_decrypt(token, key)` — Fernet（AES-128-CBC + HMAC-SHA256）解密。
- `http_client.rs`：`new_client()` 返回信任任意 TLS 证书的 `reqwest::blocking::Client`（`danger_accept_invalid_certs`）；`fetch_text` / `get`。
- `cache.rs`：`DiskCache`，`CACHE_MAX_BYTES = 1GB`，URL 的 SHA1 十六进制作文件名，超出后按时间逐出（`evict`）。

### 4.5 `vendor/webview2-com-sys` — 改造过的 WebView2 绑定（重点）

这是把官方 `webview2-com-sys 0.38.2` vendor 进来并改造的版本，通过 `Cargo.toml` 的 `[patch.crates-io]` 替换：

```toml
[patch.crates-io]
webview2-com-sys = { path = "vendor/webview2-com-sys" }
```

改造内容见 6.1。**这是为了让便携版 exe 完全自包含（不依赖 `WebView2Loader.dll`）。**

---

## 5. 前端架构（`src/app.js`）

`app.js` 是唯一的前端逻辑文件（约 1500 行），结构如下：

- **IPC 桥**：`tauriInvoke(cmd, args)` → `window.__TAURI__.core.invoke`；`api` 对象封装所有命令。**这里做了「state not managed」重试（见 6.2）**。
- **常量**：分类路径、缓冲选项、常量。
- **状态**：`settings`、`proxyBase`、`catalogItems`、`screen`、`videoElement`、`bossMode` 等。
- **目录页**：`showCatalog` → `renderNav`（侧栏）+ `loadCatalog`（抓数据）→ `renderCatalogGrid`（渐进式分批渲染海报）。
- **详情页**：`loadDetail` → `showDetail` → 线路分组 + 剧集网格。
- **播放**：`playEpisode` → `resolve_play` → `showPlayer`（创建 `<video>`）→ `setupHls`（hls.js）；断点续播 `resumePositionForEpisode`。
- **画中画**：`togglePictureInPicture`（原生 `requestPictureInPicture()`）。
- **老板模式**：`setupBossMode`（`mouseleave` → 轮询 `cursorNearWindow` → 超过 `bossDelayMs` 暂停+`hideWindow`；`mouseenter` 恢复）。
- **设置页**：`showSettings`（缓冲、老板边界/延迟、缓存目录、内测开关、更新检查）。
- **键盘**：空格播放/暂停、方向键、回车、返回键（`handleBack`）。
- **启动**：`init()` → `getSettings` → `getProxyBase` → `showCatalog('首页','/')`。

`index.html`：`#app`（`#nav-rail` 侧栏 + `#content` 主区）+ `#loading` + `#toast` + `#webview-host`。`preview.html`：老板模式边界预览（透明虚线框）。

---

## 6. 关键设计点与坑（务必先读）

### 6.1 WebView2Loader 自包含（便携版 exe）

**问题**：官方 `webview2-com-sys` 在 GNU 工具链下用 `#[link(name = "WebView2Loader.dll")]` 静态导入 5 个函数，导致 exe 的导入表硬依赖 `WebView2Loader.dll`。拷贝 exe 到别的文件夹运行会报「找不到 webview2loader.dll」。

**为什么不能静态链接**：`WebView2LoaderStatic.lib` 是 MSVC 的 COFF 静态库（含 C++ 对象），GNU `ld` 无法链接；本机又无 MSVC。

**解决方案**（vendor 版 `webview2-com-sys`）：
- 去掉 5 个 DLL 导入（`CompareBrowserVersions`、`CreateCoreWebView2Environment`、`CreateCoreWebView2EnvironmentWithOptions`、`GetAvailableCoreWebView2BrowserVersionString`、`...WithOptions`），改为运行时 `LoadLibraryW` + `GetProcAddress` 解析（见 `vendor/webview2-com-sys/src/lib.rs` 的 `runtime` 模块 + `link_webview2!` 宏）。
- 把 x64 的 `WebView2Loader.dll`（160KB）用 `include_bytes!` 内嵌进 exe。
- 启动时按顺序加载：① exe 同目录已有 DLL → ② 内嵌字节释放到 exe 同目录（目录可写时）→ ③ 释放到 `%TEMP%` → ④ 系统路径。

**验证**：exe 的导入表里不应再有 `WebView2Loader.dll`（用 `objdump -p exe | Select-String 'DLL Name'` 确认）。

### 6.2 启动竞态「state not managed」（黑屏的根因之一）

**问题**：前端 JS 在 Rust `setup()` 还没来得及 `app.manage(AppState)` 之前就发了第一次 IPC 调用，后端报：

```
state not managed for field `state` on command `get_settings`.
You must call `.manage()` before using this command
```

表现为：首次启动黑屏/无反应（侧栏和内容都是空的），刷新或重启后正常，**时好时坏**。

**解决**：`app.js` 的 `tauriInvoke()` 对「state not managed」错误做**带退避的重试**（最多 30 次，100ms 起步）。这是最小且稳健的修复，不要删掉。

### 6.3 黑屏问题的历史

Tauri 在 Windows 上出现过多种「黑屏」表现，历史上踩过的坑：

1. **透明窗口黑屏**：透明窗口在 Windows 上可能黑屏。`boundary-preview` 窗口是透明的，务必保持 `visible(false)` 隐藏；主窗口**不要设 transparent**。
2. **close-to-exit 方式**：用 `.on_window_event(CloseRequested => exit)` 会导致黑屏，已改为 `.run()` 回调里监听 `WindowEvent::Destroyed` 来退出。**不要改回**。
3. **预览窗口懒创建**：曾把 `boundary-preview` 改成懒创建，结果预览框失效。保持它在 `setup` 里创建（隐藏）。
4. **启动竞态**（6.2）：前端过早调用命令导致内容空 → 表现为黑屏。

### 6.4 老板模式（Boss Mode）

- 触发：鼠标 `mouseleave` 且老板模式开启且正在播放 → 每 100ms 轮询 `cursor_near_window`，鼠标离开窗口外扩 `bossMargin` 的范围且超过 `bossDelayMs` → 暂停 + `hide_window()`（进托盘）。
- 托盘点击 / 鼠标 `mouseenter` 恢复播放。
- **`cursor_position()` 返回的是全局屏幕坐标**，必须减去 `window.inner_position()` 才是窗口相对坐标（历史 bug：没减导致边界判断失效）。
- **JS 里 `settings.bossMargin ?? 80` / `settings.bossDelayMs ?? 450` 必须用 `??` 不能用 `||`**：`0` 是合法值（延迟可设为 0ms），`||` 会把 0 当假值回退成默认值（历史 bug）。
- `boundary-preview` 是显示在窗口外的虚线黄框，用于调节边界时预览。

### 6.5 其它前端坑

- **空格键**：在**捕获阶段** `keydown` 里处理并 `e.stopPropagation()`，否则会双触发（历史 bug：一次按键暂停又立即播放）。
- **画中画**：用原生 `videoElement.requestPictureInPicture()`，不支持时捕获异常提示。
- **断点续播**：`positionMs` / `durationMs` 传给 Rust 前要 `Math.round()`（Rust 端是 i64，浮点会报 `invalid type: floating point ... expected i64`）。

### 6.6 设置序列化

- Rust `Settings` 用了 `#[serde(rename_all = "camelCase", default)]`，前端/磁盘 JSON 用 camelCase；`set_settings` 的参数名是 `value`。
- 新增设置字段必须给 `Default`，否则旧 `settings.json` 反序列化会失败（被 `unwrap_or_default()` 兜底为全默认，丢已有设置）。

### 6.7 性能

- `site_client.rs` 所有正则用 `once_cell::sync::Lazy` 预编译（`Regex::new` 每调用一次会拖慢 1.4–3s）。
- 目录结果在 `AppState.catalog_cache` 里缓存 5 分钟（TTL），切分区秒开。

### 6.8 网络 / 代理

- 本机 GitHub/npm/NSIS 下载可能不通，需要代理 `http://127.0.0.1:7078`（MonoCloud，**可能随时不在线**）。`npx tauri build` 下载 NSIS 时要设 `HTTP_PROXY/HTTPS_PROXY`；若代理拒绝连接就**去掉代理直连**试试（`gh` 上传时直连即可）。
- Rust 后端 reqwest 直连 `yfvod.com` / `sm-api.wieuc.com`，不走系统代理。

### 6.9 Windows 沙箱/工具限制（本 agent 环境）

- PowerShell 在只读模式下是 ConstrainedLanguage，只能跑 core cmdlet；`pwsh` 每次调用是新进程，不保留状态（用 `workdir` 而不是 `cd`）。
- 程序捕获子进程 stdout 走管道会 EPERM；`stdio: 'inherit'` 可用。
- 验证窗口渲染用 **PrintWindow**（`CopyFromScreen` 不可靠，会抓错窗口）。

---

## 7. 版本与发布

### 7.1 版本号位置（三处要同步改）

1. `src-tauri/Cargo.toml` → `[package] version`
2. `src-tauri/tauri.conf.json` → `version`
3. `package.json` → `version`

`lib.rs` 的 `get_version` 返回 `CARGO_PKG_VERSION`（即 Cargo.toml 的版本）。

### 7.2 发布流程

```powershell
# 0. 改完三处版本号 + 改完代码
# 1. 完整打包（见 3.3）
# 2. 复制产物（可选，方便用户）
Copy-Item "src-tauri\target\x86_64-pc-windows-gnu\release\ziwen-player.exe" "C:\Users\13040\Desktop\Ziwen-Player-1.0.24.exe"
Copy-Item "...\bundle\nsis\Ziwen-Player_1.0.24_x64-setup.exe" "C:\Users\13040\Desktop\Ziwen-Player_1.0.24_x64-setup.exe"
# 3. 提交推送
git add -A && git commit -m "..." && git push origin main
# 4. 创建 Release 并上传（不需要代理）
gh release create v1.0.24 <exe> <setup> --repo chenziwenhaoshuai/Ziwen-Player-Desktop --title "Ziwen Player v1.0.24" --notes "..."
```

### 7.3 更新机制

应用内「GitHub 更新」检查 `chenziwenhaoshuai/Ziwen-Player-Desktop` 最新 Release，对比 `CARGO_PKG_VERSION` 后提示下载。资产命名约定：便携版 `Ziwen-Player-<版本>.exe`、安装包 `Ziwen-Player_<版本>_x64-setup.exe`。

---

## 8. 调试与验证方法

### 8.1 验证渲染（判断是否黑屏）

用 **PrintWindow** P/Invoke 抓主窗口（标题「子文播放器」）像素：深色主题背景下，正常渲染约 `dark≈60–70%`、有 20%+ 亮像素；**纯黑窗口 dark≈100%**。

### 8.2 诊断前端 JS（判断是否加载/报错）

给 WebView2 开远程调试端口：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
Start-Process ".\ziwen-player.exe"
```

然后通过 CDP（`http://127.0.0.1:9222/json`）用 Node 连接 WebSocket 执行 `Runtime.evaluate` 检查 DOM（如 `#nav-rail` / `#content` 的 `children.length`），或 `Runtime.enable` + `Page.reload` 抓 `Runtime.exceptionThrown`。**这正是定位「黑屏」问题的方法**：空 DOM = JS 没跑/报错；DOM 有内容但仍黑 = 渲染/合成问题。

### 8.3 验证便携版自包含

把 `ziwen-player.exe` 单独拷到一个干净文件夹（无 DLL），启动后应能正常出画面，并自动在同目录释放出 `WebView2Loader.dll`。

---

## 9. 快速备忘（TL;DR）

- **编译**：`$env:PATH = "$env:USERPROFILE\.cargo\bin;C:\Users\13040\mingw64\mingw64\bin;$env:PATH"`，然后 `cargo build --release`（在 `src-tauri`）或 `npx tauri build`（在根目录，需代理）。
- **产物在** `src-tauri\target\x86_64-pc-windows-gnu\release\`。
- **永远用 GNU 工具链**，别碰 `rust-toolchain.toml` / `.cargo/config.toml` 的 gnu 设置。
- **别改回**：`vendor/webview2-com-sys`（自包含）、`tauriInvoke` 重试（启动竞态）、`.run()` 退出方式（黑屏）、预览窗口在 setup 创建（预览框失效）。
- **前端 `??` 别写成 `||`**（老板模式 0 值）。
- **改版本号三处同步**：Cargo.toml / tauri.conf.json / package.json。
