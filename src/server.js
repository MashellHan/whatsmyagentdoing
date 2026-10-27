'use strict';

const fs = require('fs');
const http = require('http');
const { guessFromPrompts } = require('./lang');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const STATIC = {
  '/': ['town.html', 'text/html; charset=utf-8'],
  '/town': ['town.html', 'text/html; charset=utf-8'],
  '/town.js': ['town.js', 'text/javascript; charset=utf-8'],
  '/town.css': ['town.css', 'text/css; charset=utf-8'],
  '/team-office.css': ['team-office.css', 'text/css; charset=utf-8'],
  '/rules-ui.js': ['rules-ui.js', 'text/javascript; charset=utf-8'],
  '/rules-ui.css': ['rules-ui.css', 'text/css; charset=utf-8'],
  '/office': ['index.html', 'text/html; charset=utf-8'],
  '/office/': ['index.html', 'text/html; charset=utf-8'],
  '/office.js': ['office.js', 'text/javascript; charset=utf-8'],
  '/office3d.js': ['office3d.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/popout.js': ['popout.js', 'text/javascript; charset=utf-8'],
};
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.glb': 'model/gltf-binary', '.png': 'image/png', '.json': 'application/json' };
// 3D models, served as-is (3D view only).
const MOUNTS = { '/assets/': path.join(__dirname, '..', 'assets') };
const scenes = require('./scenes');
const updater = require('./update');
const { RulesReader } = require('./rules');

function serveFile(res, root, rel) {
  const file = path.normalize(path.join(root, rel));
  const type = TYPES[path.extname(file)];
  if (!type || !file.startsWith(root + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  // no-cache: a reinstalled scene pack or an updated clone must show up on reload
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}
const ACTIVE = new Set(['thinking', 'tool', 'typing']);

// Logs only record finished blocks, so a few states need a clock to resolve:
// a reply with no follow-up is a finished turn, and an "active" session that
// has gone silent for a long time was most likely closed mid-turn.
function view(s, now, { privacy = true }) {
  const quiet = now - (s.lastEventAt || s.mtime || now);
  let status = s.status;
  if ((s.statusSource || s.source) !== 'herdr') {
    if (status === 'typing' && quiet > 45_000) status = 'done';
    if (status === 'thinking' && quiet > 15 * 60_000) status = 'idle';
    if (status === 'tool' && quiet > 45 * 60_000) status = 'idle';
    if ((status === 'waiting' || status === 'error') && quiet > 2 * 3600_000) status = 'idle';
  }

  const out = {
    key: s.key || `${s.agent}:${s.id}`,
    source: s.source || 'log',
    sourceStatus: (s.statusSource || s.source) === 'herdr' ? s.sourceStatus : status,
    statusSource: s.statusSource || (s.source === 'herdr' ? 'herdr' : 'log'),
    herdrStatus: s.herdrStatus || (s.source === 'herdr' ? s.sourceStatus : null),
    logKey: s.logKey || null,
    logSessionId: s.logSessionId || null,
    binding: s.binding || (s.source === 'herdr' ? 'log-unavailable' : 'unregistered-log'),
    displayName: s.displayName || null,
    teamId: s.teamId || 'ungrouped',
    workspaceId: s.workspaceId || null,
    paneId: s.paneId || null,
    tabId: s.tabId || null,
    role: s.role || 'member',
    presence: s.presence || 'fresh',
    capabilities: s.capabilities || { resume: true },
    agent: s.agent,
    id: s.id,
    sessionId: s.sessionId || null,
    parentId: s.parentId,
    subagent: s.subagent,
    cwd: s.cwd,
    project: s.cwd ? path.basename(s.cwd) : null,
    title: s.title,
    model: s.model,
    status,
    activity: status === 'tool' || status === 'waiting' ? s.activity : null,
    prompt: s.prompt,
    reply: s.reply,
    error: s.error,
    turnStartedAt: s.turnStartedAt,
    lastEventAt: s.lastEventAt || s.mtime,
    startedAt: s.startedAt,
  };
  if (privacy) {
    out.prompt = out.reply = out.title = out.error = null;
    if (out.activity) out.activity = out.activity.split(/[:\s]/)[0];
  }
  return out;
}

// The language the user writes their prompts in (recent sessions first);
// the page uses it as the default UI language.
function promptLanguage(raw) {
  const recent = raw
    .filter((s) => !s.subagent && s.prompt && !s.prompt.startsWith('/'))
    .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0))
    .slice(0, 60)
    .map((s) => s.prompt);
  return guessFromPrompts(recent);
}

function snapshot(watcher, opts = {}) {
  const now = Date.now();
  const raw = watcher.sessions();
  const sessions = raw.map((s) => view(s, now, opts));
  sessions.sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
  const teams = watcher.teams ? watcher.teams() : sessions.length ? [{ id: 'ungrouped', workspaceId: null, name: opts.demo ? '演示小屋' : '未分组', label: '未分组', presence: 'fresh' }] : [];
  return { now, lang: opts.demo || opts.privacy !== false ? null : promptLanguage(raw), sessions, teams,
    privacy: opts.privacy !== false, source: watcher.sourceInfo?.() || { kind: opts.demo ? 'demo' : 'logs', presence: 'fresh' } };
}

function createServer(watcher, opts = {}, { onShutdown, rulesReader } = {}) {
  const rules = rulesReader || (typeof watcher.ruleContext === 'function' ? new RulesReader(team => watcher.ruleContext(team)) : null);
  const clients = new Set();
  let last = '';

  const push = (force) => {
    let body;
    try { body = JSON.stringify(snapshot(watcher, opts)); } catch (e) { console.error('snapshot failed:', e.message); return; }
    // Compare without the timestamp so idle ticks don't spam clients.
    const sig = body.replace(/^\{"now":\d+,/, '{');
    if (!force && sig === last) return;
    last = sig;
    for (const res of clients) res.write(`data: ${body}\n\n`);
  };
  const onChange = () => push(false);
  watcher.on('change', onChange);
  // Status can flip with no new log lines (see view()), so re-check on a clock.
  const clock = setInterval(() => push(false), 5000);
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000);
  clock.unref(); heartbeat.unref();

  const server = http.createServer((req, res) => {
    // Refuse anything not addressed to loopback (blocks DNS-rebinding pages
    // from reading your prompts through this server).
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
      res.writeHead(403).end();
      return;
    }
    let url;
    try { url = new URL(req.url, 'http://localhost'); decodeURIComponent(url.pathname); }
    catch { res.writeHead(400).end(); return; }
    if (url.pathname === '/api/rules' || url.pathname.startsWith('/api/rules/')) {
      // Local rule files have a stricter boundary than ordinary status data.
      // The custom header is a cross-origin preflight guard, not authentication.
      const origin = `http://${req.headers.host}`;
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const fetchSite = req.headers['sec-fetch-site'];
      const writeJSON = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(JSON.stringify(body));
      };
      if (!local || req.method !== 'GET' || req.headers['x-agent-office-rule-read'] !== '1' ||
          (req.headers.origin && req.headers.origin !== origin) || (fetchSite && fetchSite !== 'same-origin') ||
          req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers.range) {
        writeJSON(403, { error: 'local_same_origin_only' }); return;
      }
      if (url.pathname === '/api/rules/capabilities') {
        writeJSON(200, { enabled: !!rules }); return;
      }
      const team = url.searchParams.get('team'), id = url.searchParams.get('id');
      const allowed = url.pathname === '/api/rules' ? ['team'] : url.pathname === '/api/rules/file' ? ['team', 'id'] : [];
      if (!rules || !team || team.length > 100 || !allowed.length || [...url.searchParams.keys()].some(k => !allowed.includes(k)) ||
          [...new Set(url.searchParams.keys())].some(k => url.searchParams.getAll(k).length !== 1)) {
        writeJSON(404, { error: 'not_found' }); return;
      }
      Promise.resolve().then(() => url.pathname === '/api/rules' ? rules.list(team) : rules.read(team, id)).then(
        body => writeJSON(200, body), error => writeJSON(error.status || 503, { error: error.code || 'reader_unavailable' }),
      );
      return;
    } else if (STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      fs.createReadStream(path.join(PUBLIC, file)).pipe(res);
    } else if (Object.keys(MOUNTS).some((m) => url.pathname.startsWith(m))) {
      const m = Object.keys(MOUNTS).find((k) => url.pathname.startsWith(k));
      serveFile(res, MOUNTS[m], decodeURIComponent(url.pathname.slice(m.length)));
    } else if (url.pathname.startsWith('/scenes/')) {
      const rel = decodeURIComponent(url.pathname.slice('/scenes/'.length));
      const [id, ...rest] = rel.split('/');
      const dir = scenes.sceneDir(id);
      if (!dir) res.writeHead(404).end();
      else serveFile(res, dir, rest.join('/'));
    } else if (url.pathname === '/api/scenes') {
      const cat = scenes.catalog();
      const icon = (x) => x.icon || (cat.find((c) => c.id === x.id) || {}).icon || '🗺️';
      const have = scenes.installed().map((x) => ({ ...x, icon: icon(x) }));
      const ids = new Set(have.map((x) => x.id));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        installed: have.map(({ id, name, version, credits, icon }) => ({ id, name, version, credits, icon })),
        available: [], // No download controls in the local-only build.
      }));
    } else if (url.pathname === '/api/scenes/install' && req.method === 'POST') {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'Scene downloads disabled: local-only build.' }));
      return;
    } else if (url.pathname === '/api/sessions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(snapshot(watcher, opts)));
    } else if (url.pathname === '/api/shutdown' && req.method === 'POST') {
      // Only our CLI sends this header; a web page can't add a custom header
      // to a cross-site request without a CORS preflight, which we never allow.
      if (req.headers['x-whatsmyagentdoing'] !== 'stop' || !onShutdown) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      for (const c of clients) c.end();
      setTimeout(onShutdown, 50);
    } else if (url.pathname === '/api/version') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ version: updater.localVersion(), latest: null, updateAvailable: false, canUpdate: false, disabled: true }));
    } else if (url.pathname === '/api/update' && req.method === 'POST') {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'Updates disabled: local-only build.' }));
      return;
    } else if (url.pathname === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ app: 'agent-office-team-houses' }));
    } else if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(snapshot(watcher, opts))}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else {
      res.writeHead(404).end();
    }
  });
  server.on('close', () => { clearInterval(clock); clearInterval(heartbeat); watcher.off('change', onChange); });
  return server;
}

module.exports = { createServer, snapshot, view };
