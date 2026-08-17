'use strict';

/* =========================================================================
 * 子文播放器 — Windows 桌面版渲染进程
 * 逻辑由 Android 版 MainActivity.java 逐段移植。
 * (Tauri 版：通过 window.__TAURI__.core.invoke 调用 Rust 后端)
 * ========================================================================= */

// ---- Tauri IPC bridge (replaces Electron's window.api) ---------------------
async function tauriInvoke(cmd, args) {
  if (!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)) {
    throw new Error('Tauri runtime not available');
  }

  // The very first IPC calls can race with Rust's `setup()`: the frontend may
  // run before `app.manage(AppState)` completes, so commands like `get_settings`
  // reject with "state not managed ...". Retry briefly rather than failing.
  const invoke = window.__TAURI__.core.invoke.bind(window.__TAURI__.core);
  let lastErr;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      return await invoke(cmd, args);
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      if (/state not managed/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 100 + attempt * 50));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

const api = {
  fetchCatalog: (path) => tauriInvoke('fetch_catalog', { path }),
  fetchDetail: (item) => tauriInvoke('fetch_detail', { item }),
  resolvePlayTarget: (episode) => tauriInvoke('resolve_play', { episode }),
  getSettings: () => tauriInvoke('get_settings'),
  setSettings: (newSettings) => tauriInvoke('set_settings', { value: newSettings }),
  saveRecentWatch: (item) => tauriInvoke('save_recent_watch', { item }),
  clearRecentWatches: () => tauriInvoke('clear_recent_watches'),
  clearCache: () => tauriInvoke('clear_cache'),
  getCacheInfo: () => tauriInvoke('get_cache_info'),
  getVersion: () => tauriInvoke('get_version'),
  getProxyBase: () => tauriInvoke('get_proxy_base'),
  checkUpdate: (source) => tauriInvoke('check_update', { source }),
  openExternal: (url) => tauriInvoke('open_external', { url }),
  hideWindow: () => tauriInvoke('hide_window'),
  showWindow: () => tauriInvoke('show_window'),
  cursorNearWindow: (margin) => tauriInvoke('cursor_near_window', { margin }),
  previewBoundary: (margin) => tauriInvoke('preview_boundary', { margin }),
  hideBoundaryPreview: () => tauriInvoke('hide_boundary_preview'),
};

async function persistSettings(partial) {
  Object.assign(settings, partial);
  settings = await api.setSettings(settings);
}

// ---- Constants (mirror MainActivity) --------------------------------------
const BASE_URL = 'https://www.yfvod.com';
const MOVIE_TIME_PATH = '/vod-show/1--time---------.html';
const TV_SHOW_PATH = '/vod-show/2--time---------.html';
const VARIETY_SHOW_PATH = '/vod-show/3--time---------.html';
const ANIMATION_SHOW_PATH = '/vod-show/4--time---------.html';
const PEACH_PATH = 'peach://catalog';
const PEACH_RANDOM_PAGE_MAX = 30;

const RECENT_WATCH_LIMIT = 40;
const SEEK_STEP_MS = 10000;
const RESUME_MIN_POSITION_MS = 10000;
const WATCH_FINISHED_THRESHOLD_MS = 30000;
const PROGRESS_SAVE_INTERVAL_MS = 15000;

const CATEGORIES = [
  { name: '首页', path: '/' },
  { name: '电影', path: MOVIE_TIME_PATH },
  { name: '连续剧', path: TV_SHOW_PATH },
  { name: '综艺', path: VARIETY_SHOW_PATH },
  { name: '动漫', path: ANIMATION_SHOW_PATH },
  { name: '你懂的', path: PEACH_PATH },
];

const PRELOAD_MINUTE_OPTIONS = [1, 2, 3, 5, 8];
const DEFAULT_PRELOAD_MINUTES = 3;

// ---- State -----------------------------------------------------------------
let screen = 'catalog'; // catalog | detail | search | settings | player
let currentTitle = '首页';
let currentPath = '/';
let currentVideo = null;

let catalogPage = 1;
let catalogHasMore = false;
let catalogPagedMode = false;
let catalogPagingKindValue = '';
let catalogLoadingMore = false;
let catalogSelectedIndex = 0;
let catalogItems = [];
let catalogRenderTimer = null;

let currentDetailEpisodes = [];
let currentSources = [];
let activeSourcePosition = 0;
let episodeSelectedIndex = 0;

let pendingEpisode = null;
let pendingResumePositionMs = 0;

let settings = {
  preloadMinutes: DEFAULT_PRELOAD_MINUTES,
  betaMode: true,
  autoUpdateCheck: false,
  lastAutoUpdateCheck: 0,
  recentWatches: [],
};

let proxyBase = '';
let hls = null;
let videoElement = null;
let progressSaverTimer = null;
let topbarHideTimer = null;
let bossMode = false;
let bossPaused = false;
let bossModeListenersSetup = false;
let bossModeCheckTimer = null;
let bossMarginPreviewTimer = null;
let bossAwaySince = 0;

// ---- DOM shortcuts ---------------------------------------------------------
const navRailEl = document.getElementById('nav-rail');
const contentEl = document.getElementById('content');
const loadingEl = document.getElementById('loading');
const toastEl = document.getElementById('toast');

