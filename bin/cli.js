#!/usr/bin/env node
'use strict';

// This local team dashboard never phones home or updates the checkout.
process.env.WMAD_NO_UPDATE_CHECK = '1';

const http = require('http');
const { spawn } = require('child_process');
const { Watcher, CLAUDE_DIR, CODEX_DIR, GEMINI_DIR } = require('../src/watcher');
const { DemoWatcher } = require('../src/demo');
const { HerdrWatcher } = require('../src/herdr');
const { TeamWatcher } = require('../src/teams');
const fs = require('fs');
const path = require('path');
const scenes = require('../src/scenes');
const updater = require('../src/update');
const { createServer, snapshot } = require('../src/server');
const pkg = require('../package.json');

const HELP = `whatsmyagentdoing ${pkg.version}
See what every Claude Code, Codex and Gemini CLI agent on this machine is doing, live.

Usage: node bin/cli.js [options]   (or /myoffice as a skill)

Options:
  -p, --port <n>    Port to serve on (default 4546)
  --hours <n>       Show sessions active in the last n hours (default 24)
  --no-open         Don't open the browser
  --private         Hide prompts, replies and titles (always enabled)
  --logs            Read local logs instead of Herdr; show an ungrouped house
  --team-map <file>  Explicit leader map (default config/team-houses.json)
  --json            Print one snapshot as JSON and exit
  --demo            Show a made-up team instead of your sessions
  --stop            Stop a running dashboard
  --scenes          List already installed 3D scenes
  --scene <id>      Open the legacy office with an already installed scene
  -h, --help        Show this help

Default: Herdr team identity + exact session log status (read only).
--logs reads logs without Herdr grouping. Log locations:
  ${CLAUDE_DIR}
  ${CODEX_DIR}
  ${GEMINI_DIR}
Override with CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI_CLI_HOME.`;

function parseArgs(argv) {
  const o = { port: 4546, hours: 24, open: true, privacy: true, logs: false, teamMap: path.join(__dirname, '../config/team-houses.json'), json: false, demo: false, stop: false, scenes: false, scene: null, removeScene: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '-v' || a === '--version') { console.log(pkg.version); process.exit(0); }
    else if (a === '-p' || a === '--port') o.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) o.port = Number(a.slice(7));
    else if (a === '--hours') o.hours = Number(argv[++i]);
    else if (a.startsWith('--hours=')) o.hours = Number(a.slice(8));
    else if (a === '--no-open') o.open = false;
    else if (a === '--private') o.privacy = true;
    else if (a === '--logs') o.logs = true;
    else if (a === '--team-map') o.teamMap = argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '--demo') o.demo = true;
    else if (a === '--stop') o.stop = true;
    else if (a === '--update') throw new Error('Updates are disabled in this local-only build.');
    else if (a === '--scenes') o.scenes = true;
    else if (a === '--scene') o.scene = argv[++i];
    else if (a.startsWith('--scene=')) o.scene = a.slice(8);
    else if (a === '--remove-scene') throw new Error('Scene mutations are disabled in this read-only build.');
    else { console.error(`Unknown option: ${a}\n\n${HELP}`); process.exit(1); }
  }
  if (!Number.isInteger(o.port) || o.port < 1024 || o.port > 65535 || !Number.isFinite(o.hours) || o.hours <= 0) { console.error(HELP); process.exit(1); }
  return o;
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

function alreadyRunning(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body).app === 'agent-office-team-houses'); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function stopAt(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/shutdown', method: 'POST', timeout: 1500,
      headers: { 'x-whatsmyagentdoing': 'stop' } }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));

  if (o.scenes) {
    const have = scenes.installed();
    const name = (x) => (x.name && (x.name.en || Object.values(x.name)[0])) || x.id;
    console.log('3D scenes (pick one with --scene <id>, or from the scene menu in High 3D):');
    console.log('  office      Office (built in)');
    for (const x of have) console.log(`  ${x.id.padEnd(11)} ${name(x)} (installed)`);
    return;
  }

  if (o.scene && o.scene !== 'office') {
    try {
      if (!scenes.sceneDir(o.scene)) throw new Error('Scene downloads are disabled in this local-only build.');
    } catch (e) {
      console.error(String(e.message || e));
      process.exit(1);
    }
  }

  if (o.stop) {
    // Never stop an original instance or scan neighboring ports.
    const running = await alreadyRunning(o.port);
    if (running) await stopAt(o.port);
    console.log(running ? `Stopped http://127.0.0.1:${o.port}` : 'No Team Houses instance on that port.');
    return;
  }

  let teamMap = {};
  if (!o.demo && !o.logs) {
    if (process.env.HERDR_ENV !== '1') throw new Error('Start from a Herdr-managed pane (HERDR_ENV=1), or use --logs/--demo.');
    if (fs.existsSync(o.teamMap)) teamMap = JSON.parse(fs.readFileSync(o.teamMap, 'utf8'));
  }
  const watcher = o.demo ? new DemoWatcher() : o.logs ? new Watcher({ hours: o.hours })
    : new TeamWatcher({ herdr: new HerdrWatcher({ teamMap }), logs: new Watcher({ hours: o.hours }) });

  if (o.json) {
    if (o.demo) watcher.start();
    else { await watcher.tick(); if (o.logs) { watcher.lastScan = 0; watcher.tick(); } }
    console.log(JSON.stringify(snapshot(watcher, o), null, 2));
    watcher.stop();
    return;
  }

  const query = o.scene ? `/office?view=office&quality=high&scene=${encodeURIComponent(o.scene)}` : '';
  if (await alreadyRunning(o.port)) {
    const url = `http://127.0.0.1:${o.port}${query}`;
    console.log(`Already running at ${url}`);
    if (o.open) openBrowser(url);
    return;
  }

  watcher.start();
  const server = createServer(watcher, o, {
    onShutdown: () => { watcher.stop(); server.close(); process.exit(0); },
  });
  const shutdown = () => { watcher.stop(); server.closeAllConnections?.(); server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const listen = (port, tries) => {
    server.once('error', (err) => {
      console.error(err.message); watcher.stop(); process.exit(1);
    });
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}`;
      const n = watcher.sessions().length;
      const openUrl = url + query;
      const what = o.demo ? 'demo team' : o.logs ? `${n} local log sessions` : 'read-only Herdr teams · private';
      console.log(`whatsmyagentdoing v${updater.localVersion()} → ${url}  (${what}, Ctrl+C to stop)`);
      if (o.open) openBrowser(openUrl);
    });
  };
  listen(o.port, 0);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
