'use strict';

/**
 * Minimal disk cache for video segments / cover images, mirroring the Android
 * app's 1GB ExoPlayer SimpleCache. Entries are keyed by URL hash, stored as
 * `<hash>` (bytes) + `<hash>.meta` (JSON with content-type), and evicted
 * least-recently-used when the total exceeds `maxBytes`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class DiskCache {
  constructor(dir, maxBytes = 1024 * 1024 * 1024) {
    this.dir = dir;
    this.maxBytes = maxBytes;
  }

  keyFor(url) {
    return crypto.createHash('sha1').update(String(url)).digest('hex');
  }

  dataFile(url) {
    return path.join(this.dir, this.keyFor(url));
  }

  metaFile(url) {
    return path.join(this.dir, this.keyFor(url) + '.meta');
  }

  /** @returns {{data:Buffer, contentType:string}|null} */
  get(url) {
    try {
      const file = this.dataFile(url);
      if (!fs.existsSync(file)) return null;
      const data = fs.readFileSync(file);
      let contentType = '';
      try {
        contentType = JSON.parse(fs.readFileSync(this.metaFile(url), 'utf8')).contentType || '';
      } catch (e) {
        // ignore missing/invalid meta
      }
      // Touch mtime so LRU eviction keeps recently-used entries.
      const now = new Date();
      try {
        fs.utimesSync(file, now, now);
      } catch (e) {
        // ignore
      }
      return { data, contentType };
    } catch (e) {
      return null;
    }
  }

  put(url, data, contentType) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.dataFile(url), data);
      fs.writeFileSync(this.metaFile(url), JSON.stringify({ contentType: contentType || '' }));
      this.evict();
    } catch (e) {
      // ignore write failures (cache is best-effort)
    }
  }

  evict() {
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((f) => !f.endsWith('.meta'))
        .map((f) => {
          const p = path.join(this.dir, f);
          const st = fs.statSync(p);
          return { p, mtime: st.mtimeMs, size: st.size };
        });
      let total = files.reduce((s, f) => s + f.size, 0);
      if (total <= this.maxBytes) return;
      files.sort((a, b) => a.mtime - b.mtime); // oldest first
      for (const f of files) {
        if (total <= this.maxBytes) break;
        try {
          fs.unlinkSync(f.p);
          try {
            fs.unlinkSync(f.p + '.meta');
          } catch (e) {
            // ignore
          }
          total -= f.size;
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      // ignore
    }
  }

  size() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => !f.endsWith('.meta'))
        .reduce((s, f) => {
          try {
            return s + fs.statSync(path.join(this.dir, f)).size;
          } catch (e) {
            return s;
          }
        }, 0);
    } catch (e) {
      return 0;
    }
  }

  clear() {
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch (e) {
      // ignore
    }
  }
}

module.exports = { DiskCache };