// ---- Small helpers ---------------------------------------------------------
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function absolutize(p) {
  if (!p) return BASE_URL + '/';
  if (/^https?:\/\//i.test(p)) return p;
  return BASE_URL + (p.startsWith('/') ? p : '/' + p);
}

function imageSrc(url) {
  const abs = absolutize(url);
  if (!abs) return '';
  if (abs.startsWith('data:')) return abs;
  // Encrypted images and peach hosts go through the local proxy so the
  // correct Referer / Fernet decode is applied (mirrors Android ImageLoader).
  if (abs.includes('.image')) return proxyUrl(abs);
  if (/hm-img\.twmjjy\.com|hm-vip\.twmjjy\.com|aa66cc\.live/i.test(abs)) {
    return proxyUrl(abs, BASE_URL + '/');
  }
  return abs;
}

function proxyUrl(url, referer) {
  return (
    proxyBase +
    '/proxy?url=' +
    encodeURIComponent(url) +
    '&referer=' +
    encodeURIComponent(referer || '')
  );
}

function formatTime(positionMs) {
  const totalSeconds = Math.max(0, Math.floor(positionMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? hours + ':' + mm + ':' + ss : mm + ':' + ss;
}

function normalizedRecentPosition(positionMs, durationMs) {
  let position = Math.max(0, positionMs);
  if (durationMs > 0) {
    position = Math.min(position, durationMs);
    if (durationMs - position <= WATCH_FINISHED_THRESHOLD_MS) return 0;
  }
  return position < RESUME_MIN_POSITION_MS ? 0 : position;
}

function isPreferredNativeSource(from) {
  if (!from) return false;
  return (
    from.includes('m3u8') ||
    from === 'wolong' ||
    from === '360zy' ||
    from === 'kuaikan' ||
    from === 'leshi' ||
    from === 'hw8' ||
    from === 'haiwaikan' ||
    from === 'dplayer'
  );
}

function episodePriority(ep) {
  const from = ep.from || '';
  if (isPreferredNativeSource(from)) return 0;
  if (
    from.includes('m3u8') ||
    from === 'wolong' ||
    from === '360zy' ||
    from === 'dplayer' ||
    from === 'haiwaikan'
  ) {
    return 1;
  }
  return 5;
}

function episodeSourcePriority(ep) {
  const from = ep.from || '';
  if (from) return episodePriority(ep);
  const name = ep.sourceName || '';
  if (name.includes('国际') || name.includes('亚太') || name.includes('备用') || name.includes('海外')) {
    return 0;
  }
  if (name.includes('高清')) return 5;
  return 2;
}

function episodeSourceLabel(ep) {
  if (ep.sourceName) return ep.sourceName;
  if (ep.from) return episodePriority(ep) <= 1 ? 'm3u8' : ep.from;
  return '线路' + ep.source;
}

function sourceGroupPriority(title) {
  if (
    title.includes('国际') ||
    title.includes('亚太') ||
    title.includes('备用') ||
    title.includes('海外') ||
    title.includes('m3u8')
  ) {
    return 0;
  }
  if (title.includes('高清')) return 5;
  return 2;
}

function catalogPagingKind(path) {
  if (path === MOVIE_TIME_PATH) return 'movie';
  if (path === TV_SHOW_PATH) return '2';
  if (path === VARIETY_SHOW_PATH) return '3';
  if (path === ANIMATION_SHOW_PATH) return '4';
  if (path === PEACH_PATH) return 'peach';
  return '';
}

function pagedCatalogPath(kind, page) {
  if (kind === 'peach') return PEACH_PATH + '?page=' + page;
  const id = kind === 'movie' ? '1' : kind;
  if (page <= 1) {
    if (kind === 'movie') return MOVIE_TIME_PATH;
    if (kind === '2') return TV_SHOW_PATH;
    if (kind === '3') return VARIETY_SHOW_PATH;
    if (kind === '4') return ANIMATION_SHOW_PATH;
  }
  return '/vod-show/' + id + '--time------' + page + '---.html';
}

function displayMeta(item) {
  if (item.episodeIndex > 0) {
    let s = item.episodeTitle || '第' + item.episodeIndex + '集';
    if (item.positionMs > 0) s += '  ' + formatTime(item.positionMs);
    if (item.remarks) s += '  ' + item.remarks;
    return s;
  }
  return item.remarks || '';
}

function visibleCategories() {
  return CATEGORIES.filter((c) => c.path !== PEACH_PATH || settings.betaMode);
}

// ---- Overlays --------------------------------------------------------------
let toastTimer = null;
function showLoading(message) {
  loadingEl.classList.remove('hidden');
  if (message) showHint(message);
}
function hideLoading(message) {
  loadingEl.classList.add('hidden');
  if (message) showHint(message);
}

function showHint(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2200);
}

// ---- Navigation rail -------------------------------------------------------
function renderNav(activeKey) {
  const cats = visibleCategories();
  let html = '<div class="brand">子文播放器</div><div class="nav-scroll">';
  html += navItemHtml('search', '⌕  搜索', activeKey === 'search');
  for (const c of cats) {
    html += navItemHtml('cat:' + c.path, c.name, activeKey === 'cat:' + c.path);
    if (c.path === '/') {
      html += navItemHtml('recent', '最近观看', activeKey === 'recent');
    }
  }
  html += navItemHtml('settings', '设置', activeKey === 'settings');
  html += '</div>';
  html +=
    '<div class="donation">' +
    '<div class="donation-tip">如果喜欢请支付宝扫一扫赞助我</div>' +
    '<img class="donation-qr" src="assets/donation_qr.png" alt="赞助二维码" />' +
    '</div>';
  navRailEl.innerHTML = html;

  navRailEl.querySelectorAll('.nav-item').forEach((el) => {
    el.addEventListener('click', () => handleNav(el.dataset.key));
  });
}

function navItemHtml(key, label, active) {
  return (
    '<div class="nav-item' +
    (active ? ' active' : '') +
    '" data-key="' +
    escapeHtml(key) +
    '">' +
    escapeHtml(label) +
    '</div>'
  );
}

function handleNav(key) {
  if (key === 'search') return showSearch('');
  if (key === 'recent') return showRecentWatches();
  if (key === 'settings') return showSettings();
  if (key.startsWith('cat:')) {
    const path = key.slice(4);
    const cat = CATEGORIES.find((c) => c.path === path);
    return showCatalog(cat ? cat.name : '首页', path);
  }
}

// ---- Catalog screen --------------------------------------------------------
async function showCatalog(title, path) {
  if (path === PEACH_PATH && !settings.betaMode) {
    return showCatalog('首页', '/');
  }
  screen = 'catalog';
  currentTitle = title;
  currentPath = path;
  currentVideo = null;
  catalogSelectedIndex = 0;

  renderNav('cat:' + path);

  let headerExtra = '';
  if (path === PEACH_PATH) {
    headerExtra = '<button id="peach-refresh" class="btn">随机换一批</button>';
  }
  contentEl.innerHTML =
    '<div class="header"><span>' +
    escapeHtml(title) +
    '</span><span style="flex:1"></span>' +
    headerExtra +
    '</div>' +
    '<div id="grid-scroll" class="grid-scroll"><div id="grid" class="grid"></div></div>';

  if (path === PEACH_PATH) {
    document.getElementById('peach-refresh').addEventListener('click', refreshPeachCatalogRandomly);
  }
  const gridScroll = document.getElementById('grid-scroll');
  gridScroll.addEventListener('scroll', () => {
    if (gridScroll.scrollTop + gridScroll.clientHeight >= gridScroll.scrollHeight - 400) {
      loadMoreCatalogIfNeeded();
    }
  });

  await loadCatalog(title, path);
}

async function loadCatalog(title, path) {
  catalogPage = 1;
  catalogLoadingMore = false;
  catalogPagingKindValue = catalogPagingKind(path);
  catalogPagedMode = catalogPagingKindValue !== '';
  catalogHasMore = catalogPagedMode;
  showLoading('正在加载' + title + '...');
  try {
    const videos = await api.fetchCatalog(path);
    catalogItems = videos;
    renderCatalogGrid(videos);
    hideLoading(videos.length === 0 ? '没有解析到影片' : '');
  } catch (e) {
    hideLoading('加载失败：' + (e && e.message ? e.message : e));
  }
}

function createCard(item, i) {
  const card = document.createElement('div');
  card.className = 'card' + (i === catalogSelectedIndex ? ' selected' : '');
  card.dataset.index = i;
  card.innerHTML =
    '<img class="card-poster" loading="lazy" src="' +
    escapeHtml(imageSrc(item.poster)) +
    '" alt="" />' +
    '<div class="card-title">' +
    escapeHtml(item.title) +
    '</div>' +
    '<div class="card-meta">' +
    escapeHtml(item.remarks || '') +
    '</div>';
  card.addEventListener('click', () => {
    const idx = parseInt(card.dataset.index, 10);
    catalogSelectedIndex = idx;
    highlightGridSelection();
    const item = catalogItems[idx];
    if (item) loadDetail(item);
  });
  return card;
}

function renderCatalogGrid(videos) {
  const grid = document.getElementById('grid');
  if (!grid) return;
  clearTimeout(catalogRenderTimer);
  if (videos.length === 0) {
    grid.innerHTML = '<div style="color:var(--muted);padding:24px">暂无内容</div>';
    return;
  }
  grid.innerHTML = '';
  let index = 0;
  const batch = 6;
  const step = () => {
    const end = Math.min(index + batch, videos.length);
    for (let i = index; i < end; i++) {
      grid.appendChild(createCard(videos[i], i));
    }
    index = end;
    if (index < videos.length) {
      catalogRenderTimer = setTimeout(step, 35);
    }
  };
  step();
}

function appendCatalogItems(newItems) {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const baseIndex = catalogItems.length - newItems.length;
  for (let i = 0; i < newItems.length; i++) {
    grid.appendChild(createCard(newItems[i], baseIndex + i));
  }
}

function highlightGridSelection() {
  document.querySelectorAll('#grid .card').forEach((card) => {
    card.classList.toggle('selected', parseInt(card.dataset.index, 10) === catalogSelectedIndex);
  });
  const selected = document.querySelector('#grid .card.selected');
  if (selected && selected.scrollIntoView) {
    selected.scrollIntoView({ block: 'nearest' });
  }
}

async function loadMoreCatalogIfNeeded() {
  if (!catalogPagedMode || catalogLoadingMore || !catalogHasMore) return;
  catalogLoadingMore = true;
  const nextPage = catalogPage + 1;
  const nextPath = pagedCatalogPath(catalogPagingKindValue, nextPage);
  showLoading('正在加载更多...');
  try {
    const videos = await api.fetchCatalog(nextPath);
    catalogLoadingMore = false;
    hideLoading(videos.length === 0 ? '没有更多内容了' : '');
    if (videos.length === 0) {
      catalogHasMore = false;
      return;
    }
    catalogPage = nextPage;
    // merge/dedupe by url
    const newItems = [];
    const seen = new Set(catalogItems.map((v) => v.url));
    for (const v of videos) {
      if (!seen.has(v.url)) {
        seen.add(v.url);
        catalogItems.push(v);
        newItems.push(v);
      }
    }
    appendCatalogItems(newItems);
  } catch (e) {
    catalogLoadingMore = false;
    hideLoading('加载更多失败：' + (e && e.message ? e.message : e));
  }
}

async function refreshPeachCatalogRandomly() {
  if (currentPath !== PEACH_PATH || catalogLoadingMore) return;
  const page = 1 + Math.floor(Math.random() * PEACH_RANDOM_PAGE_MAX);
  catalogLoadingMore = true;
  catalogSelectedIndex = 0;
  showLoading('正在随机换一批...');
  try {
    const videos = await api.fetchCatalog(pagedCatalogPath('peach', page));
    catalogLoadingMore = false;
    hideLoading(videos.length === 0 ? '这一批没有内容' : '');
    if (videos.length === 0) return;
    catalogPage = page;
    catalogHasMore = true;
    catalogItems = videos;
    renderCatalogGrid(videos);
  } catch (e) {
    catalogLoadingMore = false;
    hideLoading('随机刷新失败：' + (e && e.message ? e.message : e));
  }
}

// ---- Recent watches --------------------------------------------------------
async function showRecentWatches() {
  screen = 'catalog';
  currentTitle = '最近观看';
  currentPath = '/';
  currentVideo = null;
  catalogSelectedIndex = 0;
  catalogItems = [];

  renderNav('recent');
  contentEl.innerHTML =
    '<div class="header">最近观看</div>' +
    '<div id="grid-scroll" class="grid-scroll"><div id="grid" class="grid"></div></div>';

  const items = settings.recentWatches.filter((w) => !(w.provider === 'peach' && !settings.betaMode));
  catalogItems = items;
  renderCatalogGrid(items);
  if (items.length === 0) showHint('暂无最近观看');
}

// ---- Search ----------------------------------------------------------------
function showSearch(initialKeyword) {
  screen = 'search';
  currentTitle = '搜索';
  currentVideo = null;
  catalogSelectedIndex = 0;
  catalogItems = [];

  renderNav('search');
  contentEl.innerHTML =
    '<div class="header">搜索</div>' +
    '<div class="search-bar">' +
    '<input id="search-input" class="search-input" type="text" placeholder="输入片名、演员或关键词" value="' +
    escapeHtml(initialKeyword || '') +
    '" />' +
    '<button id="search-submit" class="btn primary">搜索</button>' +
    '</div>' +
    '<div id="grid-scroll" class="grid-scroll"><div id="grid" class="grid"></div></div>';

  const input = document.getElementById('search-input');
  document.getElementById('search-submit').addEventListener('click', () => performSearch(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') performSearch(input.value);
  });

  if (!initialKeyword) {
    input.focus();
    showHint('输入关键词后按搜索');
  } else {
    performSearch(initialKeyword);
  }
}

async function performSearch(keyword) {
  keyword = (keyword || '').trim();
  if (!keyword) {
    showHint('请输入搜索关键词');
    return;
  }
  const path = '/vod-search/' + encodeURIComponent(keyword) + '-------------.html';
  showLoading('正在搜索：' + keyword);
  try {
    const videos = await api.fetchCatalog(path);
    catalogItems = videos;
    renderCatalogGrid(videos);
    hideLoading(videos.length === 0 ? '没有搜索结果' : '');
  } catch (e) {
    hideLoading('搜索失败：' + (e && e.message ? e.message : e));
  }
}

// ---- Settings --------------------------------------------------------------
async function showSettings() {
  screen = 'settings';
  currentVideo = null;
  renderNav('settings');

  const version = await api.getVersion();
  contentEl.innerHTML =
    '<div class="header">设置</div>' +
    '<div class="settings-scroll">' +
    '<div class="info-box" id="preload-info">提前缓冲：' + settings.preloadMinutes + ' 分钟</div>' +
    '<div class="settings-row">' +
    '<button id="preload-dec" class="btn">减少</button>' +
    '<button id="preload-inc" class="btn">增加</button>' +
    '</div>' +
    '<div class="info-box" id="boss-margin-info">老板模式边界：' + (settings.bossMargin ?? 80) + 'px</div>' +
    '<div class="settings-row">' +
    '<button id="boss-margin-dec" class="btn">减少</button>' +
    '<button id="boss-margin-inc" class="btn">增加</button>' +
    '<button id="boss-margin-preview" class="btn">预览边界</button>' +
    '</div>' +
    '<div class="help-text">老板模式下，鼠标移出窗口这个范围才会暂停并隐藏。调整时会实时在窗口外显示黄色虚线边界框。</div>' +
    '<div class="info-box" id="boss-delay-info">老板模式隐藏延迟：' + Math.round(settings.bossDelayMs ?? 450) + 'ms</div>' +
    '<div class="settings-row">' +
    '<button id="boss-delay-dec" class="btn">减少</button>' +
    '<button id="boss-delay-inc" class="btn">增加</button>' +
    '</div>' +
    '<div class="help-text">老板模式下，鼠标离开边界后等待这段时间才暂停并隐藏。设长一点可以避免误触发。</div>' +
    '<div class="info-box" id="cache-info">视频缓存：加载中...</div>' +
    '<div class="help-text" id="cache-dir">缓存目录：加载中...</div>' +
    '<div class="settings-row">' +
    '<button id="cache-choose" class="btn">更改缓存目录</button>' +
    '<button id="cache-clear" class="btn">清理视频缓存</button>' +
    '</div>' +
    '<div style="height:14px"></div>' +
    '<button id="history-clear" class="btn">清除历史浏览记录</button>' +
    '<div style="height:14px"></div>' +
    '<button id="beta-toggle" class="btn">' +
    (settings.betaMode ? '内测模式：已开启' : '内测模式：未开启') +
    '</button>' +
    '<div style="height:14px"></div>' +
    '<div class="info-box">当前版本：' + escapeHtml(version) + '</div>' +
    '<div class="settings-row">' +
    '<button id="check-github" class="btn">GitHub 更新</button>' +
    '<button id="check-gitee" class="btn">Gitee 更新</button>' +
    '</div>' +
    '<button id="auto-update" class="btn">' +
    (settings.autoUpdateCheck ? '自动检查更新：已开启' : '自动检查更新：未开启') +
    '</button>' +
    '</div>';

  document.getElementById('preload-dec').addEventListener('click', () => changePreload(-1));
  document.getElementById('preload-inc').addEventListener('click', () => changePreload(1));
  document.getElementById('boss-margin-dec').addEventListener('click', () => changeBossMargin(-20));
  document.getElementById('boss-margin-inc').addEventListener('click', () => changeBossMargin(20));
  document.getElementById('boss-margin-preview').addEventListener('click', previewBossMargin);
  document.getElementById('boss-delay-dec').addEventListener('click', () => changeBossDelay(-150));
  document.getElementById('boss-delay-inc').addEventListener('click', () => changeBossDelay(150));
  document.getElementById('cache-clear').addEventListener('click', clearCache);
  document.getElementById('cache-choose').addEventListener('click', chooseCacheDir);
  document.getElementById('history-clear').addEventListener('click', clearHistory);
  document.getElementById('beta-toggle').addEventListener('click', toggleBetaMode);
  document.getElementById('check-github').addEventListener('click', () => checkUpdate('github'));
  document.getElementById('check-gitee').addEventListener('click', () => checkUpdate('gitee'));
  document.getElementById('auto-update').addEventListener('click', toggleAutoUpdate);

  updateCacheInfo();
}

function updatePreloadInfo() {
  const el = document.getElementById('preload-info');
  if (el) el.textContent = '提前缓冲：' + settings.preloadMinutes + ' 分钟';
}

async function changePreload(dir) {
  const cur = settings.preloadMinutes;
  let idx = PRELOAD_MINUTE_OPTIONS.indexOf(cur);
  if (idx < 0) idx = PRELOAD_MINUTE_OPTIONS.indexOf(DEFAULT_PRELOAD_MINUTES);
  const next = Math.max(0, Math.min(PRELOAD_MINUTE_OPTIONS.length - 1, idx + dir));
  settings.preloadMinutes = PRELOAD_MINUTE_OPTIONS[next];
  await persistSettings({ preloadMinutes: settings.preloadMinutes });
  updatePreloadInfo();
  showHint('提前缓冲已设为 ' + settings.preloadMinutes + ' 分钟');
}

function currentBossMargin() {
  return Math.round(settings.bossMargin ?? 80);
}

function updateBossMarginInfo() {
  const el = document.getElementById('boss-margin-info');
  if (el) el.textContent = '老板模式边界：' + currentBossMargin() + 'px';
}

function showBossMarginPreview() {
  const margin = currentBossMargin();
  api.previewBoundary(margin).catch(() => {});
  clearTimeout(bossMarginPreviewTimer);
  bossMarginPreviewTimer = setTimeout(() => {
    api.hideBoundaryPreview().catch(() => {});
  }, 2500);
}

async function changeBossMargin(dir) {
  const next = Math.max(20, Math.min(300, currentBossMargin() + dir));
  await persistSettings({ bossMargin: next });
  updateBossMarginInfo();
  showBossMarginPreview();
}

function previewBossMargin() {
  showBossMarginPreview();
}

function currentBossDelay() {
  return Math.round(settings.bossDelayMs ?? 450);
}

function updateBossDelayInfo() {
  const el = document.getElementById('boss-delay-info');
  if (el) el.textContent = '老板模式隐藏延迟：' + currentBossDelay() + 'ms';
}

async function changeBossDelay(dir) {
  const next = Math.max(0, Math.min(3000, currentBossDelay() + dir));
  await persistSettings({ bossDelayMs: next });
  updateBossDelayInfo();
}

async function clearCache() {
  showLoading('正在清理缓存...');
  try {
    const info = await api.clearCache();
    hideLoading('缓存已清理');
    applyCacheInfo(info);
  } catch (e) {
    hideLoading('清理缓存失败');
  }
}

function applyCacheInfo(info) {
  const infoEl = document.getElementById('cache-info');
  const dirEl = document.getElementById('cache-dir');
  if (infoEl && info) {
    infoEl.textContent = '视频缓存：' + info.sizeLabel + ' / ' + info.maxLabel;
  }
  if (dirEl && info) {
    dirEl.textContent = '缓存目录：' + info.dir;
  }
}

async function updateCacheInfo() {
  try {
    const info = await api.getCacheInfo();
    applyCacheInfo(info);
  } catch (e) {
    // ignore
  }
}

async function chooseCacheDir() {
  const current = (await api.getCacheInfo()).dir;
  const dir = prompt('输入缓存目录路径（留空使用默认目录）：', current);
  if (dir == null) return;
  const trimmed = dir.trim();
  await persistSettings({ cacheDir: trimmed });
  updateCacheInfo();
  showHint(trimmed ? '缓存目录已更改为：' + trimmed : '已恢复默认缓存目录');
}

async function clearHistory() {
  await api.clearRecentWatches();
  settings.recentWatches = [];
  showHint('历史浏览记录已清除');
}

async function toggleBetaMode() {
  settings.betaMode = !settings.betaMode;
  await persistSettings({ betaMode: settings.betaMode });
  showHint(settings.betaMode ? '内测模式已打开' : '内测模式已关闭');
  showSettings();
}

async function toggleAutoUpdate() {
  settings.autoUpdateCheck = !settings.autoUpdateCheck;
  await persistSettings({ autoUpdateCheck: settings.autoUpdateCheck });
  showHint(settings.autoUpdateCheck ? '启动时自动检查更新已开启' : '启动时自动检查更新已关闭');
  showSettings();
}

async function checkUpdate(source) {
  showLoading('正在检查更新...');
  try {
    const info = await api.checkUpdate(source);
    hideLoading('');
    if (!info || !info.versionName) {
      showHint(source === 'gitee' ? 'Gitee 没有找到更新' : 'GitHub 没有找到更新');
      return;
    }
    if (!info.hasNewerVersion) {
      showHint(info.sourceName + ' 已是最新版本：' + info.currentVersion);
      return;
    }
    showUpdatePrompt(info);
  } catch (e) {
    hideLoading('');
    showHint('检查更新失败：' + (e && e.message ? e.message : e));
  }
}

function showUpdatePrompt(info) {
  const url = info.releaseUrl || info.assetUrl;
  const msg =
    '当前版本：' +
    info.currentVersion +
    '\n最新版本：' +
    info.versionName +
    '\n更新来源：' +
    info.sourceName;
  if (confirm(msg + '\n\n是否打开下载页面？')) {
    if (url) api.openExternal(url);
  }
}

// ---- Detail screen ---------------------------------------------------------
async function loadDetail(item) {
  currentVideo = item;
  showLoading('正在加载详情...');
  try {
    const detail = await api.fetchDetail(item);
    showDetail(detail);
  } catch (e) {
    hideLoading('详情加载失败：' + (e && e.message ? e.message : e));
  }
}

function showDetail(detail) {
  screen = 'detail';
  currentDetailEpisodes = detail.episodes;
  activeSourcePosition = 0;
  episodeSelectedIndex = 0;

  renderNav(null);
  contentEl.innerHTML =
    '<div class="detail">' +
    '<div class="detail-top">' +
    '<button id="detail-back" class="btn">返回</button>' +
    '<div class="detail-title">' + escapeHtml(detail.title) + '</div>' +
    '</div>' +
    '<div class="detail-body">' +
    '<img class="detail-poster" src="' + escapeHtml(imageSrc(detail.poster)) + '" alt="" />' +
    '<div class="detail-right">' +
    '<div class="detail-meta">' + escapeHtml(detail.meta || '') + '</div>' +
    '<div class="detail-desc">' + escapeHtml(detail.description || '暂无简介') + '</div>' +
    '<div class="section-title">线路来源</div>' +
    '<div id="source-row" class="source-row"></div>' +
    '<div class="section-title">剧集</div>' +
    '<div id="episode-scroll" class="episode-scroll"><div id="episode-grid" class="episode-grid"></div></div>' +
    '</div>' +
    '</div>' +
    '</div>';

  document.getElementById('detail-back').addEventListener('click', () => showCatalog(currentTitle, currentPath));

  currentSources = buildSourceGroups(detail.episodes);
  renderSourceRow();
  renderEpisodeGrid();
  hideLoading(detail.episodes.length === 0 ? '没有解析到剧集' : '');
  if (detail.episodes.length > 0) restoreRecentEpisodeSelection();
}

function buildSourceGroups(episodes) {
  const groups = new Map();
  for (const ep of episodes) {
    if (!groups.has(ep.source)) {
      groups.set(ep.source, { source: ep.source, title: episodeSourceLabel(ep), episodes: [] });
    }
    groups.get(ep.source).episodes.push(ep);
  }
  const out = Array.from(groups.values());
  out.sort((a, b) => {
    const p = sourceGroupPriority(a.title) - sourceGroupPriority(b.title);
    if (p !== 0) return p;
    return a.source - b.source;
  });
  for (const g of out) g.episodes.sort((a, b) => a.index - b.index);
  return out;
}

function renderSourceRow() {
  const row = document.getElementById('source-row');
  if (!row) return;
  row.innerHTML = currentSources
    .map(
      (g, i) =>
        '<button class="source-btn' +
        (i === activeSourcePosition ? ' active' : '') +
        '" data-index="' +
        i +
        '">' +
        escapeHtml(g.title) +
        '</button>'
    )
    .join('');
  row.querySelectorAll('.source-btn').forEach((btn) => {
    btn.addEventListener('click', () => selectSource(parseInt(btn.dataset.index, 10)));
  });
}

function selectSource(position) {
  if (currentSources.length === 0) return;
  activeSourcePosition = Math.max(0, Math.min(position, currentSources.length - 1));
  episodeSelectedIndex = 0;
  renderSourceRow();
  renderEpisodeGrid();
}

function renderEpisodeGrid() {
  const grid = document.getElementById('episode-grid');
  if (!grid) return;
  const source = currentSources[activeSourcePosition];
  const episodes = source ? source.episodes : [];
  if (episodes.length === 0) {
    grid.innerHTML = '<div style="color:var(--muted);padding:12px">暂无剧集</div>';
    return;
  }
  grid.innerHTML = episodes
    .map(
      (ep, i) =>
        '<button class="episode-btn' +
        (i === episodeSelectedIndex ? ' selected' : '') +
        '" data-index="' +
        i +
        '">' +
        escapeHtml(ep.title) +
        '</button>'
    )
    .join('');
  grid.querySelectorAll('.episode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      episodeSelectedIndex = parseInt(btn.dataset.index, 10);
      highlightEpisodeSelection();
      const ep = episodes[episodeSelectedIndex];
      if (ep) playEpisode(ep);
    });
  });
}

