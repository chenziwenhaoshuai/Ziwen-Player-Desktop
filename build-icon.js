'use strict';

/**
 * Generate build/icon.ico (256x256) — a dark rounded tile with a gold play
 * triangle, matching the app's accent colours. Produces a PNG and wraps it in
 * an ICO container (PNG-compressed entry is valid for 256x256 icons).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 256;
const H = 256;
const BG = [16, 19, 24]; // #101318
const ACCENT = [247, 200, 67]; // #F7C843

// --- geometry ---------------------------------------------------------------
function sign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}
function inTriangle(px, py, a, b, c) {
  const d1 = sign(px, py, a[0], a[1], b[0], b[1]);
  const d2 = sign(px, py, b[0], b[1], c[0], c[1]);
  const d3 = sign(px, py, c[0], c[1], a[0], a[1]);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// Rounded-rect corner radius.
const radius = 48;
function inRoundedRect(x, y) {
  const x0 = 8;
  const y0 = 8;
  const x1 = W - 8;
  const y1 = H - 8;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  // corner circles
  const cx = x < x0 + radius ? x0 + radius : x > x1 - radius ? x1 - radius : x;
  const cy = y < y0 + radius ? y0 + radius : y > y1 - radius ? y1 - radius : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius || (x >= x0 + radius && x <= x1 - radius) || (y >= y0 + radius && y <= y1 - radius);
}

// --- pixels -----------------------------------------------------------------
const playTri = [
  [96, 74],
  [96, 182],
  [196, 128],
];

function pixel(x, y) {
  // transparent outside the rounded tile
  if (!inRoundedRect(x, y)) return [0, 0, 0, 0];
  if (inTriangle(x + 0.5, y + 0.5, playTri[0], playTri[1], playTri[2])) {
    return [ACCENT[0], ACCENT[1], ACCENT[2], 255];
  }
  return [BG[0], BG[1], BG[2], 255];
}

// --- PNG encoding -----------------------------------------------------------
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  // Fallback table-based CRC32.
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function buildPng() {
  const stride = W * 4 + 1;
  const raw = Buffer.alloc(H * stride);
  for (let y = 0; y < H; y++) {
    const row = y * stride;
    raw[row] = 0; // filter type: none
    for (let x = 0; x < W; x++) {
      const p = pixel(x, y);
      const off = row + 1 + x * 4;
      raw[off] = p[0];
      raw[off + 1] = p[1];
      raw[off + 2] = p[2];
      raw[off + 3] = p[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count

  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256
  entry[1] = 0; // height 256
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8); // size
  entry.writeUInt32LE(6 + 16, 12); // offset

  return Buffer.concat([header, entry, png]);
}

const outDir = path.join(__dirname, 'build');
fs.mkdirSync(outDir, { recursive: true });
const png = buildPng();
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(png));
console.log('wrote build/icon.png', png.length, 'bytes');
console.log('wrote build/icon.ico', buildIco(png).length, 'bytes');
