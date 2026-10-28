import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 静态检查。
 *
 * 不做代码风格约束（那是个人自由），只检查三类会真出问题的事：
 * 1. 语法错误（比运行时才发现好）；
 * 2. 前端引用的资源不存在（404 在浏览器里很难看出来）；
 * 3. 硬编码的密钥或口令被提交进仓库。
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let problems = 0;

function fail(msg) {
  problems++;
  console.log(`  ✗ ${msg}`);
}

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'data' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

console.log('语法检查');
const jsFiles = walk(ROOT).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    fail(`${path.relative(ROOT, file)}: ${String(e.stderr || e.message).split('\n')[0]}`);
  }
}
if (problems === 0) ok(`${jsFiles.length} 个文件语法正确`);

console.log('前端资源引用');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !u.startsWith('http') && !u.includes('__BASE_PATH__'));

for (const ref of refs) {
  const target = path.join(ROOT, 'public', ref);
  if (!fs.existsSync(target)) fail(`index.html 引用了不存在的资源：${ref}`);
}
if (refs.length) ok(`index.html 的 ${refs.length} 个本地引用都存在`);

// JS 里 import 的相对路径也要能解析
const jsRefs = walk(path.join(ROOT, 'public', 'js'));
for (const file of jsRefs) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), m[1]);
    if (!fs.existsSync(target)) fail(`${path.relative(ROOT, file)} 引用了不存在的模块 ${m[1]}`);
  }
}
ok('前端模块引用检查完成');

console.log('预置头像');
const avatarDir = path.join(ROOT, 'public', 'avatars');
const count = fs.existsSync(avatarDir) ? fs.readdirSync(avatarDir).filter((f) => f.endsWith('.svg')).length : 0;
if (count < 24) fail(`预置头像只有 ${count} 个，应为 24 个（运行 npm run avatars）`);
else ok(`${count} 个预置头像`);

console.log('敏感信息扫描');
const SECRET_PATTERNS = [
  { re: /sk-[A-Za-z0-9]{20,}/, label: '疑似 API Key（sk-…）' },
  { re: /(?:password|passwd|secret|token)\s*[:=]\s*['"][^'"]{8,}['"]/i, label: '疑似硬编码口令' },
];
for (const file of jsFiles) {
  if (file.includes(`${path.sep}test${path.sep}`) || file.includes(`${path.sep}scripts${path.sep}`)) continue;
  const src = fs.readFileSync(file, 'utf8');
  for (const { re, label } of SECRET_PATTERNS) {
    const m = re.exec(src);
    if (m) fail(`${path.relative(ROOT, file)}: ${label} → ${m[0].slice(0, 40)}`);
  }
}
ok('敏感信息扫描完成');

console.log('');
if (problems) {
  console.log(`有 ${problems} 个问题`);
  process.exitCode = 1;
} else {
  console.log('检查通过');
}