function highlightEpisodeSelection() {
  document.querySelectorAll('#episode-grid .episode-btn').forEach((btn) => {
    btn.classList.toggle('selected', parseInt(btn.dataset.index, 10) === episodeSelectedIndex);
  });
}

function restoreRecentEpisodeSelection() {
  const sel = findRecentEpisodeSelection();
  selectSource(sel.sourcePosition);
  if (sel.episodeSelected) {
    episodeSelectedIndex = Math.max(0, Math.min(sel.episodePosition, (currentSources[sel.sourcePosition]?.episodes.length || 1) - 1));
    highlightEpisodeSelection();
  }
  if (sel.positionMs > 0) showHint('上次看到 ' + formatTime(sel.positionMs));
}

function findRecentEpisodeSelection() {
  const item = currentVideo;
  if (!item || item.episodeIndex <= 0 || currentSources.length === 0) {
    return { sourcePosition: 0, episodePosition: 0, positionMs: 0, episodeSelected: false };
  }
  let fallbackSource = 0;
  let fallbackEpisode = 0;
  let matched = false;
  const resumePosition = normalizedRecentPosition(item.positionMs, item.durationMs);
  for (let si = 0; si < currentSources.length; si++) {
    const source = currentSources[si];
    for (let ei = 0; ei < source.episodes.length; ei++) {
      const ep = source.episodes[ei];
      if (ep.index !== item.episodeIndex) continue;
      if (ep.path === item.episodePath) {
        return { sourcePosition: si, episodePosition: ei, positionMs: resumePosition, episodeSelected: true };
      }
      if (!matched) {
        fallbackSource = si;
        fallbackEpisode = ei;
        matched = true;
      }
      if (
        ep.source === item.episodeSource ||
        (item.episodeSourceName && ep.sourceName === item.episodeSourceName) ||
        (item.episodeFrom && ep.from === item.episodeFrom)
      ) {
        fallbackSource = si;
        fallbackEpisode = ei;
      }
    }
  }
  return {
    sourcePosition: fallbackSource,
    episodePosition: fallbackEpisode,
    positionMs: matched ? resumePosition : 0,
    episodeSelected: matched,
  };
}

