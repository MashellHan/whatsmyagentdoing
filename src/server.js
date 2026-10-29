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
  '/member-ui.js': ['member-ui.js', 'text/javascript; charset=utf-8'],
  '/member-ui.css': ['member-ui.css', 'text/css; charset=utf-8'],
  '/office': ['index.html', 'text/html; charset=utf-8'],
  '/office/': ['index.html', 'text/html; charset=utf-8'],
  '/office.js': ['office.js', 'text/javascript; charset=utf-8'],
  '/office3d.js': ['office3d.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/popout.js': ['popout.js', 'text/javascript; charset=utf-8'],
};
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.glb': 'model/gltf-binary', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
// 3D models, served as-is (3D view only).
const MOUNTS = { '/assets/': path.join(__dirname, '..', 'assets') };
const scenes = require('./scenes');
const updater = require('./update');
const { RulesReader } = require('./rules');
const { ompResumeCommand } = require('./omp');
const { dayKey } = require('./parsers');

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
    if (status === 'typing' && !s.explicitLifecycle && quiet > 45_000) status = 'done';
    if (status === 'typing' && s.explicitLifecycle && quiet > 15 * 60_000) status = 'idle';
    if (status === 'thinking' && s.source !== 'magpie' && quiet > 15 * 60_000) status = 'idle';
    if (status === 'tool' && quiet > 45 * 60_000) status = 'idle';
    if ((status === 'waiting' || status === 'error') && quiet > 2 * 3600_000) status = 'idle';
  }
  // Still "active" but silent for a while: likely stuck (a hung tool, a lost prompt).
  // Herdr lifecycle and gateway observations do not establish log silence.
  const logActivity = (s.statusSource || s.source) !== 'herdr' && s.source !== 'magpie';
  const stuckAfter = logActivity ? (status === 'tool' ? 10 * 60_000 : status === 'thinking' ? 8 * 60_000 : Infinity) : Infinity;
  const stuck = quiet > stuckAfter ? Math.floor(quiet / 60_000) : 0;

  const out = {
    key: s.key || `${s.agent}:${s.id}`,
    source: s.source || 'log',
    sourceStatus: (s.statusSource || s.source) === 'herdr' ? s.sourceStatus : status,
    statusSource: s.statusSource || (['herdr', 'magpie'].includes(s.source) ? s.source : 'log'),
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
    capabilities: s.source === 'magpie' ? { resume: false } : s.capabilities || { resume: true },
    agent: s.agent,
    ...(s.source === 'magpie' ? { source: s.source, agentName: s.agentName } : {}),
    id: s.id,
    sessionId: s.sessionId || null,
    parentId: s.parentId,
    subagent: s.subagent,
    cwd: s.cwd,
    project: s.cwd ? `${s.agent === 'copilot' ? 'workspace-' : ''}${path.basename(s.cwd)}` : null,
    title: s.title,
    model: s.model,
    reasoningEffort: s.reasoningEffort || null,
    contextWindow: s.contextWindow || null,
    contextWindowSource: s.contextWindowSource || null,
    status,
    stuck,
    context: s.context ? { used: s.context, window: s.contextWindow || null } : null,
    today: s.daily && s.daily.day === dayKey(now) ? { turns: s.daily.turns, tokens: s.daily.tokens } : null,
    activity: status === 'tool' || status === 'waiting' ? s.activity : null,
    prompt: s.prompt,
    reply: s.reply,
    error: s.error,
    turnStartedAt: s.turnStartedAt,
    lastEventAt: s.lastEventAt || s.mtime,
    startedAt: s.startedAt,
  };
  if (s.agent === 'omp' && s.source !== 'magpie') {
    out.ompProfile = s.ompProfile || null;
    // OMP subagents can't be resumed on their own.
    out.resumeCommand = s.subagent ? null : ompResumeCommand(s);
  }
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

