'use strict';

/**
 * Port of the Android app's `SiteClient` — HTML scraping of yfvod.com plus
 * the Fernet-encrypted "peach" JSON API. Regexes and parsing logic are kept
 * as close to the original Java as JavaScript allows.
 */

const { fetchText } = require('./http');
const { fernetDecrypt } = require('./fernet');

// ---- Constants (mirror MainActivity) ---------------------------------------
const BASE_URL = 'https://www.yfvod.com';
const MOVIE_TIME_PATH = '/vod-show/1--time---------.html';
const TV_SHOW_PATH = '/vod-show/2--time---------.html';
const VARIETY_SHOW_PATH = '/vod-show/3--time---------.html';
const ANIMATION_SHOW_PATH = '/vod-show/4--time---------.html';
const PEACH_PATH = 'peach://catalog';
const PEACH_API_BASE = 'https://sm-api.wieuc.com';
const PEACH_SITE_ID = '2';
const PEACH_CHANNEL_ID = '522';
const PEACH_CHANNEL_NAME = 'gj-89';
const PEACH_RANDOM_PAGE_MAX = 30;
const PEACH_IMAGE_HOST = 'https://hm-img.twmjjy.com';
const PEACH_PLAY_HOSTS = [
  'https://hm-img.twmjjy.com',
  'https://hm-vip.twmjjy.com',
  'https://hm-img.aa66cc.live',
];
const PEACH_FERNET_KEY = 'NyGRG56A8i5J2JMqh7da83r2MMfgbM7Ppw1aCF8YnAY=';

const GITHUB_UPDATE_API_URL =
  'https://api.github.com/repos/chenziwenhaoshuai/Ziwen-Player-Desktop/releases/latest';
const GITEE_UPDATE_API_URL =
  'https://gitee.com/api/v5/repos/chenziwenhaoshuai/Ziwen-Player-Desktop/releases/latest';

// ---- Generic helpers --------------------------------------------------------

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseIntSafe(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

const HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function htmlDecode(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&#(\d+);/g, (m, d) => {
      try {
        return String.fromCodePoint(parseInt(d, 10));
      } catch (e) {
        return m;
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, d) => {
      try {
        return String.fromCodePoint(parseInt(d, 16));
      } catch (e) {
        return m;
      }
    })
    .replace(/&([a-zA-Z]+);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(HTML_ENTITIES, name) ? HTML_ENTITIES[name] : m
    );
}

