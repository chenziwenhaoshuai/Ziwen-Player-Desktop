//! Permissive HTTP client mirroring the Android app's trust-all networking.

use std::time::Duration;

use reqwest::blocking::{Client, Response};

const USER_AGENT: &str =
    "Mozilla/5.0 (Linux; Android TV) AppleWebKit/537.36 YfVodTVNative/1.0";

pub fn new_client() -> Client {
    Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(20))
        .user_agent(USER_AGENT)
        .build()
        .expect("failed to build HTTP client")
}

pub fn get(client: &Client, url: &str, referer: &str) -> Result<Response, String> {
    let mut req = client
        .get(url)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml,image/avif,image/webp,image/*,*/*;q=0.8",
        );
    if !referer.is_empty() {
        req = req.header("Referer", referer);
    }
    req.send().map_err(|e| e.to_string())
}

pub fn fetch_text(client: &Client, url: &str, referer: &str) -> Result<String, String> {
    let resp = get(client, url, referer)?;
    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    String::from_utf8(bytes.to_vec()).map_err(|e| e.to_string())
}
