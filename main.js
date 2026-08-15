'use strict';

/**
 * 子文播放器 — Windows 桌面版 (Electron 主进程)
 *
 * 职责：
 *  1. 创建主窗口并加载 renderer 界面
 *  2. 通过 IPC 提供站点抓取（爱壹帆 + peach API）、设置持久化、更新检查
 *  3. 本地视频/图片代理：为 m3u8、分段、加密图片提供跨域与 Referer 支持
 *  4. 监听 resolver 分区的网络请求，捕获 m3u8 播放地址
 */

const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

const { SiteClient } = require('./lib/site-client');
const { request } = require('./lib/http');
const { fernetDecrypt } = require('./lib/fernet');
const {
  GITHUB_UPDATE_API_URL,
  GITEE_UPDATE_API_URL,
  fetchLatestUpdate,
  compareVersionNames,
  PEACH_FERNET_KEY,
} = require('./lib/site-client');

const APP_VERSION = app.getVersion();
const RESOLVER_PARTITION = 'persist:resolver';

// ---- Settings persistence ---------------------------------------------------
const DEFAULT_SETTINGS = {
  preloadMinutes: 3,
  betaMode: true,
  autoUpdateCheck: false,
  lastAutoUpdateCheck: 0,
  recentWatches: [],
};

let settings = null;
let mainWindow = null;
let proxyServer = null;
let proxyBase = '';

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    settings = { ...DEFAULT_SETTINGS, ...parsed };
    if (!Array.isArray(settings.recentWatches)) settings.recentWatches = [];
  } catch (e) {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {
    // ignore persistence failures
  }
}

// ---- Video / image proxy ----------------------------------------------------
// The renderer is loaded from a file:// (or app://) origin. Browser-side HLS
// (hls.js) and <video>/<img> need CORS + the correct Referer, which many of
// these streaming hosts require. This local proxy forwards those requests in
// Node (trust-all TLS, custom Referer) and rewrites m3u8 manifests so every
// segment is also routed through the proxy.

function absolutizeUri(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).toString();
  } catch (e) {
    return uri;
  }
}

function proxyUrlFor(url, referer) {
  return (
    proxyBase +
    '/proxy?url=' +
    encodeURIComponent(url) +
    '&referer=' +
    encodeURIComponent(referer || '')
  );
}

function looksLikeM3u8(url, body) {
  if (/\.m3u8($|\?)/i.test(url)) return true;
  const head = body.toString('utf8', 0, 256).trimStart();
  return head.startsWith('#EXTM3U');
}

function rewriteM3u8(text, baseUrl) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        // Rewrite AES-128 key URIs too.
        const key = trimmed.match(/^(#EXT-X-KEY:.*URI=")([^"]+)(".*)$/i);
        if (key) {
          const abs = absolutizeUri(key[2], baseUrl);
          return key[1] + proxyUrlFor(abs, baseUrl) + key[3];
        }
        return line;
      }
      const abs = absolutizeUri(trimmed, baseUrl);
      return proxyUrlFor(abs, baseUrl);
    })
    .join('\n');
}