// ---- Playback --------------------------------------------------------------
async function playEpisode(episode) {
  if (!episode) return;
  pendingEpisode = episode;
  pendingResumePositionMs = resumePositionForEpisode(episode);
  const candidates = playbackCandidates(episode);

  showLoading('正在解析播放地址...');
  let fallback = null;
  let fallbackEpisode = episode;

  for (const candidate of candidates) {
    try {
      const target = await api.resolvePlayTarget(candidate);
      if (target.directUrl) {
        pendingEpisode = candidate;
        pendingResumePositionMs = resumePositionForEpisode(candidate);
        hideLoading('');
        showPlayer(target);
        return;
      }
      if (!fallback || episodeSourcePriority(candidate) < episodeSourcePriority(fallbackEpisode)) {
        fallback = target;
        fallbackEpisode = candidate;
      }
    } catch (e) {
      // try next candidate
    }
  }

  const target =
    fallback ||
    { title: episode.title, webUrl: absolutize(episode.path), directUrl: '', from: episode.from };
  pendingEpisode = fallbackEpisode;
  pendingResumePositionMs = resumePositionForEpisode(fallbackEpisode);
  hideLoading('');
  showHint('未解析到 m3u8，请换“国际/亚太”等 m3u8 线路');
}

function playbackCandidates(episode) {
  const candidates = [];
  const seen = new Set();
  for (const ep of currentDetailEpisodes) {
    if (ep.index === episode.index && !seen.has(ep.path)) {
      seen.add(ep.path);
      candidates.push(ep);
    }
  }
  if (!seen.has(episode.path)) candidates.push(episode);

  candidates.sort((a, b) => {
    const sel = selectedCandidateCompare(a, b, episode);
    if (sel !== 0) return sel;
    const p = episodeSourcePriority(a) - episodeSourcePriority(b);
    if (p !== 0) return p;
    return a.source - b.source;
  });
  return candidates;
}

