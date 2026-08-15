'use strict';

/**
 * Minimal HTTP(S) client used by the site scraper and the video/image proxy.
 * Mirrors the Android app's permissive networking: TLS verification is
 * disabled (`rejectUnauthorized: false`) because several upstream streaming
 * hosts serve self-signed / mismatched certificates, and the original app
 * falls back to a trust-all SSL context for exactly those hosts.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Linux; Android TV) AppleWebKit/537.36 YfVodTVNative/1.0';

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Perform a request and return { statusCode, headers, body }.
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {object} [options.headers={}]
 * @param {string} [options.referer='']
 * @param {boolean} [options.followRedirects=true]
 * @param {number} [options.maxRedirects=10]
 * @param {number} [options.timeout=20000]
 * @returns {Promise<{statusCode:number, headers:object, body:Buffer}>}
 */
function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    referer = '',
    followRedirects = true,
    maxRedirects = 10,
    timeout = 20000,
  } = options;

  return new Promise((resolve, reject) => {
    const doRequest = (currentUrl, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (e) {
        reject(e);
        return;
      }

      const lib = parsed.protocol === 'http:' ? http : https;
      const reqHeaders = {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept:
          'text/html,application/xhtml+xml,application/xml,image/avif,image/webp,image/*,*/*;q=0.8',
        ...headers,
      };
      if (referer && reqHeaders.Referer == null) {
        reqHeaders.Referer = referer;
      }

      const req = lib.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method,
          headers: reqHeaders,
          rejectUnauthorized: false,
        },
        (res) => {
          const status = res.statusCode || 0;
          const location = res.headers.location;
          if (
            followRedirects &&
            redirectsLeft > 0 &&
            REDIRECT_CODES.has(status) &&
            location
          ) {
            res.resume();
            let next;
            try {
              next = new URL(location, parsed).toString();
            } catch (e) {
              reject(e);
              return;
            }
            doRequest(next, redirectsLeft - 1);
            return;
          }

          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({ statusCode: status, headers: res.headers, body: Buffer.concat(chunks) })
          );
          res.on('error', reject);
        }
      );

      req.on('error', reject);
      req.setTimeout(timeout, () => req.destroy(new Error('Request timeout')));
      req.end();
    };

    doRequest(url, maxRedirects);
  });
}

/** Fetch a URL and return it as UTF-8 text. */
async function fetchText(url, referer = '', extraHeaders = {}) {
  const res = await request(url, { referer, headers: extraHeaders });
  return res.body.toString('utf8');
}

/** Fetch a URL and return it as a Buffer. */
async function fetchBuffer(url, referer = '', extraHeaders = {}) {
  const res = await request(url, { referer, headers: extraHeaders });
  return res.body;
}

module.exports = { request, fetchText, fetchBuffer, DEFAULT_USER_AGENT };
