/**
 * mock DSH Web Host：只实现适配器用到的 4 个 RPC。
 * 行为：session/prompt 收到消息后立刻生成一个已完成的回合，
 * 回复文本 = "MOCK回复：" + 提示词末尾 80 字（用来验证完整提示词确实送达）。
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_DSH_PORT || 0);
const sessions = new Map(); // sid -> { turns: [{ requestId, response }], seq }

function extractText(prompt) {
  const text = String(prompt || '');
  const tail = text.slice(-60).replace(/\s+/g, ' ');
  const marker = text.includes('[人设]') ? '[人设]✓' : 'NO_PERSONA';
  return `${marker} … ${tail}`;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(body || '{}');
    } catch {}
    const args = (payload.payload && payload.payload.args) || {};
    const method = req.url.replace('/api/', '');
    const reply = (value) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: { ok: true, value } }));
    };

    if (method === 'session/list') {
      const items = [];
      for (const [sessionId, s] of sessions) {
        items.push({
          sessionId,
          running: false,
          projections: { asOfSeq: s.seq, values: { turnOutline: s.turns } },
        });
      }
      return reply({ items });
    }

    if (method === 'session/create') {
      const sid = 's-' + Math.random().toString(36).slice(2, 10);
      sessions.set(sid, { turns: [], seq: 1 });
      return reply({ sessionId: sid });
    }

    if (method === 'session/prompt') {
      const { sessionId, requestId, content } = args.request || {};
      const s = sessions.get(sessionId);
      if (!s) return reply({ accepted: false });
      const text = (Array.isArray(content) ? content : [])
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text || '')
        .join('');
      s.seq++;
      s.turns.push({
        request: { requestId },
        response: 'MOCK回复：' + extractText(text),
      });
      return reply({ accepted: true });
    }

    if (method === 'session/page') {
      const sessionId = (args.request || {}).address?.sessionId;
      const s = sessions.get(sessionId);
      const records = (s ? s.turns : []).map((t) => ({
        event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: t.response }] } } },
      }));
      return reply({ records });
    }

    res.writeHead(404);
    res.end('{}');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  if (process.send) process.send({ ready: true, port: server.address().port });
  else console.log(`mock DSH on 127.0.0.1:${server.address().port}`);
});
