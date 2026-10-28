import fs from 'node:fs';
import path from 'node:path';

/**
 * 静态资源。
 * 无构建步骤：public/ 下的文件原样提供，浏览器用原生 ES 模块加载。
 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

/**
 * @returns {boolean} 是否已经处理（true 表示调用方不要再写响应）
 */
export function serveStatic(rootDir, req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';

  // 防目录穿越：规范化后必须仍在 rootDir 内
  let resolved = path.resolve(rootDir, rel);
  const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
  if (resolved !== rootDir && !resolved.startsWith(rootWithSep)) return false;

  let stat;
  try {
    stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      resolved = path.join(resolved, 'index.html');
      stat = fs.statSync(resolved);
    }
  } catch {
    return false;
  }

  const ext = path.extname(resolved).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  // HTML 永远不缓存（否则改了页面用户看不到），其余短缓存
  const cache = ext === '.html' ? 'no-cache' : 'public, max-age=60';

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': cache,
    ...SECURITY_HEADERS,
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  fs.createReadStream(resolved).pipe(res);
  return true;
}