// Today's totals across every session seen today, main sessions and subagents alike.
function summary(sessions, now) {
  // Folder names are keys here, so no prototype: a project called __proto__ stays a project.
  const out = { day: dayKey(now), turns: 0, tokens: 0, agents: 0, byAgent: Object.create(null), projects: Object.create(null) };
  for (const s of sessions) {
    if (!s.today) continue;
    out.agents += 1;
    out.turns += s.today.turns;
    out.tokens += s.today.tokens;
    const a = (out.byAgent[s.agent] ||= { sessions: 0, turns: 0, tokens: 0 });
    a.sessions += 1; a.turns += s.today.turns; a.tokens += s.today.tokens;
    if (s.project) out.projects[s.project] = (out.projects[s.project] || 0) + s.today.turns;
  }
  return out;
}

function snapshot(watcher, opts = {}) {
  const now = Date.now();
  const raw = watcher.sessions();
  const sessions = raw.map((s) => view(s, now, opts));
  sessions.sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
  const teams = watcher.teams ? watcher.teams() : sessions.length ? [{ id: 'ungrouped', workspaceId: null, name: opts.demo ? '演示小屋' : '未分组', label: '未分组', presence: 'fresh' }] : [];
  return { now, lang: opts.demo || opts.privacy !== false ? null : promptLanguage(raw), sessions, teams, summary: summary(sessions, now),
    privacy: opts.privacy !== false, source: watcher.sourceInfo?.() || { kind: opts.demo ? 'demo' : 'logs', presence: 'fresh' } };
}

function createServer(watcher, opts = {}, { onShutdown, rulesReader } = {}) {
  const rules = rulesReader || (typeof watcher.ruleContext === 'function' ? new RulesReader((team, member) => watcher.ruleContext(team, member)) : null);
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
    if (url.pathname === '/api/rules' || url.pathname.startsWith('/api/rules/') || url.pathname.startsWith('/api/members/')) {
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
          req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto'] || req.headers.forwarded || req.headers.range) {
        writeJSON(403, { error: 'local_same_origin_only' }); return;
      }
      if (url.pathname === '/api/rules/capabilities') {
        writeJSON(200, { enabled: !!rules, members: typeof watcher.memberActivity === 'function' }); return;
      }
      const team = url.searchParams.get('team'), id = url.searchParams.get('id'), member = url.searchParams.get('member');
      const activity = url.pathname === '/api/members/activity';
      const allowed = url.pathname === '/api/rules' ? ['team', 'member'] : url.pathname === '/api/rules/file' ? ['team', 'id', 'member'] : activity ? ['team', 'member'] : [];
      if ((!activity && !rules) || (activity && (typeof watcher.memberActivity !== 'function' || !member)) ||
          !team || team.length > 100 || (url.searchParams.has('member') && (!member || member.length > 300)) || !allowed.length || [...url.searchParams.keys()].some(k => !allowed.includes(k)) ||
          [...new Set(url.searchParams.keys())].some(k => url.searchParams.getAll(k).length !== 1)) {
        writeJSON(404, { error: 'not_found' }); return;
      }
      Promise.resolve().then(() => activity ? watcher.memberActivity(team, member) : url.pathname === '/api/rules' ? rules.list(team, member) : rules.read(team, id, member)).then(
        body => writeJSON(200, body), error => writeJSON(error.status || 503, { error: error.code || 'reader_unavailable' }),
      );
      return;
    } else if (STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      fs.createReadStream(path.join(PUBLIC, file)).pipe(res);
    } else if (Object.keys(MOUNTS).some((m) => url.pathname.startsWith(m))) {
      const m = Object.keys(MOUNTS).find((k) => url.pathname.startsWith(k));
      let rel;
      try { rel = decodeURIComponent(url.pathname.slice(m.length)); }
      catch { res.writeHead(400).end(); return; }
      serveFile(res, MOUNTS[m], rel);
    } else if (url.pathname.startsWith('/scenes/')) {
      let rel;
      try { rel = decodeURIComponent(url.pathname.slice('/scenes/'.length)); }
      catch { res.writeHead(400).end(); return; }
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
