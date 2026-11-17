#!/usr/bin/env node
/**
 * 围炉 MCP server —— 路径1：原生表单配置（MCP Elicitation）
 *
 * 提供工具 connect_campfire：被调用时向客户端请求一个三字段表单
 * （围炉地址 / 渠道令牌 / 成员名），拿到后调统一配置核心 configure.mjs。
 *
 * 这是"三个输入框"的正规实现，对齐 DSH 的围炉渠道设置面板。
 * 注意：Codex 桌面端个别版本对 elicitation 有已知 bug；若弹不出表单，
 * 用户可改用路径2（skill）或路径3（围炉网页命令）。
 */
import { createServer } from 'node:http';
// 纯 stdio MCP：用最简单的 JSON-RPC 帧处理，不依赖外部包。
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const configure = path.join(__dir, '..', 'adapter', 'configure.mjs');
let nextId = 1;
const pending = new Map();

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

// 向客户端发 elicitation/create 请求并等待答复
function elicit(message, schema) {
  return new Promise((resolve) => {
    const id = 'eli_' + (nextId++);
    pending.set(id, resolve);
    send({
      jsonrpc: '2.0', id, method: 'elicitation/create',
      params: { mode: 'form', message, requestedSchema: schema },
    });
    // 兜底：60 秒无答复按取消处理，避免永久卡死
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ action: 'cancel' }); }
    }, 60000);
  });
}

const TOOL_SCHEMA = {
  type: 'object',
  properties: {},
  required: [],
};

const FORM_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', title: '配置码', description: '把围炉接入引导里复制的那一整串 campfire://setup?... 粘进来' },
  },
  required: ['code'],
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // elicitation 的答复
  if (msg.id && String(msg.id).startsWith('eli_') && pending.has(msg.id)) {
    const resolve = pending.get(msg.id); pending.delete(msg.id);
    resolve(msg.result || { action: 'cancel' });
    return;
  }
  if (msg.method === 'notifications/initialized' || msg.method?.startsWith('notifications/')) return;

  const id = msg.id;
  const method = msg.method;
  const respond = (result) => send({ jsonrpc: '2.0', id, result });

  if (method === 'initialize') {
    return respond({
      protocolVersion: msg.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'campfire', version: '1.0.0' },
    });
  }
  if (method === 'tools/list') {
    return respond({ tools: [{
      name: 'connect_campfire',
      description: '把 GPT 桌面端接入围炉群聊。调用后弹出一个输入框，把围炉接入引导里复制的配置码整串粘进去即可，自动完成配置并启动适配器。',
      inputSchema: TOOL_SCHEMA,
    }] });
  }
  if (method === 'tools/call') {
    if (msg.params?.name !== 'connect_campfire' && msg.params?.arguments?.name !== 'connect_campfire') {
      return respond({ content: [{ type: 'text', text: '未知工具' }], isError: true });
    }
    const answer = await elicit(
      '接入围炉：把围炉接入引导里复制的「配置码」整串粘贴进来，点提交即可。',
      FORM_SCHEMA);
    if (answer.action !== 'accept' || !answer.content) {
      return respond({ content: [{ type: 'text', text: '已取消配置。' }] });
    }
    // 兼容：用户可能粘进 code 字段，也可能粘进任一字段；取第一个非空值
    const vals = Object.values(answer.content).map(String).filter(Boolean);
    const code = (answer.content.code || vals[0] || '').trim();
    if (!code.startsWith('campfire://setup?')) {
      return respond({ content: [{ type: 'text', text: '这不是配置码，请回围炉点「生成配置码」复制那一整串 campfire://setup?...' }], isError: true });
    }
    const r = spawnSync(process.execPath, [configure, '--code', code], { encoding: 'utf8' });
    const text = (r.stdout || '') + (r.stderr || '');
    return respond({ content: [{ type: 'text', text: text || '配置完成' }], isError: r.status !== 0 });
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
});
