#!/usr/bin/env node
// Zips game/ into dist/ukraine-road-clicker-itch.zip for an itch.io HTML5 upload
// (index.html at the zip root). Node built-ins only. Fails if itch.io limits are exceeded:
// ≤ 1000 files, < 500 MB extracted, no file ≥ 200 MB.
//   node tools/package-itch.mjs   (or: npm run package-itch)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'game');
const OUT = path.join(ROOT, 'dist', 'ukraine-road-clicker-itch.zip');
const MAX_FILES = 1000, MAX_TOTAL = 500 * 1024 * 1024, MAX_FILE = 200 * 1024 * 1024;
const SKIP = /^(\..*|Thumbs\.db|desktop\.ini|.*~|.*\.(bak|tmp|swp|log)|.*-test\.html|sprites(-[a-z]+)?\.html)$/i;   // dev-only / OS junk

function die(msg) { console.error('✖ ' + msg); process.exit(1); }

const files = [];
(function walk(dir, rel) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.test(ent.name)) continue;
    const abs = path.join(dir, ent.name), r = rel ? rel + '/' + ent.name : ent.name;
    if (ent.isDirectory()) walk(abs, r);
    else if (ent.isFile()) files.push({ abs, rel: r, size: fs.statSync(abs).size });
  }
})(SRC, '');

if (!files.some(f => f.rel === 'index.html')) die('game/index.html is missing — itch.io needs index.html at the zip root');
const total = files.reduce((s, f) => s + f.size, 0);
const big = files.filter(f => f.size >= MAX_FILE);
if (files.length > MAX_FILES) die(`${files.length} files — itch.io allows at most ${MAX_FILES}`);
if (total >= MAX_TOTAL) die(`${(total / 1048576).toFixed(1)} MB extracted — itch.io limit is 500 MB`);
if (big.length) die(`files over 200 MB: ${big.map(f => f.rel).join(', ')}`);
// itch serves from a case-sensitive file system: two names differing only in case would clash
const lower = new Map();
for (const f of files) {
  const k = f.rel.toLowerCase();
  if (lower.has(k)) die(`case clash: ${lower.get(k)} vs ${f.rel}`);
  lower.set(k, f.rel);
}

// ---- minimal ZIP writer (deflate, UTF-8 names, no zip64: sizes are far below 4 GB) ----
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
const chunks = [], central = [];
let offset = 0;
for (const f of files) {
  const data = fs.readFileSync(f.abs);
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const store = deflated.length >= data.length;
  const body = store ? data : deflated;
  const name = Buffer.from(f.rel, 'utf8');
  const crc = zlib.crc32(data) >>> 0;
  const { time, date } = dosTime(fs.statSync(f.abs).mtime);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(store ? 0 : 8, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
  cen.writeUInt16LE(store ? 0 : 8, 10); cen.writeUInt16LE(time, 12); cen.writeUInt16LE(date, 14);
  cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
  chunks.push(local, name, body);
  central.push(cen, name);
  offset += 30 + name.length + body.length;
}
const cenSize = central.reduce((s, b) => s + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cenSize, 12); end.writeUInt32LE(offset, 16);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([...chunks, ...central, end]));

console.log(`✔ ${path.relative(ROOT, OUT)} — ${files.length} files, ${(total / 1048576).toFixed(2)} MB extracted, ` +
  `${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB zipped (limits: ${MAX_FILES} files, 500 MB, 200 MB/file)`);
