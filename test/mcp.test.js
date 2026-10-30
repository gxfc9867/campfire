process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

import assert from 'node:assert/strict';
import test from 'node:test';
import { makeApp, ownerClient, createMember } from './helpers.js';
import { createMcpServer } from '../src/mcp/server.js';

/**
 * M2 验收：MCP 客户端能列出工具，并调通 list_chats / read_messages / send_message。
 *
 * 测试全部走真实 HTTP（不直接调 dispatch），因为要验的正是「传输层 + 协议层」
 * 拼起来对客户端是否可用：握手、会话头、通知的 202、错误码形状都在这一层。
 */

const OWNER_TOKEN = 'test-owner-key';

/** 起一套「主服务 + MCP 端点」，跑完自动收摊。 */
async function withMcp(fn) {
  const fixture = await makeApp();
  const mcp = createMcpServer({
    ctx: fixture.app.ctx,
    config: { mcpPort: 0, mcpHost: '127.0.0.1', mcpPath: '/mcp' },
  });
  const { port } = await mcp.start();
  const ctx = {
    fixture,
    mcp,
    url: `http://127.0.0.1:${port}/mcp`,
    base: fixture.base,
    owner: ownerClient(fixture.base),
  };
  // 主人客户端要先登录，否则建成员/建会话都会被 401 挡回来
  await ctx.owner.login();
  try {
    await fn(ctx);
  } finally {
    await mcp.stop();
    await fixture.close();
  }
}

/** 发一条 JSON-RPC 报文。默认同时接受 JSON 与 SSE，和真实客户端一致。 */
async function rpc(url, body, { token = OWNER_TOKEN, session, accept = 'application/json, text/event-stream' } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: accept,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(session ? { 'Mcp-Session-Id': session } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: res.status, data, text, headers: res.headers };
}

/** 完成 initialize + initialized 握手，返回会话 id。 */
async function connect(ctx, { token = OWNER_TOKEN, protocolVersion = '2025-06-18' } = {}) {
  const init = await rpc(
    ctx.url,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion, capabilities: {}, clientInfo: { name: 'campfire-test', version: '0.0.1' } },
    },
    { token },
  );
  const session = init.headers.get('mcp-session-id');
  if (session) {
    await rpc(ctx.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, { token, session });
  }
  return { session, init };
}

/** 调一个工具，返回解析后的结构化结果。 */
async function callTool(ctx, { token = OWNER_TOKEN, session, name, args = {} }) {
  const r = await rpc(
    ctx.url,
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } },
    { token, session },
  );
  const result = r.data?.result;
  return {
    status: r.status,
    rpcError: r.data?.error || null,
    isError: Boolean(result?.isError),
    value: result?.structuredContent || null,
    text: result?.content?.[0]?.text || null,
  };
}

test('鉴权：没有令牌与令牌错误都回 401，且不透露令牌是否存在', async () => {
  await withMcp(async (ctx) => {
    const noToken = await rpc(ctx.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: null });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.data.error.code, -32001);

    const badToken = await rpc(ctx.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: 'not-the-key' });
    assert.equal(badToken.status, 401);
    assert.equal(badToken.data.error.code, -32001);
  });
});

test('握手：initialize 回协议版本、能力与 Mcp-Session-Id', async () => {
  await withMcp(async (ctx) => {
    const { session, init } = await connect(ctx);
    assert.equal(init.status, 200);
    assert.equal(init.data.result.protocolVersion, '2025-06-18');
    assert.equal(init.data.result.serverInfo.name, 'campfire');
    assert.ok(init.data.result.capabilities.tools, '必须声明 tools 能力');
    assert.ok(session, 'initialize 响应必须带 Mcp-Session-Id');
  });
});

test('握手：老版本回原版本，不认识的版本回服务端最新', async () => {
  await withMcp(async (ctx) => {
    const old = await connect(ctx, { protocolVersion: '2024-11-05' });
    assert.equal(old.init.data.result.protocolVersion, '2024-11-05');

    const weird = await connect(ctx, { protocolVersion: '1999-01-01' });
    assert.equal(weird.init.data.result.protocolVersion, '2025-11-25');
  });
});