function selectedCandidateCompare(a, b, selected) {
  const aSel = a === selected;
  const bSel = b === selected;
  if (aSel === bSel || episodeSourcePriority(selected) > 1) return 0;
  return aSel ? -1 : 1;
}

function resumePositionForEpisode(episode) {
  if (!currentVideo || !episode || currentVideo.episodeIndex <= 0) return 0;
  if (episode.index !== currentVideo.episodeIndex) return 0;
  const sameEpisode =
    episode.path === currentVideo.episodePath ||
    episode.source === currentVideo.episodeSource ||
    (currentVideo.episodeSourceName && episode.sourceName === currentVideo.episodeSourceName) ||
    (currentVideo.episodeFrom && episode.from === currentVideo.episodeFrom);
  return sameEpisode ? normalizedRecentPosition(currentVideo.positionMs, currentVideo.durationMs) : 0;
}

// ---- Native player ---------------------------------------------------------
function showPlayer(target) {
  screen = 'player';
  navRailEl.classList.add('hidden');

  const directUrl = target.directUrl;
  const referer = refererForPlayback(target);
  const isM3u8 = /\.m3u8($|\?)/i.test(directUrl);

  contentEl.innerHTML =
    '<div class="player">' +
    '<div class="player-topbar">' +
    '<button id="player-back" class="player-back-btn">← 返回</button>' +
    '<div class="player-title">' + escapeHtml(target.title) + '</div>' +
    '<button id="player-pip" class="player-top-btn">画中画</button>' +
    '<button id="player-boss" class="player-top-btn">老板模式</button>' +
    '</div>' +
    '<video id="video" class="player-video" controls playsinline autoplay></video>' +
    '</div>';

  videoElement = document.getElementById('video');
  document.getElementById('player-back').addEventListener('click', () => closePlayer());
  document.getElementById('player-pip').addEventListener('click', togglePictureInPicture);
  document.getElementById('player-boss').addEventListener('click', toggleBossMode);
  setupTopbarAutoHide();
  setupBossMode();
  saveRecentWatch();
  showHint('正在播放：' + target.title);

  if (isM3u8 && window.Hls && window.Hls.isSupported()) {
    setupHls(directUrl, referer);
  } else if (isM3u8 && videoElement.canPlayType('application/vnd.apple.mpegurl')) {
    videoElement.src = proxyUrl(directUrl, referer);
    videoElement.play().catch(() => {});
  } else {
    videoElement.src = proxyUrl(directUrl, referer);
    videoElement.addEventListener('loadedmetadata', () => {
      if (pendingResumePositionMs > 0) {
        videoElement.currentTime = pendingResumePositionMs / 1000;
        showHint('从 ' + formatTime(pendingResumePositionMs) + ' 继续播放');
      }
      videoElement.play().catch(() => {});
    });
  }

  startProgressSaver();
}