function cleanText(html) {
  const noTags = String(html == null ? '' : html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return htmlDecode(noTags)
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(tag, name) {
  const m = tag.match(
    new RegExp('\\b' + escapeRe(name) + '\\s*=\\s*(["\'])([\\s\\S]*?)\\1', 'i')
  );
  return m ? htmlDecode(m[2].trim()) : '';
}

function backgroundUrl(tag) {
  const m = tag.match(/background-image\s*:\s*url\((['"]?)([\s\S]*?)\1\)/i);
  return m ? m[2].trim() : '';
}

function firstText(html, cls) {
  const m = html.match(
    new RegExp('<[^>]+class=["\'][^"\']*' + escapeRe(cls) + '[^"\']*["\'][^>]*>([\\s\\S]*?)</[^>]+>', 'i')
  );
  return m ? cleanText(m[1]) : '';
}

function firstMeta(html, name) {
  const m = html.match(
    new RegExp(
      '<meta\\b(?=[^>]*(?:name|property)=["\']' +
        escapeRe(name) +
        '["\'])[^>]*content=["\']([\\s\\S]*?)["\'][^>]*>',
      'i'
    )
  );
  return m ? htmlDecode(m[1].trim()) : '';
}

function field(html, label) {
  const index = html.indexOf(label);
  if (index < 0) return '';
  const end = html.indexOf('\n', index);
  let chunk;
  if (end > index) {
    chunk = html.substring(index, Math.min(end, index + 220));
  } else {
    chunk = html.substring(index, Math.min(html.length, index + 220));
  }
  chunk = cleanText(chunk).replace(label, '').trim();
  const cut = chunk.indexOf(' ');
  return cut > 0 ? chunk.substring(0, cut) : chunk;
}

function collectMeta(html) {
  const status = field(html, '状态：');
  const actor = field(html, '主演：');
  const year = field(html, '年份：');
  const type = field(html, '类型：');
  const parts = [];
  if (status) parts.push(status);
  if (year) parts.push(year);
  if (type) parts.push(type);
  if (actor) parts.push(actor);
  return parts.length === 0 ? '来自爱壹帆' : parts.join(' / ');
}

function firstIframe(html) {
  let m = html.match(/<iframe\b[^>]*id=["']player_if["'][^>]*src=["']([^"']+)["']/i);
  if (m) return m[1];
  m = html.match(/<iframe\b[^>]*src=["']([^"']*\/vod\/player\/[^"']+)["']/i);
  return m ? m[1] : '';
}

function playerValue(html, key) {
  const m = html.match(
    new RegExp(
      'player_aaaa\\s*=\\s*\\{[\\s\\S]*?["\']' +
        escapeRe(key) +
        '["\']\\s*:\\s*["\']([\\s\\S]*?)["\']',
      'i'
    )
  );
  return m ? m[1] : '';
}

function isDirect(url) {
  const lower = url.toLowerCase();
  return (
    lower.includes('.m3u8') ||
    lower.includes('.mp4') ||
    lower.includes('.flv') ||
    lower.includes('.webm')
  );
}

function between(html, start, end) {
  const left = html.indexOf(start);
  if (left < 0) return '';
  const right = html.indexOf(end, left + start.length);
  if (right < 0) return '';
  return htmlDecode(html.substring(left + start.length, right).trim());
}

function absolutize(path) {
  if (!path) return BASE_URL + '/';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  if (!path.startsWith('/')) path = '/' + path;
  return BASE_URL + path;
}

function absolutizeHost(host, path) {
  if (!path) return '';
  if (
    path.startsWith('http://') ||
    path.startsWith('https://') ||
    path.startsWith('data:')
  ) {
    return path;
  }
  return host + (path.startsWith('/') ? path : '/' + path);
}

function valueOr(value, fallback) {
  return value == null || value === '' ? (fallback == null ? '' : fallback) : value;
}

function peachPage(path) {
  if (!path) return 1;
  const index = path.indexOf('page=');
  if (index < 0) return 1;
  return Math.max(1, parseIntSafe(path.substring(index + 5).replace(/[^0-9].*$/, '')));
}

function peachImageUrl(path) {
  return absolutizeHost(PEACH_IMAGE_HOST, path);
}

function peachPlayUrls(path) {
  const out = [];
  for (const host of PEACH_PLAY_HOSTS) {
    const url = absolutizeHost(host, path);
    if (url) out.push(url);
  }
  return out;
}

function peachPubdate(item) {
  if (!item || !item.remarks) return '';
  const m = item.remarks.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{8}/);
  if (m) return m[0].replace(/\//g, '-');
  return item.remarks;
}

// ---- Data factories ---------------------------------------------------------

function makeVideoItem(
  title,
  url,
  poster,
  remarks,
  provider = '',
  remoteId = '',
  playUrl = '',
  episodeTitle = '',
  episodePath = '',
  episodeSource = 0,
  episodeIndex = 0,
  episodeFrom = '',
  episodeSourceName = '',
  positionMs = 0,
  durationMs = 0,
  updatedAt = 0
) {
  return {
    title: title || '',
    url: url || '',
    poster: poster || '',
    remarks: remarks || '',
    provider: provider || '',
    remoteId: remoteId || '',
    playUrl: playUrl || '',
    episodeTitle: episodeTitle || '',
    episodePath: episodePath || '',
    episodeSource: episodeSource || 0,
    episodeIndex: episodeIndex || 0,
    episodeFrom: episodeFrom || '',
    episodeSourceName: episodeSourceName || '',
    positionMs: Math.max(0, positionMs),
    durationMs: Math.max(0, durationMs),
    updatedAt: Math.max(0, updatedAt),
    isPeach: provider === 'peach',
  };
}

function makeEpisode(title, path, source, index, from, sourceName) {
  return {
    title: title || '',
    path: path || '',
    source: source || 0,
    index: index || 0,
    from: from || '',
    sourceName: sourceName || '',
  };
}

// ---- Episode / source helpers (mirror Episode + SourceGroup) ----------------

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

function episodePriority(episode) {
  const from = episode.from || '';
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

function episodeSourcePriority(episode) {
  const from = episode.from || '';
  if (from) return episodePriority(episode);
  const name = episode.sourceName || '';
  if (
    name.includes('国际') ||
    name.includes('亚太') ||
    name.includes('备用') ||
    name.includes('海外')
  ) {
    return 0;
  }
  if (name.includes('高清')) return 5;
  return 2;
}

function episodeSourceLabel(episode) {
  if (episode.sourceName) return episode.sourceName;
  if (episode.from) return episodePriority(episode) <= 1 ? 'm3u8' : episode.from;
  return '线路' + episode.source;
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

function parseSourceNames(html) {
  const sourceIds = [];
  const linkRe = /\/vod-play\/\d+-(\d+)-1\.html/gi;
  for (const m of html.matchAll(linkRe)) {
    const sid = parseIntSafe(m[1]);
    if (sid > 0 && !sourceIds.includes(sid)) sourceIds.push(sid);
  }

  const names = [];
  const nameRe = /<a\b[^>]*class=["'][^"']*(?:hl-from-btn|hl-tabs-btn)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(nameRe)) {
    const name = cleanText(m[1]);
    if (name && !names.includes(name)) names.push(name);
  }

  const out = new Map();
  const count = Math.min(sourceIds.length, names.length);
  for (let i = 0; i < count; i++) out.set(sourceIds[i], names[i]);
  return out;
}

// ---- SiteClient -------------------------------------------------------------

class SiteClient {
  async fetchCatalog(path) {
    if (path && path.startsWith(PEACH_PATH)) {
      return this.fetchPeachCatalog(peachPage(path));
    }
    const html = await fetchText(absolutize(path), BASE_URL + '/');
    const out = new Map();
    const anchorRe = /<a\b[^>]*>/gi;
    for (const m of html.matchAll(anchorRe)) {
      const tag = m[0];
      const href = attr(tag, 'href');
      if (!href || !href.includes('/vodhtml/')) continue;

      const cls = attr(tag, 'class');
      let title = attr(tag, 'title');
      if (!title && cls && !cls.includes('hl-item-thumb') && !cls.includes('hl-br-thumb')) {
        continue;
      }
      if (!title) title = cleanText(tag);
      if (!title) continue;

      let poster = attr(tag, 'data-original');
      if (!poster) poster = backgroundUrl(tag);

      const liStart = Math.max(0, html.lastIndexOf('<li', m.index));
      const liEnd = html.indexOf('</li>', m.index + tag.length);
      const chunk =
        liEnd > liStart ? html.substring(liStart, Math.min(liEnd + 5, html.length)) : tag;
      const remarks = firstText(chunk, 'remarks');
      const score = firstText(chunk, 'score');
      const meta = score ? score + '  ' + remarks : remarks;
      const url = absolutize(href);
      if (!out.has(url)) {
        out.set(url, makeVideoItem(title, url, poster, meta));
      }
    }
    return Array.from(out.values());
  }

  async fetchDetail(item) {
    if (item && item.isPeach) {
      return this.fetchPeachDetail(item);
    }
    const html = await fetchText(item.url, BASE_URL + '/');

    let title = item.title;
    const pageTitle = between(html, '<title>', '</title>');
    if (pageTitle) {
      const left = pageTitle.indexOf('《');
      const right = pageTitle.indexOf('》', left + 1);
      if (left >= 0 && right > left) {
        title = pageTitle.substring(left + 1, right);
      }
    }

    let poster = firstMeta(html, 'og:image');
    if (!poster) poster = item.poster;
    const desc = firstMeta(html, 'description');
    const meta = collectMeta(html);
    const sourceNames = parseSourceNames(html);

    const episodes = [];
    const unique = new Map();
    const playLinkRe =
      /<a\b([^>]*)href=["']([^"']*vod-play\/([0-9]+)-(\d+)-(\d+)\.html)["']([^>]*)>([\s\S]*?)<\/a>/gi;
    for (const m of html.matchAll(playLinkRe)) {
      const href = m[2];
      const sid = parseIntSafe(m[4]);
      const nid = parseIntSafe(m[5]);
      let text = cleanText(m[7]);
      if (!text) text = '第' + nid + '集';
      if (sid > 1 && !text.includes('线路')) text = '线路' + sid + ' ' + text;
      const path = absolutize(href);
      unique.set(path, makeEpisode(text, path, sid, nid, '', sourceNames.get(sid) || ''));
    }
    episodes.push(...unique.values());
    episodes.sort((a, b) => {
      const e = a.index - b.index;
      if (e !== 0) return e;
      const p = episodeSourcePriority(a) - episodeSourcePriority(b);
      if (p !== 0) return p;
      return a.source - b.source;
    });

    return { title, poster, description: desc, meta, episodes };
  }

  async resolvePlayTarget(episode) {
    if (episode.from === 'peach') {
      return { title: episode.title, webUrl: episode.path, directUrl: episode.path, from: 'peach' };
    }
    const playHtml = await fetchText(episode.path, BASE_URL + '/');
    const iframe = firstIframe(playHtml);
    const playerHtml = iframe
      ? await fetchText(absolutize(iframe), episode.path)
      : playHtml;

    let rawUrl = playerValue(playerHtml, 'url');
    const from = playerValue(playerHtml, 'from');
    const title = episode.title;

    if (rawUrl) {
      let decoded = rawUrl.replace(/\\\//g, '/');
      if (decoded.startsWith('//')) decoded = 'https:' + decoded;
      if (isDirect(decoded)) {
        return { title, webUrl: episode.path, directUrl: decoded, from };
      }
    }
    return { title, webUrl: episode.path, directUrl: '', from };
  }

  // ---- Peach API ------------------------------------------------------------

  async fetchPeachCatalog(page) {
    const url =
      PEACH_API_BASE +
      '/api/vod/video?site_id=' +
      PEACH_SITE_ID +
      '&channel_id=' +
      PEACH_CHANNEL_ID +
      '&channel_name=' +
      encodeURIComponent(PEACH_CHANNEL_NAME) +
      '&page=' +
      page +
      '&per_page=24';
    const data = await this.fetchPeachData(url, '');
    const items = data.items;
    const out = [];
    if (!Array.isArray(items)) return out;

    for (const item of items) {
      const id = item.id || '';
      const title = item.name || '';
      const poster = peachImageUrl(item.pic || '');
      const playUrl = item.play_url || '';
      const duration = item.duration || '';
      const pubdate = item.pubdate || '';
      const meta = duration ? duration + (pubdate ? '  ' + pubdate : '') : pubdate;
      if (id && title) {
        out.push(
          makeVideoItem(title, PEACH_PATH + '/detail/' + id, poster, meta, 'peach', id, playUrl)
        );
      }
    }
    out.sort((a, b) => {
      const pa = peachPubdate(a);
      const pb = peachPubdate(b);
      if (pb < pa) return -1;
      if (pb > pa) return 1;
      return 0;
    });
    return out;
  }

  async fetchPeachDetail(item) {
    let detail = null;
    if (item.remoteId) {
      detail = await this.fetchPeachData(
        PEACH_API_BASE +
          '/api/vod/video/' +
          item.remoteId +
          '?site_id=' +
          PEACH_SITE_ID +
          '&channel_id=' +
          PEACH_CHANNEL_ID +
          '&channel_name=' +
          encodeURIComponent(PEACH_CHANNEL_NAME),
        ''
      );
    }
    const data = detail || {};

    const title = valueOr(data.name || '', item.title);
    const poster = peachImageUrl(valueOr(data.pic || '', item.poster));
    const playPath = valueOr(data.play_url || '', item.playUrl);
    const playUrls = peachPlayUrls(playPath);
    const desc = valueOr(data.description || '', title);
    const duration = data.duration || '';
    const pubdate = data.pubdate || '';
    const meta = duration ? duration + (pubdate ? '  ' + pubdate : '') : pubdate;

    const episodes = playUrls.map((u, i) =>
      makeEpisode('播放', u, i + 1, 1, 'peach', '线路' + (i + 1))
    );

    return { title, poster, description: desc, meta, episodes };
  }

  async fetchPeachData(url, referer) {
    const raw = await fetchText(url, referer);
    const payload = JSON.parse(raw);
    const encrypted = payload['x-data'] || '';
    const body = encrypted
      ? JSON.parse(fernetDecrypt(encrypted, PEACH_FERNET_KEY))
      : payload;
    if ((body.code || 0) !== 0) {
      throw new Error(body.message || 'API error');
    }
    return body.data || {};
  }
}

// ---- Update checking (Github/Gitee) ----------------------------------------

function normalizeVersionName(tag) {
  if (!tag) return '';
  let value = String(tag).trim();
  if (value.startsWith('v') || value.startsWith('V')) value = value.slice(1);
  return value;
}

function versionParts(versionName) {
  const parts = [];
  const re = /(\d+)/g;
  let m;
  while ((m = re.exec(versionName || '')) !== null) {
    parts.push(parseIntSafe(m[1]));
  }
  return parts;
}

function compareVersionNames(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const count = Math.max(a.length, b.length);
  for (let i = 0; i < count; i++) {
    const av = i < a.length ? a[i] : 0;
    const bv = i < b.length ? b[i] : 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

const UPDATE_ASSET_PREFIX = 'Ziwen-Player';
const UPDATE_ASSET_SUFFIX = '.exe';

async function fetchLatestUpdate(apiUrl, sourceName) {
  const raw = await fetchText(apiUrl, '');
  const release = JSON.parse(raw);
  const tag = release.tag_name || '';
  const versionName = normalizeVersionName(tag);

  let assetUrl = '';
  let assetName = '';
  const assets = release.assets;
  if (Array.isArray(assets)) {
    for (const asset of assets) {
      const name = asset.name || '';
      if (name.startsWith(UPDATE_ASSET_PREFIX) && name.endsWith(UPDATE_ASSET_SUFFIX)) {
        assetName = name;
        assetUrl = asset.browser_download_url || asset.download_url || '';
        break;
      }
    }
  }
  return {
    versionName,
    assetName,
    assetUrl,
    sourceName,
    releaseUrl: release.html_url || '',
  };
}

module.exports = {
  SiteClient,
  // constants
  BASE_URL,
  PEACH_PATH,
  PEACH_RANDOM_PAGE_MAX,
  MOVIE_TIME_PATH,
  TV_SHOW_PATH,
  VARIETY_SHOW_PATH,
  ANIMATION_SHOW_PATH,
  GITHUB_UPDATE_API_URL,
  GITEE_UPDATE_API_URL,
  PEACH_FERNET_KEY,
  // helpers reused elsewhere
  absolutize,
  absolutizeHost,
  htmlDecode,
  cleanText,
  fetchText,
  compareVersionNames,
  fetchLatestUpdate,
  episodeSourcePriority,
  episodeSourceLabel,
  sourceGroupPriority,
  makeVideoItem,
  makeEpisode,
};