function decodeEncryptedImage(text) {
  let dataUrl;
  const split = text.indexOf('@@@');
  if (split >= 0) {
    dataUrl = fernetDecrypt(text.slice(0, split), PEACH_FERNET_KEY) + text.slice(split + 3);
  } else {
    dataUrl = fernetDecrypt(text.trim(), PEACH_FERNET_KEY);
  }
  if (!dataUrl.startsWith('data:')) {
    dataUrl = 'data:image/jpeg;base64,' + dataUrl;
  }
  const comma = dataUrl.indexOf(',');
  let mime = dataUrl.slice(5, comma).split(';')[0] || 'image/jpeg';
  if (mime === 'image/jpg') mime = 'image/jpeg';
  const payload = dataUrl.slice(comma + 1).trim();
  return { mime, buffer: Buffer.from(payload, 'base64') };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

// CORS headers must be written BEFORE writeHead, otherwise they are dropped.
function withCors(headers) {
  return Object.assign({}, CORS_HEADERS, headers);
}

async function handleProxy(req, res) {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  const url = parsed.searchParams.get('url') || '';
  const referer = parsed.searchParams.get('referer') || '';

  if (!url) {
    res.writeHead(400);
    res.end('missing url');
    return;
  }

  try {
    const upstreamHeaders = {};
    if (req.headers.range) upstreamHeaders.Range = req.headers.range;
    const upstream = await request(url, {
      referer,
      headers: upstreamHeaders,
    });

    // Encrypted peach image (served as a Fernet token).
    if (/\.image($|\?)/i.test(url)) {
      const decoded = decodeEncryptedImage(upstream.body.toString('utf8'));
      res.writeHead(
        200,
        withCors({
          'Content-Type': decoded.mime,
          'Content-Length': decoded.buffer.length,
        })
      );
      res.end(decoded.buffer);
      return;
    }

    if (looksLikeM3u8(url, upstream.body)) {
      const rewritten = rewriteM3u8(upstream.body.toString('utf8'), url);
      res.writeHead(
        200,
        withCors({ 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8' })
      );
      res.end(rewritten);
      return;
    }

    // Binary passthrough (video segment, mp4, flv, webm, normal image).
    const status = upstream.statusCode === 206 ? 206 : 200;
    const headers = {
      'Content-Type': upstream.headers['content-type'] || 'application/octet-stream',
      'Content-Length': upstream.body.length,
    };
    if (upstream.statusCode === 206 && upstream.headers['content-range']) {
      headers['Content-Range'] = upstream.headers['content-range'];
      headers['Accept-Ranges'] = 'bytes';
    } else if (upstream.headers['accept-ranges']) {
      headers['Accept-Ranges'] = upstream.headers['accept-ranges'];
    }
    res.writeHead(status, withCors(headers));
    res.end(upstream.body);
  } catch (e) {
    res.writeHead(502, withCors({ 'Content-Type': 'text/plain; charset=utf-8' }));
    res.end('proxy error: ' + (e && e.message ? e.message : String(e)));
  }
}

function startProxy() {
  return new Promise((resolve) => {
    proxyServer = http.createServer((req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/proxy')) {
        handleProxy(req, res);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    proxyServer.listen(0, '127.0.0.1', () => {
      const port = proxyServer.address().port;
      proxyBase = 'http://127.0.0.1:' + port;
      resolve(proxyBase);
    });
  });
}

// ---- Window ----------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 780,
    minWidth: 960,
    minHeight: 600,
    title: '子文播放器',
    backgroundColor: '#101318',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---- IPC handlers ----------------------------------------------------------
const siteClient = new SiteClient();

function registerIpc() {
  ipcMain.handle('catalog:fetch', async (_evt, pathName) => {
    return siteClient.fetchCatalog(pathName);
  });

  ipcMain.handle('detail:fetch', async (_evt, item) => {
    return siteClient.fetchDetail(item);
  });

  ipcMain.handle('play:resolve', async (_evt, episode) => {
    return siteClient.resolvePlayTarget(episode);
  });

  ipcMain.handle('settings:get', () => {
    return settings;
  });

  ipcMain.handle('settings:set', (_evt, partial) => {
    if (partial && typeof partial === 'object') {
      settings = { ...settings, ...partial };
      saveSettings();
    }
    return settings;
  });

  ipcMain.handle('settings:recent-save', (_evt, item) => {
    if (!item || !item.url) return settings.recentWatches;
    const list = settings.recentWatches.filter((w) => w && w.url !== item.url);
    list.unshift(item);
    if (list.length > 40) list.length = 40;
    settings.recentWatches = list;
    saveSettings();
    return list;
  });

  ipcMain.handle('settings:recent-clear', () => {
    settings.recentWatches = [];
    saveSettings();
    return [];
  });

  ipcMain.handle('app:version', () => APP_VERSION);

  ipcMain.handle('proxy:base', () => proxyBase);

  ipcMain.handle('update:check', async (_evt, source) => {
    const apiUrl = source === 'gitee' ? GITEE_UPDATE_API_URL : GITHUB_UPDATE_API_URL;
    const displayName = source === 'gitee' ? 'Gitee' : 'GitHub';
    const info = await fetchLatestUpdate(apiUrl, displayName);
    info.hasNewerVersion = compareVersionNames(info.versionName, APP_VERSION) > 0;
    info.currentVersion = APP_VERSION;
    return info;
  });

  ipcMain.handle('cache:clear', async () => {
    await session.defaultSession.clearCache();
    return true;
  });

  ipcMain.handle('shell:open-external', (_evt, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return true;
  });
}

// ---- m3u8 capture (resolver partition) -------------------------------------
function registerResolverCapture() {
  const resolverSession = session.fromPartition(RESOLVER_PARTITION);
  resolverSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url || '';
    if (url.includes('.m3u8') && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('m3u8:captured', { url, source: 'WebView 请求' });
    }
    callback({});
  });
  // Present a desktop Chrome UA so sites serve their HTML5 player.
  const desktopUa =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 ZiwenPlayer/1.0';
  resolverSession.setUserAgent(desktopUa);
}

// ---- App lifecycle ---------------------------------------------------------
app.whenReady().then(async () => {
  loadSettings();
  registerIpc();
  registerResolverCapture();
  await startProxy();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (proxyServer) {
    try {
      proxyServer.close();
    } catch (e) {
      // ignore
    }
  }
});
