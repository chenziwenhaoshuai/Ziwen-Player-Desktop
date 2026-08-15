# 子文播放器 — Windows 桌面版（Tauri）

由 Android TV 版 [Ziwen-Player](https://github.com/chenziwenhaoshuai/Ziwen-Player) 移植而来的
Windows 桌面应用，使用 **Tauri 2**（Rust + 系统 WebView2）重写，相比早期 Electron 版大幅瘦身。

## 功能

- 爱壹帆（yfvod.com）首页 / 电影 / 连续剧 / 综艺 / 动漫 分类浏览
- 「你懂的」内测频道（peach API，Fernet 加密数据解密）
- 原生分类侧栏 + 海报网格（渐进式加载）、详情页 + 线路来源 + 剧集选择
- 关键词搜索
- m3u8 / mp4 / flv / webm 视频播放（hls.js + 本地代理解决跨域与 Referer）
- 最近观看、断点续播、提前缓冲设置
- 可自定义缓存目录（默认 1GB LRU 磁盘缓存）+ 缓存清理
- 内测模式开关、GitHub / Gitee 更新检查
- 目录结果内存缓存（5 分钟），切分区秒开

## 体积对比

| | Electron 版 | Tauri 版 |
| --- | --- | --- |
| 应用 exe | ~70 MB | **~12.7 MB** |
| 安装包 | — | **~3.6 MB**（NSIS） |

Tauri 不再打包整套 Chromium，而是使用 Windows 10/11 自带的 WebView2 运行时。

## 环境要求

- Windows 10 / 11（自带 WebView2）
- [Rust](https://rustup.rs/)（Windows 上使用 GNU 工具链）
- mingw-w64（GNU 工具链需要 binutils，例如 `dlltool.exe`）
- [Node.js](https://nodejs.org/)（用于安装 Tauri CLI）

### 工具链安装（Windows 无管理员）

```powershell
# 1. 安装 Rust GNU 工具链
rustup default stable-x86_64-pc-windows-gnu

# 2. 下载 winlibs mingw-w64（含 dlltool/ld/gcc），解压后把 bin 目录加入 PATH
#    例如解压到 C:\mingw64，然后：
#    $env:PATH = "C:\mingw64\bin;$env:PATH"

# 3. 安装依赖
npm install
```

> 注意：`rustup` 自带的 `rust-mingw` 组件不含 `dlltool.exe`，链接部分依赖时会报
> `error calling dlltool 'dlltool.exe': program not found`，所以需要单独装 mingw-w64。

## 构建

```powershell
# 确保 cargo 和 mingw 都在 PATH 里
$env:PATH = "$env:USERPROFILE\.cargo\bin;C:\mingw64\bin;$env:PATH"

npx tauri build
```

构建产物：

```text
src-tauri\target\release\ziwen-player.exe                     # 便携版（双击即用）
src-tauri\target\release\bundle\nsis\Ziwen-Player_1.0.22_x64-setup.exe  # 安装包
```

## 开发运行

```powershell
npx tauri dev
```

## 项目结构

```
src-tauri/
  src/
    main.rs              程序入口
    lib.rs               Tauri 命令 + 状态（设置、缓存、更新检查）
    site_client.rs       爱壹帆 HTML 解析 + peach API（Fernet 解密）
    fernet.rs            Fernet 解密（AES-128-CBC + HMAC-SHA256）
    http_client.rs       信任任意 TLS 的 HTTP 客户端
    proxy.rs             本地视频/图片代理（m3u8 重写 + CORS + 加密图片）
    cache.rs             1GB LRU 磁盘缓存
  tauri.conf.json        应用配置
  capabilities/          权限配置
  icons/                 应用图标
src/
  index.html             界面外壳
  styles.css             深色主题样式
  app.js                 界面与播放逻辑
  vendor/hls.min.js      hls.js（m3u8 播放）
  assets/donation_qr.png
generate-icons.js        图标生成脚本
download-mingw.js        mingw-w64 下载脚本（首次搭环境用）
```

## 更新机制

应用内的「GitHub 更新」检查 `chenziwenhaoshuai/Ziwen-Player-Desktop` 的最新 Release，
对比版本号后提示下载。发新版时：

```powershell
# 1. 修改 src-tauri/tauri.conf.json 和 src-tauri/Cargo.toml 里的 version
# 2. 重新构建
npx tauri build
# 3. 创建 Release 并上传资产
gh release create vX.Y.Z <exe路径> --repo chenziwenhaoshuai/Ziwen-Player-Desktop
```

## 声明

本软件仅供开源学习交流，请勿用于侵权行为，作者不负任何责任。
