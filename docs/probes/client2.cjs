// wbipc 客户端 v2：握手 → 逐个 GetPipe → 打印方法表
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');

const ep = JSON.parse(fs.readFileSync(process.env.USERPROFILE + '/.workbuddy/wbipc/endpoint.json', 'utf8'));
const PIPE = ep.endpoint, TICKET = ep.ticket;
const b64u = (b) => Buffer.from(b).toString('base64url');
const ticketId = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 16);
function encodeTranscript(role, t) {
  const parts = [role === 'server' ? 'wbipc-s' : 'wbipc-c', String(t.protocol), t.endpoint, t.clientNonce, t.serverNonce];
  const bufs = [];
  for (const p of parts) { const b = Buffer.from(p, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32BE(b.length, 0); bufs.push(l, b); }
  return Buffer.concat(bufs);
}
const proof = (ticket, role, t) => crypto.createHmac('sha256', Buffer.from(ticket, 'utf8')).update(encodeTranscript(role, t)).digest('base64url');

const sock = net.createConnection(PIPE);
let buf = '', nonce = '';
const pending = new Map();
let nextId = 1;

sock.setTimeout(6000, () => { console.log('TIMEOUT'); sock.destroy(); process.exit(2); });
sock.on('error', (e) => { console.log('ERR', e.code || e.message); process.exit(3); });
sock.on('connect', () => {
  nonce = b64u(crypto.randomBytes(16));
  sock.write(JSON.stringify({ type: 'session_hello', protocol_min: 1, protocol_max: 1, client_nonce: nonce, ticket_id: ticketId(TICKET), client: { kind: 'campfire-probe', id: 'probe-2', version: '0.0.1' } }) + '\n');
});
sock.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    onFrame(m);
  }
});

function onFrame(m) {
  if (m.type === 'session_challenge') {
    const t = { protocol: 1, endpoint: PIPE, clientNonce: nonce, serverNonce: m.server_nonce };
    sock.write(JSON.stringify({ type: 'session_prove', client_proof: proof(TICKET, 'client', t) }) + '\n');
    return;
  }
  if (m.type === 'session_hello_ack') { main(m.pipes || []).catch((e) => console.log('ERR', e.message)).finally(() => { sock.destroy(); process.exit(0); }); return; }
  if (m.type === 'session_hello_error') { console.log('HELLO ERROR', m.code); sock.destroy(); process.exit(4); }
  if (m.jsonrpc) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.code + ': ' + m.error.message)) : p.resolve(m.result); }
}

function rpc(method, params, mode) {
  return new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve, reject });
    const f = { jsonrpc: '2.0', id, method, params };
    if (mode) f.mode = mode;
    sock.write(JSON.stringify(f) + '\n');
  });
}

async function main(pipes) {
  for (const name of pipes) {
    try {
      const r = await rpc('broker/GetPipe', { pipe: name });
      console.log('\n=== ' + name + ' → channel=' + r.channel);
      console.log('methods(' + (r.methods || []).length + '): ' + (r.methods || []).join(', ').slice(0, 1200));
    } catch (e) {
      console.log('\n=== ' + name + ' ERR ' + e.message);
    }
  }
}