function setupHls(directUrl, referer) {
  const preloadSeconds = settings.preloadMinutes * 60;
  hls = new window.Hls({
    maxBufferLength: preloadSeconds,
    maxMaxBufferLength: preloadSeconds * 2,
    backBufferLength: 60,
  });
  hls.loadSource(proxyUrl(directUrl, referer));
  hls.attachMedia(videoElement);
  hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
    if (pendingResumePositionMs > 0) {
      videoElement.currentTime = pendingResumePositionMs / 1000;
      showHint('从 ' + formatTime(pendingResumePositionMs) + ' 继续播放');
    }
    videoElement.play().catch(() => {});
  });
  hls.on(window.Hls.Events.ERROR, (_evt, data) => {
    if (data && data.fatal) {
      showHint('播放失败，请换一条 m3u8 线路');
      closePlayer();
    }
  });
}

function refererForPlayback(target) {
  // Peach sources need no referer; yfvod direct links expect the play page.
  if (target.from === 'peach') return '';
  return target.webUrl || BASE_URL + '/';
}

// Top bar (back button + title) auto-hides like the native video controls:
// it shows on mouse activity and fades out after a short idle period.
function setupTopbarAutoHide() {
  const playerEl = contentEl.querySelector('.player');
  const topbar = contentEl.querySelector('.player-topbar');
  if (!playerEl || !topbar) return;

  function showTopbar() {
    topbar.classList.add('visible');
    clearTimeout(topbarHideTimer);
    topbarHideTimer = setTimeout(() => topbar.classList.remove('visible'), 2500);
  }

  playerEl.addEventListener('mousemove', showTopbar);
  playerEl.addEventListener('mouseenter', showTopbar);
  showTopbar();
}

