//! Port of the Android app's `SiteClient` — HTML scraping of yfvod.com plus
//! the Fernet-encrypted "peach" JSON API.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};

use crate::fernet::fernet_decrypt;
use crate::http_client::fetch_text;

pub const BASE_URL: &str = "https://www.yfvod.com";
pub const MOVIE_TIME_PATH: &str = "/vod-show/1--time---------.html";
pub const TV_SHOW_PATH: &str = "/vod-show/2--time---------.html";
pub const VARIETY_SHOW_PATH: &str = "/vod-show/3--time---------.html";
pub const ANIMATION_SHOW_PATH: &str = "/vod-show/4--time---------.html";
pub const PEACH_PATH: &str = "peach://catalog";
pub const PEACH_RANDOM_PAGE_MAX: i32 = 30;

const PEACH_API_BASE: &str = "https://sm-api.wieuc.com";
const PEACH_SITE_ID: &str = "2";
const PEACH_CHANNEL_ID: &str = "522";
const PEACH_CHANNEL_NAME: &str = "gj-89";
const PEACH_IMAGE_HOST: &str = "https://hm-img.twmjjy.com";
const PEACH_PLAY_HOSTS: [&str; 3] = [
    "https://hm-img.twmjjy.com",
    "https://hm-vip.twmjjy.com",
    "https://hm-img.aa66cc.live",
];
pub const PEACH_FERNET_KEY: &str = "NyGRG56A8i5J2JMqh7da83r2MMfgbM7Ppw1aCF8YnAY=";

pub const GITHUB_UPDATE_API_URL: &str =
    "https://api.github.com/repos/chenziwenhaoshuai/Ziwen-Player-Desktop/releases/latest";
pub const GITEE_UPDATE_API_URL: &str =
    "https://gitee.com/api/v5/repos/chenziwenhaoshuai/Ziwen-Player-Desktop/releases/latest";

// ---- Data models ------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct VideoItem {
    pub title: String,
    pub url: String,
    pub poster: String,
    pub remarks: String,
    pub provider: String,
    pub remote_id: String,
    pub play_url: String,
    pub episode_title: String,
    pub episode_path: String,
    pub episode_source: i32,
    pub episode_index: i32,
    pub episode_from: String,
    pub episode_source_name: String,
    pub position_ms: i64,
    pub duration_ms: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub is_peach: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub title: String,
    pub path: String,
    pub source: i32,
    pub index: i32,
    pub from: String,
    pub source_name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct VideoDetail {
    pub title: String,
    pub poster: String,
    pub description: String,
    pub meta: String,
    pub episodes: Vec<Episode>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlayTarget {
    pub title: String,
    pub web_url: String,
    pub direct_url: String,
    pub from: String,
}

// ---- Generic helpers --------------------------------------------------------

fn escape_re(s: &str) -> String {
    regex::escape(s)
}

fn parse_int(s: &str) -> i32 {
    s.trim().parse::<i32>().unwrap_or(0)
}

fn html_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        if let Some(j) = rest.find(';') {
            if j <= 12 {
                let entity = &rest[..=j];
                let replaced: Option<String> = match entity {
                    "&amp;" => Some("&".to_string()),
                    "&lt;" => Some("<".to_string()),
                    "&gt;" => Some(">".to_string()),
                    "&quot;" => Some("\"".to_string()),
                    "&apos;" | "&#39;" | "&#x27;" => Some("'".to_string()),
                    "&nbsp;" => Some(" ".to_string()),
                    _ => {
                        if entity.starts_with("&#x") || entity.starts_with("&#X") {
                            let hex = &entity[3..entity.len() - 1];
                            u32::from_str_radix(hex, 16)
                                .ok()
                                .and_then(char::from_u32)
                                .map(|c| c.to_string())
                        } else if entity.starts_with("&#") {
                            let dec = &entity[2..entity.len() - 1];
                            dec.parse::<u32>()
                                .ok()
                                .and_then(char::from_u32)
                                .map(|c| c.to_string())
                        } else {
                            None
                        }
                    }
                };
                if let Some(r) = replaced {
                    out.push_str(&r);
                    rest = &rest[j + 1..];
                    continue;
                }
            }
        }
        out.push('&');
        rest = &rest[1..];
    }
    out.push_str(rest);
    out
}

