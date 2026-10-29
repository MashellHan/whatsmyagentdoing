// agent-town viewer: read-only, Access-protected copy of the town UI.
// Every request (pages, assets, WebSocket) needs a valid Cloudflare Access
// JWT for the exact allowed email; otherwise 403. No write endpoints.
import { verifyAccessJwt } from './access.mjs';

const PAGES = { '/': '/town.html', '/town': '/town.html', '/office': '/index.html', '/office/': '/index.html' };
const FILES = new Set(['/town.js', '/town.css', '/team-office.css', '/office.js', '/office3d.js', '/i18n.js', '/popout.js', '/remote-shim.js']);
const ASSET = /^\/assets\/[A-Za-z0-9_\/.-]+\.(png|svg|glb|json)$/;
const SECURITY = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...SECURITY } });
const town = (env) => env.TOWN.get(env.TOWN.idFromName('mini-1'));

function harden(response) {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== env.VIEWER_HOST) return new Response('Not found', { status: 404 });
    const viewer = await verifyAccessJwt(request.headers.get('cf-access-jwt-assertion'), {
      teamUrl: env.ACCESS_TEAM_URL, audience: env.ACCESS_AUD, allowedEmail: env.ALLOWED_VIEWER_EMAIL,
    });
    if (!viewer) return new Response('Cloudflare Access login required', { status: 403, headers: SECURITY });
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { ok: false });

    if (url.pathname === '/ws') {
      if (request.headers.get('upgrade') !== 'websocket') return json(426, { ok: false });
      if (request.headers.get('origin') !== `https://${env.VIEWER_HOST}`) return json(403, { ok: false });
      return town(env).fetch('https://town/ws', { headers: { upgrade: 'websocket' } });
    }
    if (url.pathname === '/api/sessions') {
      const state = await (await town(env).fetch('https://town/state')).json();
      return json(200, state.snapshot || { now: Date.now(), sessions: [], teams: [], privacy: true, source: { kind: 'remote', presence: 'stale', error: '等待 mini-1 推送' } });
    }
    if (url.pathname === '/api/scenes') return json(200, { installed: [], available: [] });
    if (url.pathname === '/api/version') return json(200, { version: 'remote', latest: null, updateAvailable: false, canUpdate: false, disabled: true });
    if (url.pathname === '/api/ping') return json(200, { app: 'agent-town-remote' });

    const page = PAGES[url.pathname];
    if (page) {
      const res = await env.ASSETS.fetch(new URL(page, url));
      if (!res.ok) return harden(res);
      // Classic script before any page script, so it can provide /events.
      return harden(new HTMLRewriter()
        .on('head', { element(el) { el.prepend('<script src="/remote-shim.js"></script>', { html: true }); } })
        .transform(res));
    }
    if (FILES.has(url.pathname) || ASSET.test(url.pathname)) return harden(await env.ASSETS.fetch(request));
    return new Response('Not found', { status: 404, headers: SECURITY });
  },
};