// ---- Picture-in-Picture + Boss Mode ----------------------------------------

async function togglePictureInPicture() {
  if (!videoElement) return;
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      await videoElement.requestPictureInPicture();
    }
  } catch (e) {
    showHint('当前视频不支持画中画');
  }
}

function updateBossButton() {
  const btn = document.getElementById('player-boss');
  if (btn) {
    btn.classList.toggle('active', bossMode);
    btn.textContent = bossMode ? '老板模式：开' : '老板模式';
  }
}

function toggleBossMode() {
  bossMode = !bossMode;
  bossPaused = false;
  updateBossButton();
  showHint(bossMode ? '老板模式已开启：鼠标离开窗口稍远即暂停并隐藏到托盘' : '老板模式已关闭');
}

function stopBossModeCheck() {
  clearInterval(bossModeCheckTimer);
  bossModeCheckTimer = null;
}

function setupBossMode() {
  if (bossModeListenersSetup) return;
  bossModeListenersSetup = true;

  document.addEventListener('mouseleave', () => {
    if (!bossMode || !videoElement) return;
    if (videoElement.paused) return;
    // Don't hide immediately: keep watching the global cursor. Moving onto the
    // title bar / resize border (to drag or resize) stays within a ring around
    // the window and should not trigger the hide.
    stopBossModeCheck();
    bossAwaySince = 0;
    bossModeCheckTimer = setInterval(async () => {
      let near = false;
      try {
        near = await api.cursorNearWindow(settings.bossMargin ?? 80);
      } catch (e) {
        near = false;
      }
      if (near) {
        bossAwaySince = 0;
        return;
      }
      const now = Date.now();
      if (!bossAwaySince) bossAwaySince = now;
      if (now - bossAwaySince >= (settings.bossDelayMs ?? 450)) {
        stopBossModeCheck();
        if (videoElement && !videoElement.paused) {
          bossPaused = true;
          videoElement.pause();
          api.hideWindow().catch(() => {});
        }
      }
    }, 100);
  });

  document.addEventListener('mouseenter', () => {
    stopBossModeCheck();
    if (!bossMode || !bossPaused || !videoElement) return;
    bossPaused = false;
    videoElement.play().catch(() => {});
  });
}

function startProgressSaver() {
  clearInterval(progressSaverTimer);
  progressSaverTimer = setInterval(() => {
    if (screen === 'player' && videoElement) {
      saveRecentWatch();
    }
  }, PROGRESS_SAVE_INTERVAL_MS);
}

function currentPlaybackPositionMs() {
  return videoElement && isFinite(videoElement.currentTime)
    ? Math.round(Math.max(0, videoElement.currentTime * 1000))
    : 0;
}
function currentPlaybackDurationMs() {
  return videoElement && isFinite(videoElement.duration) && videoElement.duration > 0
    ? Math.round(videoElement.duration * 1000)
    : 0;
}

async function saveRecentWatch() {
  if (!currentVideo || !currentVideo.url) return;
  const withProgress = buildVideoWithProgress(currentVideo, pendingEpisode, currentPlaybackPositionMs(), currentPlaybackDurationMs());
  currentVideo = withProgress;
  settings.recentWatches = await api.saveRecentWatch(withProgress);
}