// ---- Pre-compiled regexes (compiled once, not per-item/per-call) ------------
static RE_SCRIPT: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?is)<script.*?</script>").unwrap());
static RE_STYLE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?is)<style.*?</style>").unwrap());
static RE_TAG: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?is)<[^>]+>").unwrap());
static RE_ANCHOR: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)<a\b[^>]*>").unwrap());
static RE_REMARKS: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)<[^>]+class=["'][^"']*remarks[^"']*["'][^>]*>([\s\S]*?)</[^>]+>"#).unwrap()
});
static RE_SCORE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)<[^>]+class=["'][^"']*score[^"']*["'][^>]*>([\s\S]*?)</[^>]+>"#).unwrap()
});
static RE_BG_URL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)background-image\s*:\s*url\(([\s\S]*?)\)").unwrap());
static RE_META: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)<meta\b[^>]*>").unwrap());
static RE_IFRAME_1: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)<iframe\b[^>]*id=["']player_if["'][^>]*src=["']([^"']+)["']"#).unwrap()
});
static RE_IFRAME_2: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)<iframe\b[^>]*src=["']([^"']*/vod/player/[^"']+)["']"#).unwrap()
});
static RE_PLAYER_URL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?is)player_aaaa\s*=\s*\{.*?["']url["']\s*:\s*["'](.*?)["']"#).unwrap()
});
static RE_PLAYER_FROM: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?is)player_aaaa\s*=\s*\{.*?["']from["']\s*:\s*["'](.*?)["']"#).unwrap()
});
static RE_PLAY_LINK: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)<a\b[^>]*href=["']([^"']*vod-play/([0-9]+)-(\d+)-(\d+)\.html)["'][^>]*>([\s\S]*?)</a>"#,
    )
    .unwrap()
});
static RE_LINK_SID: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)/vod-play/\d+-(\d+)-1\.html").unwrap());
static RE_SOURCE_NAME: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)<a\b[^>]*class=["'][^"']*(?:hl-from-btn|hl-tabs-btn)[^"']*["'][^>]*>([\s\S]*?)</a>"#).unwrap()
});
static RE_PEACH_PUBDATE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{8}").unwrap());
static RE_VERSION_PARTS: Lazy<Regex> = Lazy::new(|| Regex::new(r"(\d+)").unwrap());

fn clean_text(html: &str) -> String {
    let no_tags = RE_SCRIPT.replace_all(html, " ").into_owned();
    let no_tags = RE_STYLE.replace_all(&no_tags, " ").into_owned();
    let no_tags = RE_TAG.replace_all(&no_tags, " ").into_owned();
    let decoded = html_decode(&no_tags).replace('\u{00A0}', " ");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn attr(tag: &str, name: &str) -> String {
    let bytes = tag.as_bytes();
    let name = name.as_bytes();
    let n = name.len();
    if n == 0 {
        return String::new();
    }
    let mut i = 0usize;
    while i + n <= bytes.len() {
        if bytes[i..i + n].eq_ignore_ascii_case(name) {
            let boundary_before = i == 0
                || !(bytes[i - 1].is_ascii_alphanumeric()
                    || bytes[i - 1] == b'-'
                    || bytes[i - 1] == b'_'
                    || bytes[i - 1] == b':');
            let after = i + n;
            let boundary_after = after < bytes.len()
                && (bytes[after].is_ascii_whitespace() || bytes[after] == b'=');
            if boundary_before && boundary_after {
                let mut j = after;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < bytes.len() && bytes[j] == b'=' {
                    j += 1;
                    while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                        j += 1;
                    }
                    if j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
                        let quote = bytes[j];
                        j += 1;
                        let start = j;
                        while j < bytes.len() && bytes[j] != quote {
                            j += 1;
                        }
                        return html_decode(tag[start..j].trim());
                    }
                }
            }
        }
        i += 1;
    }
    String::new()
}

