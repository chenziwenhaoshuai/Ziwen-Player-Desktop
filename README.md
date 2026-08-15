# 子文播放器 — Windows 桌面版

由 Android TV 版 [Ziwen-Player](https://github.com/chenziwenhaoshuai/Ziwen-Player) 移植而来的
Windows 桌面应用，使用 **Electron**（Node.js + Chromium）重写。

## 功能

- 爱壹帆（yfvod.com）首页 / 电影 / 连续剧 / 综艺 / 动漫 分类浏览
- 「你懂的」内测频道（peach API，Fernet 加密数据解密）
- 原生分类侧栏 + 海报网格、详情页 + 线路来源 + 剧集选择
- 关键词搜索
- m3u8 / mp4 / flv / webm 视频播放（m3u8 使用 hls.js + 本地代理解决跨域与 Referer）
- 网页播放器地址的 m3u8 捕获（隐藏 webview + 网络请求拦截）
- 最近观看、断点续播、提前缓冲设置、缓存清理
- 内测模式开关、GitHub / Gitee 更新检查

## 与原版的主要差异

| Android 版 | Windows 版 |
| --- | --- |
| Java + Android SDK | Node.js + Electron（Chromium） |
| ExoPlayer 播放 | HTML5 `<video>` + hls.js |
| WebView 捕获 m3u8 | `<webview>` + webRequest 拦截 |
| SharedPreferences | `userData/settings.json` |
| APK 下载安装更新 | 打开 GitHub/Gitee 下载页面 |

## 环境要求

- Windows 10 / 11
- [Node.js](https://nodejs.org/) 18 或更高版本（推荐 20+）

## 运行

```powershell
# 首次安装依赖（若已安装可跳过）
npm install

# 启动应用
npm start
```

> 首次 `npm install` 会从 GitHub 下载 Electron 运行时（约 100MB）。若网络受限，
> 可先配置代理后重试：
>
> ```powershell
> $env:HTTP_PROXY = "http://127.0.0.1:7078"
> $env:HTTPS_PROXY = "http://127.0.0.1:7078"
> npm install
> ```

## 使用说明

- 左侧侧栏切换分类；点击海报进入详情页
- 详情页选择「线路来源」和「剧集」后开始播放
- 键盘：`←` / `→` 快退/快进 10 秒，`空格` / `回车` 播放暂停，`Esc` / `退格` 返回
- 播放页点击返回会自动保存进度，再次进入该剧集时从上次位置续播

## 打包为单文件 exe

```powershell
npm run dist
```

生成位置：`dist\Ziwen-Player-1.0.22.exe`（便携版，单文件，约 70 MB，双击即用）。

> **Windows 符号链接权限问题**：首次打包时 electron-builder 解压 `winCodeSign` 工具包会因
> 无法创建符号链接而报错 `Cannot create symbolic link`（需要管理员权限或开发者模式）。
> 若遇到此问题，可先用 7-Zip 的 `-snl-` 参数手动解压该包到
> `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\`，再重新执行打包。
> 应用图标可用 `node build-icon.js` 生成（输出 `build/icon.ico`）。

## 项目结构

```
main.js                Electron 主进程（窗口、IPC、设置、更新、视频/图片代理、m3u8 捕获）
preload.js             contextBridge 暴露给渲染进程的 API
lib/
  http.js              允许信任任意 TLS 的 HTTP 客户端（对应原版 trustAll SSL）
  fernet.js            Fernet 解密（AES-128-CBC + HMAC-SHA256）
  site-client.js       爱壹帆 HTML 解析 + peach API（由原版 SiteClient 逐段移植）
renderer/
  index.html           界面外壳
  styles.css           深色主题样式
  app.js               界面与播放逻辑（由 MainActivity 逐段移植）
  vendor/hls.min.js    hls.js（m3u8 播放）
  assets/donation_qr.png
test.js                核心抓取/解密逻辑冒烟测试（node test.js）
src_tmp/               原 Android 版源码（移植参考）
```

## 声明

本软件仅供开源学习交流，请勿用于侵权行为，作者不负任何责任。