function buildVideoWithProgress(video, episode, positionMs, durationMs) {
  const safeDuration = Math.round(Math.max(0, durationMs));
  const safePosition = Math.round(normalizedRecentPosition(positionMs, safeDuration));
  return {
    ...video,
    episodeTitle: episode ? episode.title : video.episodeTitle,
    episodePath: episode ? episode.path : video.episodePath,
    episodeSource: episode ? episode.source : video.episodeSource,
    episodeIndex: episode ? episode.index : video.episodeIndex,
    episodeFrom: episode ? episode.from : video.episodeFrom,
    episodeSourceName: episode ? episode.sourceName : video.episodeSourceName,
    positionMs: safePosition,
    durationMs: safeDuration,
    updatedAt: Date.now(),
  };
}

function destroyPlayer() {
  clearInterval(progressSaverTimer);
  progressSaverTimer = null;
  clearTimeout(topbarHideTimer);
  topbarHideTimer = null;
  bossMode = false;
  bossPaused = false;
  stopBossModeCheck();
  updateBossButton();
  if (hls) {
    try {
      hls.destroy();
    } catch (e) {
      // ignore
    }
    hls = null;
  }
  if (videoElement) {
    videoElement.pause();
    videoElement.removeAttribute('src');
    try {
      videoElement.load();
    } catch (e) {
      // ignore
    }
    videoElement = null;
  }
}

function closePlayer() {
  saveRecentWatch();
  destroyPlayer();
  navRailEl.classList.remove('hidden');
  if (currentVideo) {
    loadDetail(currentVideo);
  } else {
    showCatalog(currentTitle, currentPath);
  }
}

function seekBy(offsetMs) {
  if (!videoElement) return;
  const duration = isFinite(videoElement.duration) ? videoElement.duration * 1000 : 0;
  const current = Math.max(0, videoElement.currentTime * 1000);
  let target = current + offsetMs;
  if (duration > 0) target = Math.min(duration, Math.max(0, target));
  else target = Math.max(0, target);
  videoElement.currentTime = target / 1000;
  showHint((offsetMs > 0 ? '快进 ' : '快退 ') + formatTime(target));
}

// ---- Keyboard navigation ---------------------------------------------------
function handleBack() {
  if (screen === 'player') {
    closePlayer();
    return;
  }
  if (screen === 'search') {
    showCatalog('首页', '/');
    return;
  }
  if (screen === 'settings') {
    showCatalog(currentTitle, currentPath);
    return;
  }
  if (screen === 'detail') {
    showCatalog(currentTitle, currentPath);
    return;
  }
  // catalog -> nothing (top level)
}

document.addEventListener('keydown', (e) => {
  const inputFocused = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
  if (inputFocused) return;

  if (e.key === 'Escape' || e.key === 'Backspace') {
    e.preventDefault();
    handleBack();
    return;
  }

  if (screen === 'player') {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      seekBy(-SEEK_STEP_MS);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      seekBy(SEEK_STEP_MS);
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      togglePlayPause();
    }
    return;
  }

  if (screen === 'catalog' || screen === 'search') {
    const cols = 5;
    const count = catalogItems.length;
    if (e.key === 'ArrowRight' && catalogSelectedIndex < count - 1) {
      e.preventDefault();
      catalogSelectedIndex++;
      highlightGridSelection();
    } else if (e.key === 'ArrowLeft' && catalogSelectedIndex > 0) {
      e.preventDefault();
      catalogSelectedIndex--;
      highlightGridSelection();
    } else if (e.key === 'ArrowDown' && catalogSelectedIndex + cols < count) {
      e.preventDefault();
      catalogSelectedIndex = Math.min(count - 1, catalogSelectedIndex + cols);
      highlightGridSelection();
    } else if (e.key === 'ArrowUp' && catalogSelectedIndex - cols >= 0) {
      e.preventDefault();
      catalogSelectedIndex -= cols;
      highlightGridSelection();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = catalogItems[catalogSelectedIndex];
      if (item) loadDetail(item);
    }
    return;
  }

  if (screen === 'detail') {
    if (e.key === 'ArrowLeft' && activeSourcePosition > 0) {
      e.preventDefault();
      selectSource(activeSourcePosition - 1);
    } else if (e.key === 'ArrowRight' && activeSourcePosition < currentSources.length - 1) {
      e.preventDefault();
      selectSource(activeSourcePosition + 1);
    } else {
      const source = currentSources[activeSourcePosition];
      const count = source ? source.episodes.length : 0;
      const cols = 6;
      if (e.key === 'ArrowDown' && episodeSelectedIndex + cols < count) {
        e.preventDefault();
        episodeSelectedIndex = Math.min(count - 1, episodeSelectedIndex + cols);
        highlightEpisodeSelection();
      } else if (e.key === 'ArrowUp' && episodeSelectedIndex - cols >= 0) {
        e.preventDefault();
        episodeSelectedIndex -= cols;
        highlightEpisodeSelection();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const ep = source && source.episodes[episodeSelectedIndex];
        if (ep) playEpisode(ep);
      }
    }
  }
}, true);

function togglePlayPause() {
  if (!videoElement) return;
  if (videoElement.paused) {
    videoElement.play().catch(() => {});
    showHint('播放');
  } else {
    videoElement.pause();
    showHint('暂停');
  }
}

// ---- Startup ---------------------------------------------------------------
async function init() {
  settings = await api.getSettings();
  if (!settings) settings = { preloadMinutes: DEFAULT_PRELOAD_MINUTES, betaMode: true, autoUpdateCheck: false, recentWatches: [] };
  if (!Array.isArray(settings.recentWatches)) settings.recentWatches = [];
  if (!settings.preloadMinutes) settings.preloadMinutes = DEFAULT_PRELOAD_MINUTES;

  proxyBase = await api.getProxyBase();

  await showCatalog('首页', '/');
  maybeCheckUpdateOnStartup();
}

function maybeCheckUpdateOnStartup() {
  if (!settings.autoUpdateCheck) return;
  const now = Date.now();
  const last = settings.lastAutoUpdateCheck || 0;
  if (now - last < 6 * 60 * 60 * 1000) return;
  persistSettings({ lastAutoUpdateCheck: now }).then(() => {});
  setTimeout(() => checkUpdate('github'), 1800);
}

init().catch((e) => {
  // Show a visible error rather than a silent black screen if startup fails.
  showHint('初始化失败：' + (e && e.message ? e.message : e));
});
