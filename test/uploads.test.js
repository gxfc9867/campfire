import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  Uploads,
  ALLOWED_MIME,
  guessMime,
  safeDisplayName,
  imageSize,
  publicAttachment,
} from '../src/uploads.js';

// 真实的 1x1 图片，用来验证尺寸解析
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const GIF_1x1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cf-up-'));
}

const silent = { info: () => {}, warn: () => {}, debug: () => {} };

// ── 类型与命名 ──────────────────────────────────────────────────────

test('guessMime 按扩展名猜，猜不出返回空串（表示拒绝）', () => {
  assert.equal(guessMime('a.png'), 'image/png');
  assert.equal(guessMime('a.JPG'), 'image/jpeg');
  assert.equal(guessMime('a.pdf'), 'application/pdf');
  assert.equal(guessMime('a.unknown'), '');
  assert.equal(guessMime('a.unknown', 'text/plain'), 'text/plain');
});

test('safeDisplayName 去掉控制字符与路径', () => {
  assert.equal(safeDisplayName('../../etc/passwd'), 'passwd');
  assert.equal(safeDisplayName('a\u0000b.png'), 'ab.png');
  assert.equal(safeDisplayName(''), 'file');
  assert.ok(safeDisplayName('x'.repeat(300)).length <= 120);
});

// ── 尺寸解析 ────────────────────────────────────────────────────────

test('imageSize：PNG', () => {
  const s = imageSize(PNG_1x1, 'image/png');
  assert.deepEqual(s, { width: 1, height: 1 });
});

test('imageSize：GIF', () => {
  const s = imageSize(GIF_1x1, 'image/gif');
  assert.deepEqual(s, { width: 1, height: 1 });
});

test('imageSize：不是图片返回 null，不抛错', () => {
  assert.equal(imageSize(Buffer.from('hello world'), 'image/png'), null);
  assert.equal(imageSize(Buffer.alloc(0), 'image/jpeg'), null);
  // 截断的 PNG 也不能炸
  assert.equal(imageSize(PNG_1x1.subarray(0, 10), 'image/png'), null);
});

// ── 保存 ────────────────────────────────────────────────────────────

test('save：正常保存并返回元数据', () => {
  const dir = tmpDir();
  const up = new Uploads({ dataDir: dir, log: silent });
  const saved = up.save({
    buffer: PNG_1x1,
    filename: 'photo.png',
    mime: 'image/png',
    chatId: 'main',
    uploader: 'user',
  });

  assert.match(saved.id, /^att_/);
  assert.equal(saved.name, 'photo.png');
  assert.equal(saved.mime, 'image/png');
  assert.equal(saved.size, PNG_1x1.length);
  assert.equal(saved.width, 1);
  assert.equal(saved.height, 1);
  assert.ok(saved.path.endsWith('.png'));
  assert.ok(fs.existsSync(path.join(up.root, saved.path)));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('save：拒绝不支持的类型', () => {
  const dir = tmpDir();
  const up = new Uploads({ dataDir: dir, log: silent });
  assert.throws(
    () =>
      up.save({
        buffer: Buffer.from('MZ'),
        filename: 'virus.exe',
        mime: 'application/x-msdownload',
        chatId: 'main',
        uploader: 'user',
      }),
    /不支持的文件类型/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('save：空文件被拒', () => {
  const dir = tmpDir();
  const up = new Uploads({ dataDir: dir, log: silent });
  assert.throws(
    () => up.save({ buffer: Buffer.alloc(0), filename: 'a.png', mime: 'image/png', chatId: 'main' }),
    /空/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('save：超过上限被拒', () => {
  const dir = tmpDir();
  const up = new Uploads({ dataDir: dir, maxBytes: 10, log: silent });
  assert.throws(
    () => up.save({ buffer: Buffer.alloc(100), filename: 'a.txt', mime: 'text/plain', chatId: 'main' }),
    /超过上限/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('save：没给 mime 时按文件名猜', () => {
  const dir = tmpDir();
  const up = new Uploads({ dataDir: dir, log: silent });
  const saved = up.save({
    buffer: PNG_1x1,
    filename: 'x.png',
    mime: '',
    chatId: 'main',
    uploader: 'user',
  });
  assert.equal(saved.mime, 'image/png');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 读取与穿越防护 ──────────────────────────────────────────────────

test('read：读回写入的内容', () => {
  const dir = tmpDir();
  const up = new Uploads({ dataDir: dir, log: silent });
  const saved = up.save({
    buffer: Buffer.from('hello'),
    filename: 'a.txt',
    mime: 'text/plain',
    chatId: 'main',
    uploader: 'user',
  });
  assert.equal(up.read(saved.path).toString(), 'hello');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('read：目录穿越被拦住', () => {
  const dir = tmpDir();
  const up = new Uploads({ dataDir: dir, log: silent });
  assert.equal(up.read('../../etc/passwd'), null);
  assert.equal(up.read('/etc/passwd'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('remove：删掉文件；再删返回 false', () => {
  const dir = tmpDir();
  const up = new Uploads({ dataDir: dir, log: silent });
  const saved = up.save({
    buffer: Buffer.from('x'),
    filename: 'a.txt',
    mime: 'text/plain',
    chatId: 'main',
    uploader: 'user',
  });
  assert.equal(up.remove(saved.path), true);
  assert.equal(up.read(saved.path), null);
  assert.equal(up.remove(saved.path), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 对外视图 ────────────────────────────────────────────────────────

test('publicAttachment：不带磁盘路径，标出是不是图片', () => {
  const view = publicAttachment({
    id: 'att_1',
    name: 'a.png',
    mime: 'image/png',
    size: 10,
    width: 1,
    height: 1,
    path: '202611/att_1.png',
    chatId: 'main',
  });
  assert.equal(view.path, undefined);
  assert.equal(view.isImage, true);
  assert.equal(view.url, '/api/files/att_1');

  const file = publicAttachment({
    id: 'att_2',
    name: 'a.pdf',
    mime: 'application/pdf',
    size: 10,
    path: '202611/att_2.pdf',
  });
  assert.equal(file.isImage, false);
});

test('ALLOWED_MIME 覆盖图片与常见文档', () => {
  for (const m of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']) {
    assert.ok(ALLOWED_MIME.has(m), `${m} 应该在白名单里`);
  }
  assert.ok(!ALLOWED_MIME.has('application/x-msdownload'));
});