test('握手：新版客户端的 server/discover 探测回 -32601，让它回退到 initialize', async () => {
  await withMcp(async (ctx) => {
    // DSH 的 MCP SDK 2.2 连上来第一发就是这个（带 2026 世代版本头、无会话）
    const res = await fetch(ctx.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${OWNER_TOKEN}`,
        'MCP-Protocol-Version': '2026-07-28',
        'MCP-Method': 'server/discover',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'server-discover-probe-1',
        method: 'server/discover',
        params: {},
      }),
    });
    assert.equal(res.status, 200, '探测必须是 200，5xx/401 会让客户端直接放弃连接');
    const data = await res.json();
    assert.equal(data.id, 'server-discover-probe-1', 'id 必须原样回显，否则探测挂到超时');
    assert.equal(data.error.code, -32601);

    // 回退路径：紧接着的 initialize 必须正常
    const { init } = await connect(ctx, { protocolVersion: '2025-11-25' });
    assert.equal(init.data.result.protocolVersion, '2025-11-25');
  });
});

test('握手：notifications/initialized 回 202 且无响应体', async () => {
  await withMcp(async (ctx) => {
    const { session } = await connect(ctx);
    const r = await rpc(ctx.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, { session });
    assert.equal(r.status, 202);
    assert.equal(r.text, '');
  });
});

test('会话：签发但不强制——没带或已失效的会话头都能继续用', async () => {
  await withMcp(async (ctx) => {
    // 不带会话头：放行（本服务端没有会话级状态，严格拒绝只会让客户端死锁）
    const noSession = await rpc(ctx.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(noSession.status, 200);
    assert.equal(noSession.data.result.tools.length, 5);

    // 伪造/过期的会话头：同样放行，不返回 404——客户端不会自己重新握手
    const stale = await rpc(
      ctx.url,
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { session: 'no-such-session' },
    );
    assert.equal(stale.status, 200);
    assert.equal(stale.data.result.tools.length, 5);
  });
});

test('tools/list：列出 5 个工具，每个都带 inputSchema', async () => {
  await withMcp(async (ctx) => {
    const { session } = await connect(ctx);
    const r = await rpc(ctx.url, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { session });
    assert.equal(r.status, 200);

    const tools = r.data.result.tools;
    assert.deepEqual(
      tools.map((t) => t.name),
      [
        'campfire_list_chats',
        'campfire_read_messages',
        'campfire_send_message',
        'campfire_search_memory',
        'campfire_get_summary',
      ],
    );
    for (const t of tools) {
      assert.equal(typeof t.description, 'string');
      assert.ok(t.description.length > 10, `${t.name} 的 description 要能指导模型何时调用`);
      assert.equal(t.inputSchema.type, 'object');
    }
  });
});

test('list_chats：主人能看到大厅，未读数与最后一条消息都在', async () => {
  await withMcp(async (ctx) => {
    const { session } = await connect(ctx);
    const r = await callTool(ctx, { session, name: 'campfire_list_chats' });
    assert.equal(r.isError, false);
    const main = r.value.chats.find((c) => c.id === 'main');
    assert.ok(main, '必须能看到大厅');
    assert.equal(main.name, '大厅');
    assert.equal(main.kind, 'group');
    assert.equal(main.last, null);
  });
});

test('read_messages + send_message：发出去的话能立刻读回来', async () => {
  await withMcp(async (ctx) => {
    const { session } = await connect(ctx);

    const empty = await callTool(ctx, { session, name: 'campfire_read_messages', args: { chatId: 'main' } });
    assert.equal(empty.isError, false);
    assert.deepEqual(empty.value.messages, []);
    assert.equal(empty.value.nextCursor, 0);

    const sent = await callTool(ctx, {
      session,
      name: 'campfire_send_message',
      args: { chatId: 'main', text: '大家好，这是 MCP 发的第一条消息' },
    });
    assert.equal(sent.isError, false);
    assert.equal(sent.value.message.sender.kind, 'user');
    assert.equal(sent.value.message.text, '大家好，这是 MCP 发的第一条消息');
    assert.ok(sent.value.message.seq > 0);

    const read = await callTool(ctx, { session, name: 'campfire_read_messages', args: { chatId: 'main' } });
    assert.equal(read.value.messages.length, 1);
    assert.equal(read.value.messages[0].id, sent.value.message.id);
    assert.equal(read.value.messages[0].sender.display, '主人');
    assert.equal(read.value.nextCursor, sent.value.message.seq);
  });
});

test('read_messages：cursor 只返回新消息，before 往前翻历史', async () => {
  await withMcp(async (ctx) => {
    const { session } = await connect(ctx);
    for (const text of ['第一条', '第二条', '第三条']) {
      await callTool(ctx, { session, name: 'campfire_send_message', args: { chatId: 'main', text } });
    }

    const all = await callTool(ctx, { session, name: 'campfire_read_messages', args: { chatId: 'main' } });
    assert.equal(all.value.messages.length, 3);
    const firstSeq = all.value.messages[0].seq;

    const newer = await callTool(ctx, {
      session,
      name: 'campfire_read_messages',
      args: { chatId: 'main', cursor: firstSeq },
    });
    assert.equal(newer.value.messages.length, 2);
    assert.ok(newer.value.messages.every((m) => m.seq > firstSeq));

    const older = await callTool(ctx, {
      session,
      name: 'campfire_read_messages',
      args: { chatId: 'main', before: firstSeq + 1, limit: 1 },
    });
    assert.equal(older.value.messages.length, 1);
    assert.equal(older.value.messages[0].seq, firstSeq);
    assert.equal(older.value.direction, 'backward');
  });
});

test('send_message：引用必须同会话，clientMsgId 幂等', async () => {
  await withMcp(async (ctx) => {
    const { session } = await connect(ctx);
    const a = await callTool(ctx, { session, name: 'campfire_send_message', args: { chatId: 'main', text: '被引用的话' } });

    const dup = await callTool(ctx, {
      session,
      name: 'campfire_send_message',
      args: { chatId: 'main', text: '被引用的话', clientMsgId: 'same-key' },
    });
    const dup2 = await callTool(ctx, {
      session,
      name: 'campfire_send_message',
      args: { chatId: 'main', text: '被引用的话', clientMsgId: 'same-key' },
    });
    assert.equal(dup.value.message.id, dup2.value.message.id, '同一 clientMsgId 只该落一条');

    const quoted = await callTool(ctx, {
      session,
      name: 'campfire_send_message',
      args: { chatId: 'main', text: '引用你', replyTo: a.value.message.id },
    });
    assert.equal(quoted.value.message.replyTo, a.value.message.id);

    // 另开一个会话，跨会话引用要被拒
    const created = await ctx.owner.post('/api/chats', { name: '另一个群' });
    const otherChat = created.data.chat.id;
    const cross = await callTool(ctx, {
      session,
      name: 'campfire_send_message',
      args: { chatId: otherChat, text: '跨群引用', replyTo: a.value.message.id },
    });
    assert.equal(cross.isError, true);
  });
});

test('成员令牌：只能看自己所在的会话，发言身份是成员自己', async () => {
  await withMcp(async (ctx) => {
    const created = await createMember(ctx.owner, { handle: 'echo', chats: ['main'] });
    const memberToken = `echo:${created.key}`;
    const { session } = await connect(ctx, { token: memberToken });

    const listed = await callTool(ctx, { token: memberToken, session, name: 'campfire_list_chats' });
    assert.equal(listed.isError, false);
    assert.deepEqual(
      listed.value.chats.map((c) => c.id),
      ['main'],
      '成员只该看到自己所在的会话',
    );

    const sent = await callTool(ctx, {
      token: memberToken,
      session,
      name: 'campfire_send_message',
      args: { chatId: 'main', text: '我是回声' },
    });
    assert.equal(sent.isError, false);
    assert.equal(sent.value.message.sender.kind, 'member');
    assert.equal(sent.value.message.sender.handle, 'echo');
    assert.equal(sent.value.message.sender.display, '回声');
  });
});

test('成员令牌：越权访问别的会话返回 isError，而不是抛协议错误', async () => {
  await withMcp(async (ctx) => {
    const created = await createMember(ctx.owner, { handle: 'echo', chats: ['main'] });
    const memberToken = `echo:${created.key}`;
    const { session } = await connect(ctx, { token: memberToken });

    const other = await ctx.owner.post('/api/chats', { name: '没我的群' });
    const chatId = other.data.chat.id;

    const read = await callTool(ctx, { token: memberToken, session, name: 'campfire_read_messages', args: { chatId } });
    assert.equal(read.isError, true);
    assert.equal(JSON.parse(read.text).code, 'forbidden');

    const write = await callTool(ctx, {
      token: memberToken,
      session,
      name: 'campfire_send_message',
      args: { chatId, text: '我不该在这里说话' },
    });
    assert.equal(write.isError, true);
    assert.equal(JSON.parse(write.text).code, 'forbidden');
  });
});

test('search_memory：M2 是空实现，但形状完整', async () => {
  await withMcp(async (ctx) => {
    const { session } = await connect(ctx);
    const r = await callTool(ctx, { session, name: 'campfire_search_memory', args: { query: '围炉' } });
    assert.equal(r.isError, false);
    assert.deepEqual(r.value.hits, []);
    assert.equal(r.value.implemented, false);
  });
});

test('get_summary：给出消息数、参与人与最近原文', async () => {
  await withMcp(async (ctx) => {
    const { session } = await connect(ctx);
    await callTool(ctx, { session, name: 'campfire_send_message', args: { chatId: 'main', text: '第一句' } });
    await callTool(ctx, { session, name: 'campfire_send_message', args: { chatId: 'main', text: '第二句' } });

    const r = await callTool(ctx, { session, name: 'campfire_get_summary', args: { chatId: 'main' } });
    assert.equal(r.isError, false);
    assert.equal(r.value.messageCount, 2);
    assert.equal(r.value.participants[0].handle, 'user');
    assert.equal(r.value.participants[0].count, 2);
    assert.equal(r.value.recent.length, 2);
    assert.equal(r.value.summary, null);
  });
});

test('协议错误：未知方法 -32601、未知工具 -32602、坏 JSON -32700', async () => {
  await withMcp(async (ctx) => {
    const { session } = await connect(ctx);

    const unknownMethod = await rpc(ctx.url, { jsonrpc: '2.0', id: 9, method: 'chats/list' }, { session });
    assert.equal(unknownMethod.data.error.code, -32601);

    const unknownTool = await callTool(ctx, { session, name: 'campfire_do_everything' });
    assert.equal(unknownTool.rpcError.code, -32602);
    assert.ok(unknownTool.rpcError.data.available.includes('campfire_list_chats'));

    const badJson = await rpc(ctx.url, '{not json', { session });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.data.error.code, -32700);
  });
});

test('ping：回空结果（客户端探活用）', async () => {
  await withMcp(async (ctx) => {
    const { session } = await connect(ctx);
    const r = await rpc(ctx.url, { jsonrpc: '2.0', id: 11, method: 'ping' }, { session });
    assert.deepEqual(r.data.result, {});
  });
});

test('批量报文：一次发两条，回数组', async () => {
  await withMcp(async (ctx) => {
    const { session } = await connect(ctx);
    const r = await rpc(
      ctx.url,
      [
        { jsonrpc: '2.0', id: 21, method: 'ping' },
        { jsonrpc: '2.0', id: 22, method: 'tools/list' },
      ],
      { session },
    );
    assert.ok(Array.isArray(r.data));
    assert.equal(r.data.length, 2);
    assert.deepEqual(r.data[0].result, {});
  });
});

test('只接受 SSE 的客户端也能拿到结果', async () => {
  await withMcp(async (ctx) => {
    const { session } = await connect(ctx);
    const r = await rpc(
      ctx.url,
      { jsonrpc: '2.0', id: 31, method: 'tools/list' },
      { session, accept: 'text/event-stream' },
    );
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/event-stream/);
    const dataLine = r.text.split('\n').find((line) => line.startsWith('data: '));
    assert.ok(dataLine, 'SSE 回包必须带 data 行');
    const payload = JSON.parse(dataLine.slice('data: '.length));
    assert.equal(payload.result.tools.length, 5);
  });
});

test('GET 不提供推送流（405），DELETE 结束会话', async () => {
  await withMcp(async (ctx) => {
    const { session } = await connect(ctx);

    const get = await fetch(ctx.url, {
      headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Mcp-Session-Id': session },
    });
    assert.equal(get.status, 405);
    assert.match(get.headers.get('allow') || '', /POST/);

    const del = await fetch(ctx.url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Mcp-Session-Id': session },
    });
    assert.equal(del.status, 204);

    // 会话删掉之后请求仍然能跑（无状态兜底），不会把客户端卡死
    const after = await rpc(ctx.url, { jsonrpc: '2.0', id: 41, method: 'tools/list' }, { session });
    assert.equal(after.status, 200);
  });
});

test('端到端：按 DSH 的真实握手顺序走一遍（discover → initialize → initialized → tools）', async () => {
  await withMcp(async (ctx) => {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${OWNER_TOKEN}`,
    };

    // 1) 探测
    const probe = await fetch(ctx.url, {
      method: 'POST',
      headers: { ...headers, 'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': 'server/discover' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: {} }),
    });
    assert.equal(probe.status, 200);

    // 2) 握手（DSH 发的是 2025-11-25，capabilities 为空对象）
    const init = await fetch(ctx.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dsh-mcp-client', version: '0.0.1' } },
      }),
    });
    const session = init.headers.get('mcp-session-id');
    const initBody = await init.json();
    assert.equal(initBody.result.protocolVersion, '2025-11-25');
    assert.ok(initBody.result.capabilities.tools, '不声明 tools 能力，客户端一个工具都拿不到');

    // 3) 通知（DSH 会 await 它，状态码决定握手成败）
    const notif = await fetch(ctx.url, {
      method: 'POST',
      headers: { ...headers, 'MCP-Protocol-Version': '2025-11-25', ...(session ? { 'Mcp-Session-Id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.ok(notif.status >= 200 && notif.status < 300, '通知必须回 2xx');

    // 4) 列工具（带会话与版本头）
    const list = await rpc(
      ctx.url,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { session },
    );
    assert.equal(list.data.result.tools.length, 5);

    // 5) 调工具
    const call = await callTool(ctx, { session, name: 'campfire_list_chats' });
    assert.equal(call.isError, false);
    assert.ok(call.value.chats.some((c) => c.id === 'main'));
  });
});

test('挂载模式：主服务的 /api/mcp 与独立端点行为一致', async () => {
  await withMcp(async (ctx) => {
    // 主服务由 src/server.js 里的 registerMcpRoutes 挂载，端口和界面共用一个
    const mounted = `${ctx.base}/api/mcp`;
    const { session, init } = await connect({ ...ctx, url: mounted });
    assert.equal(init.status, 200);
    assert.equal(init.data.result.serverInfo.name, 'campfire');
    assert.ok(session);

    const list = await rpc(mounted, { jsonrpc: '2.0', id: 51, method: 'tools/list' }, { session });
    assert.equal(list.data.result.tools.length, 5);

    // 挂载点同样要求令牌：没有 Bearer 就进不来
    const anonymous = await rpc(mounted, { jsonrpc: '2.0', id: 52, method: 'tools/list' }, { token: null });
    assert.equal(anonymous.status, 401);
  });
});