fn background_url(tag: &str) -> String {
    match RE_BG_URL.captures(tag) {
        Some(c) => c
            .get(1)
            .map(|m| m.as_str().trim().trim_matches(|ch| ch == '"' || ch == '\''))
            .unwrap_or("")
            .to_string(),
        None => String::new(),
    }
}

fn first_text_with(html: &str, re: &Regex) -> String {
    match re.captures(html) {
        Some(c) => clean_text(c.get(1).map(|m| m.as_str()).unwrap_or("")),
        None => String::new(),
    }
}

fn first_text(html: &str, cls: &str) -> String {
    match cls {
        "remarks" => first_text_with(html, &RE_REMARKS),
        "score" => first_text_with(html, &RE_SCORE),
        _ => {
            let re = Regex::new(&format!(
                r#"(?i)<[^>]+class=["'][^"']*{}[^"']*["'][^>]*>([\s\S]*?)</[^>]+>"#,
                escape_re(cls)
            ))
            .unwrap();
            first_text_with(html, &re)
        }
    }
}

fn first_meta(html: &str, name: &str) -> String {
    let name_re = Regex::new(&format!(
        r#"(?i)(?:name|property)\s*=\s*["']{}["']"#,
        escape_re(name)
    ))
    .unwrap();
    for m in RE_META.find_iter(html) {
        let tag = m.as_str();
        if name_re.is_match(tag) {
            let c = attr(tag, "content");
            if !c.is_empty() {
                return c;
            }
        }
    }
    String::new()
}

fn field(html: &str, label: &str) -> String {
    let Some(index) = html.find(label) else {
        return String::new();
    };
    let end = html[index..].find('\n').map(|e| index + e).unwrap_or(html.len());
    let chunk = &html[index..(end.min(index + 220))];
    let chunk = clean_text(chunk).replace(label, "");
    let chunk = chunk.trim().to_string();
    match chunk.find(' ') {
        Some(cut) if cut > 0 => chunk[..cut].to_string(),
        _ => chunk,
    }
}

fn collect_meta(html: &str) -> String {
    let status = field(html, "状态：");
    let actor = field(html, "主演：");
    let year = field(html, "年份：");
    let typ = field(html, "类型：");
    let mut parts: Vec<String> = Vec::new();
    if !status.is_empty() {
        parts.push(status);
    }
    if !year.is_empty() {
        parts.push(year);
    }
    if !typ.is_empty() {
        parts.push(typ);
    }
    if !actor.is_empty() {
        parts.push(actor);
    }
    if parts.is_empty() {
        "来自爱壹帆".to_string()
    } else {
        parts.join(" / ")
    }
}

