// agent-town-ingest: the only writer. mini-1 POSTs whitelisted snapshots with
// a bearer token; the TownState Durable Object keeps ONLY the latest snapshot
// in memory (no storage writes) and fans it out over hibernatable WebSockets.
// Viewers never reach this hostname; the viewer Worker binds the DO directly.
import { sanitizeSnapshot, signature } from '../shared/whitelist.mjs';

const MAX_BODY = 256 * 1024;
const enc = new TextEncoder();
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function sameSecret(a, b) {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(x, y);
}
async function authorized(request, env) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1] || '';
  return !!env.PUSH_TOKEN && env.PUSH_TOKEN.length >= 32 && !!token && sameSecret(token, env.PUSH_TOKEN);
}
const town = (env) => env.TOWN.get(env.TOWN.idFromName('mini-1'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ingest' && request.method === 'POST') {
      if (!(await authorized(request, env))) return reply(401, { ok: false });
      if (!(request.headers.get('content-type') || '').startsWith('application/json')) return reply(415, { ok: false });
      const body = await request.text();
      if (body.length > MAX_BODY) return reply(413, { ok: false });
      let parsed;
      try { parsed = JSON.parse(body); } catch { return reply(400, { ok: false }); }
      // Re-apply the whitelist server side: unknown fields never reach viewers.
      const snapshot = sanitizeSnapshot(parsed?.snapshot, { sourceOk: parsed?.sourceOk !== false });
      return town(env).fetch('https://town/push', { method: 'POST', body: JSON.stringify(snapshot) });
    }
    if (url.pathname === '/ingest/check' && request.method === 'GET') {
      if (!(await authorized(request, env))) return reply(401, { ok: false });
      return town(env).fetch('https://town/state');
    }
    return reply(404, { ok: false });
  },
};

export class TownState {
  constructor(ctx) {
    this.ctx = ctx;
    this.snapshot = null; // memory only; lost on eviction until the next push (<=20s)
    this.sig = '';
    this.lastPushAt = 0;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  message(type) {
    return JSON.stringify({ type, serverNow: Date.now(), lastPushAt: this.lastPushAt || null, snapshot: type === 'heartbeat' ? undefined : this.snapshot });
  }
  broadcast(text) {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(text); } catch {}
    }
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/push' && request.method === 'POST') {
      const snapshot = sanitizeSnapshot(await request.json(), {});
      const sig = signature(snapshot);
      const changed = sig !== this.sig || !this.snapshot;
      this.snapshot = snapshot;
      this.sig = sig;
      this.lastPushAt = Date.now();
      this.broadcast(this.message(changed ? 'snapshot' : 'heartbeat'));
      return reply(200, { ok: true, changed, teams: snapshot.teams.length, sessions: snapshot.sessions.length, viewers: this.ctx.getWebSockets().length });
    }
    if (url.pathname === '/state') {
      return reply(200, { ok: true, lastPushAt: this.lastPushAt || null, viewers: this.ctx.getWebSockets().length, snapshot: this.snapshot });
    }
    if (url.pathname === '/ws') {
      if (request.headers.get('upgrade') !== 'websocket') return reply(426, { ok: false });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(this.message(this.snapshot ? 'snapshot' : 'waiting'));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return reply(404, { ok: false });
  }
  webSocketMessage() {}
  webSocketClose(ws, code) {
    try { ws.close([1005, 1006, 1015].includes(code) ? 1000 : code, 'bye'); } catch {}
  }
  webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch {}
  }
}
