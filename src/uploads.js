/**
 * 附件存储。
 *
 * 文件落在 `{dataDir}/uploads/{yyyymm}/{id}.{ext}`，元数据进 uploads 表。
 * 之所以不用对象存储：围炉的定位是「一个人自托管」，一个目录比一套 S3
 * 依赖好维护得多；要上云盘的话把 uploads 目录挂到网盘同步即可。
 *
 * 图片宽高自己解析文件头（PNG/JPEG/GIF/WebP），不引 sharp 之类的原生依赖——
 * 零依赖是这个项目的底线，前端拿到宽高只是为了让图片加载前先占好位置。
 */

import fs from 'node:fs';
import path from 'node:path';
import { shortId } from './id.js';

/** 允许的类型：图片 + 常见文档 + 纯文本。故意不做「任意文件」，
 *  免得围炉变成一个人的网盘，也让前端能按类型选渲染方式。
 *  注意这里**不含** application/octet-stream：那是「不知道是什么」的意思，
 *  放行它等于白名单失效。 */
export const ALLOWED_MIME = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
  ['application/pdf', 'pdf'],
  ['text/plain', 'txt'],
  ['text/markdown', 'md'],
  ['application/json', 'json'],
  ['application/zip', 'zip'],
]);

export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);

/** 从文件名猜 mime。fallback 传空串表示「猜不出就拒绝」。 */
export function guessMime(filename, fallback = '') {
  const ext = path.extname(String(filename || '')).toLowerCase();
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.zip': 'application/zip',
  };
  return map[ext] || fallback;
}

/** 去掉路径分隔符和危险字符，只留一个安全的展示名。 */
export function safeDisplayName(name) {
  const base = path.basename(String(name || 'file'));
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || 'file';
}

/**
 * 解析图片宽高。拿不到就返回 null——这只是「加载前占位」的优化，
 * 解析失败不该让整个上传失败。
 */
export function imageSize(buf, mime) {
  try {
    if (mime === 'image/png') {
      // PNG：8 字节签名 + 4 长度 + 4 类型，然后 IHDR 里是宽高（大端 uint32）
      if (buf.length < 24) return null;
      if (buf.readUInt32BE(0) !== 0x89504e47) return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/gif') {
      if (buf.length < 10) return null;
      const sig = buf.toString('ascii', 0, 3);
      if (sig !== 'GIF') return null;
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === 'image/jpeg') {
      if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        // SOF0/SOF1/SOF2...SOF15（排除 DHT=0xc4、JPG=0xc8、DAC=0xcc）
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
      return null;
    }
    if (mime === 'image/webp') {
      if (buf.length < 30) return null;
      if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
      const fmt = buf.toString('ascii', 12, 16);
      if (fmt === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (fmt === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (fmt === 'VP8X') {
        const w = buf.readUIntLE(24, 3) + 1;
        const h = buf.readUIntLE(27, 3) + 1;
        return { width: w, height: h };
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

export class Uploads {
  /**
   * @param {{ dataDir:string, maxBytes?:number, log?:object }} options
   */
  constructor({ dataDir, maxBytes = 25 * 1024 * 1024, log = console } = {}) {
    if (!dataDir) throw new TypeError('Uploads: dataDir 必填');
    this.root = path.join(dataDir, 'uploads');
    this.maxBytes = maxBytes;
    this.log = log;
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** 按月份分目录，避免单个目录堆几万个文件。 */
  #dirFor(now = Date.now()) {
    const d = new Date(now);
    const sub = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
    const dir = path.join(this.root, sub);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 保存一个上传。
   * @returns {{id, name, mime, size, path, width, height}}
   */
  save({ buffer, filename, mime, chatId, uploader }) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('save: buffer 必填');
    if (!buffer.length) throw new Error('文件是空的');
    if (buffer.length > this.maxBytes) {
      throw new Error(`文件超过上限 ${Math.round(this.maxBytes / 1024 / 1024)} MB`);
    }

    const declared = String(mime || '').toLowerCase();
    const finalMime = ALLOWED_MIME.has(declared) ? declared : guessMime(filename);
    if (!finalMime || !ALLOWED_MIME.has(finalMime)) {
      throw new Error(`不支持的文件类型：${declared || finalMime || '未知'}`);
    }

    const id = shortId('att_');
    const ext = ALLOWED_MIME.get(finalMime) || 'bin';
    const dir = this.#dirFor();
    const rel = path.relative(this.root, path.join(dir, `${id}.${ext}`));
    const abs = path.join(this.root, rel);
    fs.writeFileSync(abs, buffer);

    const size = imageSize(buffer, finalMime);
    return {
      id,
      name: safeDisplayName(filename),
      mime: finalMime,
      size: buffer.length,
      path: rel.split(path.sep).join('/'),
      width: size?.width ?? null,
      height: size?.height ?? null,
      chatId,
      uploader,
    };
  }

  /** 读文件本体；不存在返回 null。 */
  read(relPath) {
    const abs = this.#resolve(relPath);
    if (!abs) return null;
    try {
      return fs.readFileSync(abs);
    } catch {
      return null;
    }
  }

  /** 删文件（孤儿清理用）；删不掉不影响主流程。 */
  remove(relPath) {
    const abs = this.#resolve(relPath);
    if (!abs) return false;
    try {
      fs.unlinkSync(abs);
      return true;
    } catch {
      return false;
    }
  }

  /** 防目录穿越：解析后的路径必须还在 root 里。 */
  #resolve(relPath) {
    const target = path.resolve(this.root, String(relPath || ''));
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (target !== this.root && !target.startsWith(rootWithSep)) return null;
    return target;
  }
}

/** 给前端/插件看的附件视图（不含磁盘路径）。 */
export function publicAttachment(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    width: row.width ?? null,
    height: row.height ?? null,
    url: `/api/files/${row.id}`,
    isImage: IMAGE_MIMES.has(row.mime),
  };
}
