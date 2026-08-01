import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8787;

/**
 * Origins allowed to connect. Anything else is rejected, since a
 * browser cannot be trusted to enforce this on a WebSocket.
 */
const ALLOWED = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);

const allowed = origin =>
  ALLOWED.length === 0 ||
  ALLOWED.includes(origin) ||
  /^http:\/\/localhost:\d+$/.test(origin ?? '');

/**
 * A room is an append-only log of opaque operations plus a version
 * vector describing it. The relay never inspects an op's contents and
 * never computes document text. It cannot: it has no CRDT.
 */
const rooms = new Map();

function room(id) {
  if (!rooms.has(id)) rooms.set(id, {
    log: [], seen: new Set(), vector: {}, peers: new Set(), cursors: new Map()
  });
  return rooms.get(id);
}

const key = op => `${op.id.site}:${op.id.lamport}`;
const covers = (v, op) => (v[op.id.site] ?? -1) >= op.id.lamport;

function record(r, op) {
  const k = key(op);
  if (r.seen.has(k)) return false;
  r.seen.add(k);
  r.log.push(op);
  const { site, lamport } = op.id;
  if (!(site in r.vector) || lamport > r.vector[site]) r.vector[site] = lamport;
  return true;
}

const roster = r =>
  [...r.peers].map(p => ({ site: p.site, name: p.name, color: p.color }));

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(r, msg, except) {
  for (const p of r.peers) if (p !== except) send(p, msg);
}

const http = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      clients: wss.clients.size,
      uptime: Math.round(process.uptime())
    }));
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('crdt relay');
});

const wss = new WebSocketServer({ server: http });

wss.on('connection', (ws, req) => {
  if (!allowed(req.headers.origin)) return ws.close(1008, 'origin not allowed');

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'hello') {
      const r = room(msg.room ?? 'default');
      ws.room = r;
      ws.site = msg.site;
      // Two people can pick the same name. Disambiguate on arrival.
      const taken = new Set([...r.peers].map(p => p.name));
      let name = (msg.name || 'Anonymous').slice(0, 18);
      for (let n = 2; taken.has(name); n++) name = `${msg.name} ${n}`;
      ws.name = name;
      ws.color = msg.color;
      r.peers.add(ws);

      // Symmetric version-vector exchange: we send what the client
      // lacks, and return our own vector so it can send what we lack.
      send(ws, {
        type: 'welcome',
        you: { name: ws.name },
        vector: r.vector,
        ops: r.log.filter(op => !covers(msg.vector ?? {}, op)),
        peers: roster(r).filter(p => p.site !== ws.site).map(p => ({ ...p, ...(r.cursors.get(p.site) ?? {}) })),
      });

      broadcast(r, { type: 'peer-join', peer: { site: ws.site, name: ws.name, color: ws.color } }, ws);
      return;
    }

    const r = ws.room;
    if (!r) return;

    if (msg.type === 'push') {
      const fresh = (msg.ops ?? []).filter(op => record(r, op));
      if (fresh.length) broadcast(r, { type: 'ops', ops: fresh }, ws);
      return;
    }

    if (msg.type === 'cursor') {
      r.cursors.set(ws.site, { anchor: msg.anchor, focus: msg.focus });
      broadcast(r, { type: 'cursor', site: ws.site, anchor: msg.anchor, focus: msg.focus }, ws);
    }
  });

  ws.on('close', () => {
    const r = ws.room;
    if (!r) return;
    r.peers.delete(ws);
    r.cursors.delete(ws.site);
    broadcast(r, { type: 'peer-leave', site: ws.site });
    if (r.peers.size === 0) {
      // Keep the log so a returning client can catch up.
      setTimeout(() => { if (r.peers.size === 0) rooms.delete(ws.roomId); }, 30 * 60 * 1000);
    }
  });
});

// Idle WebSockets get killed by proxies. Ping to keep them alive.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

http.listen(PORT, () => console.log(`relay on :${PORT}`));