fn first_iframe(html: &str) -> String {
    if let Some(c) = RE_IFRAME_1.captures(html) {
        return c.get(1).map(|m| m.as_str()).unwrap_or("").to_string();
    }
    RE_IFRAME_2
        .captures(html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_default()
}

fn player_value(html: &str, key: &str) -> String {
    let re = match key {
        "url" => &RE_PLAYER_URL,
        "from" => &RE_PLAYER_FROM,
        _ => {
            let re = Regex::new(&format!(
                r#"(?is)player_aaaa\s*=\s*\{{.*?["']{}["']\s*:\s*["'](.*?)["']"#,
                escape_re(key)
            ))
            .unwrap();
            return re
                .captures(html)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
        }
    };
    re.captures(html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_default()
}

fn is_direct(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains(".m3u8")
        || lower.contains(".mp4")
        || lower.contains(".flv")
        || lower.contains(".webm")
}

fn between(html: &str, start: &str, end: &str) -> String {
    let Some(left) = html.find(start) else {
        return String::new();
    };
    let right = html[left + start.len()..].find(end).map(|r| left + start.len() + r);
    match right {
        Some(r) => html_decode(html[left + start.len()..r].trim()),
        None => String::new(),
    }
}

pub fn absolutize(path: &str) -> String {
    if path.is_empty() {
        return format!("{BASE_URL}/");
    }
    if path.starts_with("http://") || path.starts_with("https://") {
        return path.to_string();
    }
    if path.starts_with('/') {
        format!("{BASE_URL}{path}")
    } else {
        format!("{BASE_URL}/{path}")
    }
}

fn absolutize_host(host: &str, path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    if path.starts_with("http://") || path.starts_with("https://") || path.starts_with("data:") {
        return path.to_string();
    }
    if path.starts_with('/') {
        format!("{host}{path}")
    } else {
        format!("{host}/{path}")
    }
}

fn value_or(value: &str, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

fn peach_page(path: &str) -> i32 {
    let Some(index) = path.find("page=") else {
        return 1;
    };
    let rest = &path[index + 5..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    parse_int(&digits).max(1)
}

fn peach_image_url(path: &str) -> String {
    absolutize_host(PEACH_IMAGE_HOST, path)
}

fn peach_play_urls(path: &str) -> Vec<String> {
    PEACH_PLAY_HOSTS
        .iter()
        .map(|h| absolutize_host(h, path))
        .filter(|u| !u.is_empty())
        .collect()
}

fn peach_pubdate(item: &VideoItem) -> String {
    if item.remarks.is_empty() {
        return String::new();
    }
    match RE_PEACH_PUBDATE.find(&item.remarks) {
        Some(m) => m.as_str().replace('/', "-"),
        None => item.remarks.clone(),
    }
}

// ---- Episode / source helpers ----------------------------------------------

fn is_preferred_native_source(from: &str) -> bool {
    from.contains("m3u8")
        || from == "wolong"
        || from == "360zy"
        || from == "kuaikan"
        || from == "leshi"
        || from == "hw8"
        || from == "haiwaikan"
        || from == "dplayer"
}

fn episode_priority(ep: &Episode) -> i32 {
    let from = &ep.from;
    if is_preferred_native_source(from) {
        return 0;
    }
    if from.contains("m3u8")
        || from == "wolong"
        || from == "360zy"
        || from == "dplayer"
        || from == "haiwaikan"
    {
        return 1;
    }
    5
}

fn episode_source_priority(ep: &Episode) -> i32 {
    if !ep.from.is_empty() {
        return episode_priority(ep);
    }
    let name = &ep.source_name;
    if name.contains("国际") || name.contains("亚太") || name.contains("备用") || name.contains("海外") {
        0
    } else if name.contains("高清") {
        5
    } else {
        2
    }
}

fn episode_source_label(ep: &Episode) -> String {
    if !ep.source_name.is_empty() {
        return ep.source_name.clone();
    }
    if !ep.from.is_empty() {
        return if episode_priority(ep) <= 1 {
            "m3u8".to_string()
        } else {
            ep.from.clone()
        };
    }
    format!("线路{}", ep.source)
}

fn parse_source_names(html: &str) -> HashMap<i32, String> {
    let mut source_ids: Vec<i32> = Vec::new();
    for c in RE_LINK_SID.captures_iter(html) {
        let sid = parse_int(c.get(1).map(|m| m.as_str()).unwrap_or("0"));
        if sid > 0 && !source_ids.contains(&sid) {
            source_ids.push(sid);
        }
    }

    let mut names: Vec<String> = Vec::new();
    for c in RE_SOURCE_NAME.captures_iter(html) {
        let name = clean_text(c.get(1).map(|m| m.as_str()).unwrap_or(""));
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }

    let mut out = HashMap::new();
    let count = source_ids.len().min(names.len());
    for i in 0..count {
        out.insert(source_ids[i], names[i].clone());
    }
    out
}

// ---- SiteClient -------------------------------------------------------------

pub struct SiteClient {
    client: Client,
}

impl SiteClient {
    pub fn new(client: Client) -> Self {
        SiteClient { client }
    }

    pub fn fetch_catalog(&self, path: &str) -> Result<Vec<VideoItem>, String> {
        if path.starts_with(PEACH_PATH) {
            return self.fetch_peach_catalog(peach_page(path));
        }
        let html = fetch_text(&self.client, &absolutize(path), &format!("{BASE_URL}/"))?;
        let mut out: Vec<VideoItem> = Vec::new();
        let mut seen: Vec<String> = Vec::new();

        for m in RE_ANCHOR.find_iter(&html) {
            let tag = m.as_str();
            let href = attr(tag, "href");
            if href.is_empty() || !href.contains("/vodhtml/") {
                continue;
            }
            let cls = attr(tag, "class");
            let mut title = attr(tag, "title");
            if title.is_empty()
                && !cls.is_empty()
                && !cls.contains("hl-item-thumb")
                && !cls.contains("hl-br-thumb")
            {
                continue;
            }
            if title.is_empty() {
                title = clean_text(tag);
            }
            if title.is_empty() {
                continue;
            }
            let mut poster = attr(tag, "data-original");
            if poster.is_empty() {
                poster = background_url(tag);
            }
            let li_start = html[..m.start()].rfind("<li").unwrap_or(0);
            let li_end = html[m.end()..]
                .find("</li>")
                .map(|e| m.end() + e)
                .unwrap_or(html.len());
            let chunk = if li_end > li_start {
                &html[li_start..(li_end + 5).min(html.len())]
            } else {
                tag
            };
            let remarks = first_text(chunk, "remarks");
            let score = first_text(chunk, "score");
            let meta = if score.is_empty() {
                remarks.clone()
            } else {
                format!("{score}  {remarks}")
            };
            let url = absolutize(&href);
            if !seen.contains(&url) {
                seen.push(url.clone());
                out.push(VideoItem {
                    title,
                    url,
                    poster,
                    remarks: meta,
                    ..Default::default()
                });
            }
        }
        Ok(out)
    }

    pub fn fetch_detail(&self, item: &VideoItem) -> Result<VideoDetail, String> {
        if item.is_peach {
            return self.fetch_peach_detail(item);
        }
        let html = fetch_text(&self.client, &item.url, &format!("{BASE_URL}/"))?;

        let mut title = item.title.clone();
        let page_title = between(&html, "<title>", "</title>");
        if !page_title.is_empty() {
            if let Some(left) = page_title.find('《') {
                if let Some(right) = page_title[left + '《'.len_utf8()..].find('》') {
                    title = page_title[left + '《'.len_utf8()..left + '《'.len_utf8() + right].to_string();
                }
            }
        }

        let mut poster = first_meta(&html, "og:image");
        if poster.is_empty() {
            poster = item.poster.clone();
        }
        let desc = first_meta(&html, "description");
        let meta = collect_meta(&html);
        let source_names = parse_source_names(&html);

        let mut episodes: Vec<Episode> = Vec::new();
        let mut unique: Vec<String> = Vec::new();
        for c in RE_PLAY_LINK.captures_iter(&html) {
            let href = c.get(1).map(|m| m.as_str()).unwrap_or("").to_string();
            let sid = parse_int(c.get(3).map(|m| m.as_str()).unwrap_or("0"));
            let nid = parse_int(c.get(4).map(|m| m.as_str()).unwrap_or("0"));
            let mut text = clean_text(c.get(5).map(|m| m.as_str()).unwrap_or(""));
            if text.is_empty() {
                text = format!("第{nid}集");
            }
            if sid > 1 && !text.contains("线路") {
                text = format!("线路{sid} {text}");
            }
            let path = absolutize(&href);
            let source_name = source_names.get(&sid).cloned().unwrap_or_default();
            if !unique.contains(&path) {
                unique.push(path.clone());
                episodes.push(Episode {
                    title: text,
                    path,
                    source: sid,
                    index: nid,
                    from: String::new(),
                    source_name,
                });
            }
        }
        episodes.sort_by(|a, b| {
            let e = a.index.cmp(&b.index);
            if e != std::cmp::Ordering::Equal {
                return e;
            }
            let p = episode_source_priority(a).cmp(&episode_source_priority(b));
            if p != std::cmp::Ordering::Equal {
                return p;
            }
            a.source.cmp(&b.source)
        });

        Ok(VideoDetail {
            title,
            poster,
            description: desc,
            meta,
            episodes,
        })
    }

    pub fn resolve_play_target(&self, episode: &Episode) -> Result<PlayTarget, String> {
        if episode.from == "peach" {
            return Ok(PlayTarget {
                title: episode.title.clone(),
                web_url: episode.path.clone(),
                direct_url: episode.path.clone(),
                from: "peach".to_string(),
            });
        }
        let play_html = fetch_text(&self.client, &episode.path, &format!("{BASE_URL}/"))?;
        let iframe = first_iframe(&play_html);
        let player_html = if iframe.is_empty() {
            play_html
        } else {
            fetch_text(&self.client, &absolutize(&iframe), &episode.path)?
        };

        let mut raw_url = player_value(&player_html, "url");
        let from = player_value(&player_html, "from");
        let title = episode.title.clone();

        if !raw_url.is_empty() {
            raw_url = raw_url.replace("\\/", "/");
            if raw_url.starts_with("//") {
                raw_url = format!("https:{raw_url}");
            }
            if is_direct(&raw_url) {
                return Ok(PlayTarget {
                    title,
                    web_url: episode.path.clone(),
                    direct_url: raw_url,
                    from,
                });
            }
        }
        Ok(PlayTarget {
            title,
            web_url: episode.path.clone(),
            direct_url: String::new(),
            from,
        })
    }

    // ---- Peach API ----------------------------------------------------------

    fn fetch_peach_catalog(&self, page: i32) -> Result<Vec<VideoItem>, String> {
        let url = format!(
            "{PEACH_API_BASE}/api/vod/video?site_id={PEACH_SITE_ID}&channel_id={PEACH_CHANNEL_ID}&channel_name={}&page={page}&per_page=24",
            urlencode(PEACH_CHANNEL_NAME)
        );
        let data = self.fetch_peach_data(&url, "")?;
        let mut out = Vec::new();
        let Some(items) = data.get("items").and_then(|v| v.as_array()) else {
            return Ok(out);
        };
        for it in items {
            let id = str_val(it, "id");
            let title = str_val(it, "name");
            let poster = peach_image_url(&str_val(it, "pic"));
            let play_url = str_val(it, "play_url");
            let duration = str_val(it, "duration");
            let pubdate = str_val(it, "pubdate");
            let meta = if duration.is_empty() {
                pubdate.clone()
            } else if pubdate.is_empty() {
                duration.clone()
            } else {
                format!("{duration}  {pubdate}")
            };
            if !id.is_empty() && !title.is_empty() {
                out.push(VideoItem {
                    title,
                    url: format!("{PEACH_PATH}/detail/{id}"),
                    poster,
                    remarks: meta,
                    provider: "peach".to_string(),
                    remote_id: id,
                    play_url,
                    is_peach: true,
                    ..Default::default()
                });
            }
        }
        out.sort_by(|a, b| peach_pubdate(b).cmp(&peach_pubdate(a)));
        Ok(out)
    }

    fn fetch_peach_detail(&self, item: &VideoItem) -> Result<VideoDetail, String> {
        let mut data = serde_json::Value::Null;
        if !item.remote_id.is_empty() {
            let url = format!(
                "{PEACH_API_BASE}/api/vod/video/{}?site_id={PEACH_SITE_ID}&channel_id={PEACH_CHANNEL_ID}&channel_name={}",
                item.remote_id,
                urlencode(PEACH_CHANNEL_NAME)
            );
            data = match self.fetch_peach_data(&url, "") {
                Ok(d) => d,
                Err(_) => serde_json::Value::Null,
            };
        }
        let title = value_or(&str_val(&data, "name"), &item.title);
        let poster = peach_image_url(&value_or(&str_val(&data, "pic"), &item.poster));
        let play_path = value_or(&str_val(&data, "play_url"), &item.play_url);
        let play_urls = peach_play_urls(&play_path);
        let desc = value_or(&str_val(&data, "description"), &title);
        let duration = str_val(&data, "duration");
        let pubdate = str_val(&data, "pubdate");
        let meta = if duration.is_empty() {
            pubdate.clone()
        } else if pubdate.is_empty() {
            duration.clone()
        } else {
            format!("{duration}  {pubdate}")
        };
        let episodes: Vec<Episode> = play_urls
            .iter()
            .enumerate()
            .map(|(i, u)| Episode {
                title: "播放".to_string(),
                path: u.clone(),
                source: (i + 1) as i32,
                index: 1,
                from: "peach".to_string(),
                source_name: format!("线路{}", i + 1),
            })
            .collect();
        Ok(VideoDetail {
            title,
            poster,
            description: desc,
            meta,
            episodes,
        })
    }

    fn fetch_peach_data(&self, url: &str, referer: &str) -> Result<serde_json::Value, String> {
        let raw = fetch_text(&self.client, url, referer)?;
        let payload: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let encrypted = payload.get("x-data").and_then(|v| v.as_str()).unwrap_or("");
        let body: serde_json::Value = if encrypted.is_empty() {
            payload
        } else {
            let plain = fernet_decrypt(encrypted, PEACH_FERNET_KEY)?;
            serde_json::from_str(&plain).map_err(|e| e.to_string())?
        };
        if body.get("code").and_then(|c| c.as_i64()).unwrap_or(0) != 0 {
            return Err(
                body.get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("API error")
                    .to_string(),
            );
        }
        Ok(body.get("data").cloned().unwrap_or(serde_json::json!({})))
    }
}

fn str_val(v: &serde_json::Value, key: &str) -> String {
    // Mirror the Android JSONObject.optString: strings, numbers and booleans
    // are all coerced to their string form (the peach API returns e.g. "id"
    // as a number).
    match v.get(key) {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        Some(serde_json::Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

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

// ---- Update checking --------------------------------------------------------

pub fn normalize_version_name(tag: &str) -> String {
    let mut v = tag.trim().to_string();
    if v.starts_with('v') || v.starts_with('V') {
        v.remove(0);
    }
    v
}

fn version_parts(version_name: &str) -> Vec<i32> {
    RE_VERSION_PARTS
        .captures_iter(version_name)
        .map(|c| parse_int(c.get(1).map(|m| m.as_str()).unwrap_or("0")))
        .collect()
}

pub fn compare_version_names(left: &str, right: &str) -> i32 {
    let a = version_parts(left);
    let b = version_parts(right);
    let count = a.len().max(b.len());
    for i in 0..count {
        let av = a.get(i).copied().unwrap_or(0);
        let bv = b.get(i).copied().unwrap_or(0);
        if av != bv {
            return if av > bv { 1 } else { -1 };
        }
    }
    0
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version_name: String,
    pub asset_name: String,
    pub asset_url: String,
    pub source_name: String,
    pub release_url: String,
    pub has_newer_version: bool,
    pub current_version: String,
}

const UPDATE_ASSET_PREFIX: &str = "Ziwen-Player";
const UPDATE_ASSET_SUFFIX: &str = ".exe";

pub fn fetch_latest_update(
    client: &Client,
    api_url: &str,
    source_name: &str,
    current_version: &str,
) -> Result<UpdateInfo, String> {
    let raw = fetch_text(client, api_url, "")?;
    let release: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let tag = release.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
    let version_name = normalize_version_name(tag);

    let mut asset_url = String::new();
    let mut asset_name = String::new();
    if let Some(assets) = release.get("assets").and_then(|v| v.as_array()) {
        for asset in assets {
            let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.starts_with(UPDATE_ASSET_PREFIX) && name.ends_with(UPDATE_ASSET_SUFFIX) {
                asset_name = name.to_string();
                asset_url = asset
                    .get("browser_download_url")
                    .and_then(|v| v.as_str())
                    .or_else(|| asset.get("download_url").and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .to_string();
                break;
            }
        }
    }

    Ok(UpdateInfo {
        has_newer_version: compare_version_names(&version_name, current_version) > 0,
        current_version: current_version.to_string(),
        version_name,
        asset_name,
        asset_url,
        source_name: source_name.to_string(),
        release_url: release
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}
