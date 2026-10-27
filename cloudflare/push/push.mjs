#!/usr/bin/env node
// mini-1 push agent. Reads the local (privacy-mode) snapshot from the running
// fork server, applies the whitelist, and POSTs it to agent-town-ingest on
// change plus a heartbeat every 20s. Config: a mode-0600 JSON file
//   { "url": "https://agent-town-ingest.<sub>.workers.dev", "token": "...",
//     "source": "http://127.0.0.1:4546/api/sessions" }
// The token is never logged.
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeSnapshot, signature, HEARTBEAT_MS } from '../shared/whitelist.mjs';

const POLL_MS = 2000;

// Opaque, stable member keys: no pane ids or session ids leave mini-1.
export function prepare(raw, sourceOk) {
  const sessions = (raw?.sessions || []).map((s) => ({ ...s, key: `k_${createHash('sha256').update(String(s.key || '')).digest('hex').slice(0, 16)}` }));
  return sanitizeSnapshot({ ...raw, sessions }, { sourceOk });
}

export function shouldSend(sig, state, now) {
  return sig !== state.sig || now - state.sentAt >= HEARTBEAT_MS;
}

function loadConfig(file) {
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`${file} must be mode 0600`);
  const c = JSON.parse(readFileSync(file, 'utf8'));
  if (!/^https:\/\//.test(c.url || '') || typeof c.token !== 'string' || c.token.length < 32) throw new Error('invalid config');
  return { source: 'http://127.0.0.1:4546/api/sessions', ...c };
}

async function main() {
  const file = process.env.AGENT_TOWN_PUSH_CONFIG || join(homedir(), '.config', 'agent-town', 'push.json');
  const config = loadConfig(file);
  const state = { sig: '', sentAt: 0, last: null, failures: 0 };
  const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
  log(`agent-town push started -> ${new URL(config.url).host}`);
  for (;;) {
    let raw = null, ok = true;
    try {
      const res = await fetch(config.source, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`source ${res.status}`);
      raw = await res.json();
      state.last = raw;
    } catch {
      ok = false; raw = state.last || { sessions: [], teams: [] };
    }
    const snapshot = prepare(raw, ok);
    const sig = signature(snapshot);
    const now = Date.now();
    if (shouldSend(sig, state, now)) {
      try {
        const res = await fetch(`${config.url}/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
          body: JSON.stringify({ sourceOk: ok, snapshot }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`ingest ${res.status}`);
        const body = await res.json();
        if (body.changed || state.failures) log(`pushed teams=${body.teams} sessions=${body.sessions} viewers=${body.viewers} changed=${body.changed} sourceOk=${ok}`);
        state.sig = sig; state.sentAt = now; state.failures = 0;
      } catch (e) {
        state.failures++;
        if (state.failures <= 3 || state.failures % 30 === 0) log(`push failed (${e.message}); retrying`);
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(`fatal: ${e.message}`); process.exit(1); });
