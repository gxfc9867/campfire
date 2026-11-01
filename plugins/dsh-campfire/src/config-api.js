/**
 * 配置读写接口（给 DSH 设置面板用）。
 *
 * 为什么需要它：DSH 不会根据 Config schema 自动渲染表单，插件的配置面板
 * 必须自己画、自己读写。写文件这件事只能发生在服务端，所以这里开两个
 * 路由给 client 端调。
 *
 * 边界：
 * - 只读写本插件自己的配置文件（默认 $DSH_HOME/campfire/config.json）；
 * - token 永远不回传明文，只回「是否已配置」+ 末四位；
 * - 改完不热重启拉流：返回 needRestart，由用户重启 DSH 生效。
 *   热重启要拆 bridge 的生命周期，风险比收益大，先不做。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** 可经界面修改的字段白名单。别的字段一律不碰。 */
const EDITABLE = [
  'baseUrl',
  'token',
  'memberHandle',
  'chatIds',
  'cwd',
  'sessionScope',
  'wait',
  'replyTimeoutMs',
  'tokenEnv',
  'tokenFile',
  'provider',
  'model',
  'logLevel',
];

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** token 只回末四位，够用户确认「填的是哪一把」，又不至于泄露。 */
function maskToken(token) {
  const t = String(token || '');
  if (!t) return '';
  if (t.length <= 8) return '••••';
  return `••••${t.slice(-4)}`;
}

async function readFileConfig(configFile) {
  try {
    const raw = await fs.readFile(configFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`配置文件读取失败：${error.message}`);
  }
}

/**
 * @param {any} ctx Cordis 上下文
 * @param {{ configFile: string, resolved: Record<string, any>, log: (lvl: string, msg: string) => void }} options
 */
export function registerConfigRoutes(ctx, { configFile, resolved, log = () => {} }) {
  if (!ctx?.webServer?.register) {
    log('warn', '宿主没有 webServer 服务，配置面板将不可用（可继续用配置文件）');
    return false;
  }

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/campfire/config',
    handler: async (req, res) => {
      try {
        if ((req.method || 'GET').toUpperCase() === 'GET') {
          const saved = await readFileConfig(configFile).catch(() => ({}));
          const effective = { ...resolved, ...saved };
          const out = {};
          for (const key of EDITABLE) {
            if (key === 'token') {
              out.token = maskToken(effective.token);
              out.hasToken = Boolean(effective.token);
            } else {
              out[key] = effective[key];
            }
          }
          sendJson(res, 200, {
            ok: true,
            configFile,
            config: out,
          });
          return;
        }

        if ((req.method || '').toUpperCase() === 'POST') {
          const body = await readBody(req);
          const patch = {};
          for (const key of EDITABLE) {
            if (body[key] !== undefined) patch[key] = body[key];
          }
          // token 传空或传回掩码值 = 不修改（避免用户为了改别的字段把令牌清掉）
          if (typeof patch.token === 'string') {
            const t = patch.token.trim();
            if (!t || t.startsWith('••••')) delete patch.token;
            else patch.token = t;
          }
          if (patch.chatIds !== undefined) {
            patch.chatIds = Array.isArray(patch.chatIds)
              ? patch.chatIds.map((x) => String(x).trim()).filter(Boolean)
              : String(patch.chatIds)
                  .split(',')
                  .map((x) => x.trim())
                  .filter(Boolean);
          }
          if (patch.baseUrl !== undefined) {
            const u = String(patch.baseUrl).trim().replace(/\/+$/, '');
            if (u && !/^https?:\/\//.test(u)) {
              sendJson(res, 400, { ok: false, error: '围炉地址需要以 http:// 或 https:// 开头' });
              return;
            }
            patch.baseUrl = u;
          }

          const current = await readFileConfig(configFile);
          const merged = { ...current, ...patch };

          // 保存前拿新配置探一次 /v1/quota：地址通不通、令牌认不认，当场告诉用户。
          // 注意不能用 /v1/meta —— 那个端点免鉴权，假令牌也会 200，验不出东西。
          const probe = { checked: false, ok: false, error: '' };
          if (merged.baseUrl && merged.token) {
            probe.checked = true;
            try {
              const res = await fetch(`${merged.baseUrl}/v1/quota`, {
                headers: { authorization: `Bearer ${merged.token}` },
                signal: AbortSignal.timeout(8000),
              });
              if (res.ok) {
                probe.ok = true;
              } else if (res.status === 401 || res.status === 403) {
                probe.error = '令牌无效或已被吊销（去围炉里重新生成一把）';
              } else {
                probe.error = `围炉返回 HTTP ${res.status}`;
              }
            } catch (e) {
              probe.error = `连不上围炉：${e?.message ?? e}`;
            }
          }

          /**
           * 填局域网 IP 却连不上时，自动试 127.0.0.1。
           *
           * DSH 若跑在容器里（尤其 host 网络），宿主机 IP 常常访问不到，只有
           * 127.0.0.1 通。与其让用户回去猜，不如这里直接试一次，通了就把地址
           * 改过来并说明原因。
           */
          if (!probe.ok && merged.baseUrl && merged.token) {
            try {
              const u = new URL(merged.baseUrl);
              if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
                const altUrl = `http://127.0.0.1${u.port ? `:${u.port}` : ''}`;
                const altRes = await fetch(`${altUrl}/v1/quota`, {
                  headers: { authorization: `Bearer ${merged.token}` },
                  signal: AbortSignal.timeout(6000),
                });
                if (altRes.ok) {
                  probe.ok = true;
                  probe.error = '';
                  probe.originalBaseUrl = merged.baseUrl;
                  probe.baseUrl = altUrl;
                  probe.hint = `已自动改用 ${altUrl}——DSH 跑在容器里时，局域网 IP 通常访问不到。`;
                  merged.baseUrl = altUrl;
                }
              }
            } catch {
              // 端口解析失败之类，忽略，保留原结论
            }
          }

          await fs.mkdir(path.dirname(configFile), { recursive: true });
          await fs.writeFile(configFile, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
          log('info', `配置已写入 ${configFile}`);

          let message;
          if (!probe.checked) message = '已保存。重启 DSH 后生效。';
          else if (probe.ok) {
            message = probe.hint
              ? `已保存。${probe.hint} 重启 DSH 后生效。`
              : '已保存，令牌验证通过。重启 DSH 后生效。';
          } else message = `已保存，但验证没通过：${probe.error}`;

          sendJson(res, 200, { ok: true, needRestart: true, probe, message });
          return;
        }

        sendJson(res, 405, { ok: false, error: '只支持 GET / POST' });
      } catch (error) {
        log('warn', `配置接口出错：${error?.message ?? error}`);
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });

  log('info', '配置接口已挂载：GET/POST /api/campfire/config');
  return true;
}
