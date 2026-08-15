'use strict';
// Stream-download winlibs mingw-w64 with retries (Node fetch via proxy, disk streaming).
const fs = require('fs');
const { Readable } = require('stream');

const API = 'https://api.github.com/repos/brechtsanders/winlibs_mingw/releases/latest';

async function getAssetUrl() {
  const rel = await (await fetch(API)).json();
  const asset = rel.assets.find((a) =>
    /winlibs-x86_64-posix-seh-gcc-.*-mingw-w64ucrt-.*\.7z$/i.test(a.name)
  );
  return asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null;
}

async function download(url, out, totalSize, retries) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`attempt ${i + 1}/${retries}: streaming...`);
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ws = fs.createWriteStream(out);
      let received = 0;
      let lastLog = 0;
      for await (const chunk of r.body) {
        ws.write(chunk);
        received += chunk.length;
        if (received - lastLog >= 20 * 1024 * 1024) {
          lastLog = received;
          console.log(`  ${(received / 1024 / 1024).toFixed(0)} MB`);
        }
      }
      await new Promise((res, rej) => {
        ws.end(() => res());
        ws.on('error', rej);
      });
      console.log(`  done: ${received} bytes`);
      if (received < 100000000) throw new Error('short download: ' + received);
      return true;
    } catch (e) {
      console.log('  failed:', e.message);
      try { fs.unlinkSync(out); } catch (_) {}
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return false;
}

(async () => {
  const asset = await getAssetUrl();
  if (!asset) {
    console.log('no asset found');
    process.exit(1);
  }
  console.log('asset:', asset.name, asset.size);
  const out = process.env.TEMP + '\\mingw64.7z';
  const ok = await download(asset.url, out, asset.size, 6);
  process.exit(ok ? 0 : 1);
})();
