#!/usr/bin/env node
/**
 * 零依赖 ZIP 打包器（STORE，条目名一律正斜杠，符合 ZIP 规范）
 * 用法：node make-zip.mjs <源目录> <输出.zip>
 * 背景：PowerShell 5.1 Compress-Archive 的条目名用反斜杠，部分解包器不认。
 */
import fs from 'node:fs';
import path from 'node:path';

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage: node make-zip.mjs <dir> <out.zip>'); process.exit(1); }

// CRC32
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function walk(dir, base = dir, list = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, base, list);
    else list.push({ rel: path.relative(base, full).split(path.sep).join('/'), full });
  }
  return list;
}

const files = walk(src).sort((a, b) => a.rel.localeCompare(b.rel));
const chunks = [];
const central = [];
let offset = 0;
// 固定 DOS 时间：2026-11-12 00:00
const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (11 << 5) | 12;

for (const { rel, full } of files) {
  const data = fs.readFileSync(full);
  const name = Buffer.from(rel, 'utf8');
  const crc = crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);          // version needed
  lh.writeUInt16LE(0x0800, 6);      // flags: UTF-8 names
  lh.writeUInt16LE(0, 8);           // method: store
  lh.writeUInt16LE(dosTime, 10);
  lh.writeUInt16LE(dosDate, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(data.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(name.length, 26);
  lh.writeUInt16LE(0, 28);
  chunks.push(lh, name, data);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);          // version made by
  ch.writeUInt16LE(20, 6);          // version needed
  ch.writeUInt16LE(0x0800, 8);
  ch.writeUInt16LE(0, 10);
  ch.writeUInt16LE(dosTime, 12);
  ch.writeUInt16LE(dosDate, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(data.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(name.length, 28);
  // extra/comment/disk/attrs = 0
  ch.writeUInt32LE(offset, 42);
  central.push(Buffer.concat([ch, name]));
  offset += lh.length + name.length + data.length;
}

const cd = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cd.length, 12);
eocd.writeUInt32LE(offset, 16);
fs.writeFileSync(out, Buffer.concat([...chunks, cd, eocd]));
console.log(`${out}: ${files.length} files`);
for (const f of files) console.log('  ' + f.rel);