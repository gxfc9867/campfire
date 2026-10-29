import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * 离线签发 DSH Web Cookie（无需 docker 日志 / token / cron）。
 * 仅与 DSH 客户端连接协议的 cookie 结构对齐，供 NAS 端 RPC 使用。
 * 密钥来自环境变量 BRIDGE_NAS_SECRET，或从凭据文件中读取指定的记录。
 */

function readSecretFromCredentials(file, recordName) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let inRec = false;
  let kind = null;
  let version = null;
  let secret = null;
  for (const line of lines) {
    if (line.trim() === recordName + ':') {
      inRec = true;
      continue;
    }
    if (!inRec) continue;
    if (/^\S/.test(line)) break;
    const k = line.match(/^\s+kind:\s*(\S+)\s*$/);
    const v = line.match(/^\s+version:\s*(\d+)\s*$/);
    const s = line.match(/^\s+secret:\s*(\S+)\s*$/);
    if (k) kind = k[1];
    if (v) version = Number(v[1]);
    if (s) secret = s[1];
  }
  return { kind, version, secret };
}

function resolveSecret(env) {
  if (env.BRIDGE_NAS_SECRET) return env.BRIDGE_NAS_SECRET;
  const credFile = env.BRIDGE_NAS_CREDENTIALS || '/cred/credentials.yaml';
  const recordName = env.BRIDGE_NAS_SECRET_RECORD || 'client-connection/browser-session';
  if (!fs.existsSync(credFile)) return null;
  const rec = readSecretFromCredentials(credFile, recordName);
  if (rec.kind !== 'grant') throw new Error(`凭据记录 kind 不是 grant（实际 ${rec.kind}）`);
  if (rec.version !== 1) throw new Error(`payload.version 不是 1（实际 ${rec.version}）`);
  return rec.secret || null;
}

/**
 * 生成 DSH 认证 Cookie 字符串。
 * @param {string} authority 形如 "127.0.0.1:3081"
 * @param {object} env 环境变量（用于取密钥与天数）
 */
export function mintCookie(authority, env = process.env) {
  const secretB64 = resolveSecret(env);
  if (!secretB64) throw new Error('缺少签发 NAS Cookie 的密钥（BRIDGE_NAS_SECRET 或凭据文件）');
  const secret = Buffer.from(secretB64, 'base64url');
  if (secret.length !== 32) throw new Error('secret 解码后不是 32 字节');
  const days = Number(env.BRIDGE_COOKIE_DAYS || 30);
  const issuedAt = Date.now() - 60000; // 回拨 60 秒，防时钟误差
  const expiresAt = issuedAt + days * 86400000;
  const payload = { version: 1, authority, issuedAt, expiresAt };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const name = 'dsh-auth-' + crypto.createHash('sha256').update(authority).digest('base64url');
  return `${name}=v1.${body}.${sig}`;
}
