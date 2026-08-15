'use strict';
// Generate Tauri icon set (32/128/256/512 PNG + 256 ICO) — dark tile + gold play triangle.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [16, 19, 24];
const ACCENT = [247, 200, 67];

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, c]);
}

function buildPng(S) {
  const margin = Math.round(S / 32);
  const radius = Math.round(S * 0.1875);
  const x0 = margin, y0 = margin, x1 = S - margin, y1 = S - margin;
  const tri = [
    [96 * S / 256, 74 * S / 256],
    [96 * S / 256, 182 * S / 256],
    [196 * S / 256, 128 * S / 256],
  ];
  function sign(px, py, ax, ay, bx, by) {
    return (px - bx) * (ay - by) - (ax - bx) * (py - by);
  }
  function inTri(px, py) {
    const d1 = sign(px, py, tri[0][0], tri[0][1], tri[1][0], tri[1][1]);
    const d2 = sign(px, py, tri[1][0], tri[1][1], tri[2][0], tri[2][1]);
    const d3 = sign(px, py, tri[2][0], tri[2][1], tri[0][0], tri[0][1]);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  }
  function inRound(x, y) {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = x < x0 + radius ? x0 + radius : x > x1 - radius ? x1 - radius : x;
    const cy = y < y0 + radius ? y0 + radius : y > y1 - radius ? y1 - radius : y;
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy <= radius * radius) return true;
    return (x >= x0 + radius && x <= x1 - radius) || (y >= y0 + radius && y <= y1 - radius);
  }
  function pixel(x, y) {
    if (!inRound(x, y)) return [0, 0, 0, 0];
    if (inTri(x + 0.5, y + 0.5)) return [ACCENT[0], ACCENT[1], ACCENT[2], 255];
    return [BG[0], BG[1], BG[2], 255];
  }

  const stride = S * 4 + 1;
  const raw = Buffer.alloc(S * stride);
  for (let y = 0; y < S; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < S; x++) {
      const p = pixel(x, y);
      const off = row + 1 + x * 4;
      raw[off] = p[0]; raw[off + 1] = p[1]; raw[off + 2] = p[2]; raw[off + 3] = p[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function wrapIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

const outDir = path.join(__dirname, 'src-tauri', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const p256 = buildPng(256);
fs.writeFileSync(path.join(outDir, '32x32.png'), buildPng(32));
fs.writeFileSync(path.join(outDir, '128x128.png'), buildPng(128));
fs.writeFileSync(path.join(outDir, '128x128@2x.png'), p256);
fs.writeFileSync(path.join(outDir, 'icon.png'), buildPng(512));
fs.writeFileSync(path.join(outDir, 'icon.ico'), wrapIco(p256));
console.log('icons written to', outDir);
