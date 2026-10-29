'use strict';
const { execFile } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const path = require('node:path');

class RulesError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
class RulesReader {
  constructor(context, { python = process.env.WMAD_RULES_PYTHON || (process.platform === 'darwin' ? '/usr/bin/python3' : 'python3'), now = Date.now } = {}) {
    this.context = context; this.python = python; this.now = now;
    this.lists = new Map(); this.pending = 0; this.lastRequests = new Map();
  }
  current(team, member = null) {
    const context = this.context(team, member);
    if (!context) throw new RulesError('scope_unavailable', 503);
    return { context, signature: createHash('sha256').update(JSON.stringify(context)).digest('hex') };
  }
  async run(input) {
    if (this.pending >= 4) throw new RulesError('busy', 429);
    this.pending++;
    try {
      return await new Promise((resolve, reject) => {
        const child = execFile(this.python, ['-I', '-B', path.join(__dirname, 'rules_fs.py')], { timeout: 3000, maxBuffer: 3 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
          if (error) return reject(new RulesError('reader_unavailable', 503));
          let result;
          try { result = JSON.parse(stdout); } catch { return reject(new RulesError('reader_unavailable', 503)); }
          if (!result.ok) return reject(new RulesError(result.error, result.error === 'too_large' ? 413 : result.error === 'not_utf8' ? 422 : 409));
          resolve(result);
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(input));
      });
    } finally { this.pending--; }
  }
  async list(team, member = null) {
    const scope = member ? JSON.stringify([team, member]) : team;
    const now = this.now(), previous = this.lastRequests.get(scope);
    if (previous != null && now - previous < 500) throw new RulesError('rate_limited', 429);
    const { context, signature } = this.current(team, member);
    this.lastRequests.set(scope, now);
    for (const [key, record] of this.lists) if (now - record.time > 300_000) { this.lists.delete(key); this.lastRequests.delete(key); }
    if (this.lists.size >= 32 && !this.lists.has(scope)) { const key = this.lists.keys().next().value; this.lists.delete(key); this.lastRequests.delete(key); }
    const generation = randomBytes(16).toString('hex');
    this.lists.set(scope, { generation, time: now, signature, entries: new Map() });
    const result = await this.run({ mode: 'list', ...context });
    if (this.current(team, member).signature !== signature || this.lists.get(scope)?.generation !== generation) throw new RulesError('scope_changed', 409);
    const entries = new Map();
    const files = result.files.map(file => { const id = randomBytes(20).toString('hex'); entries.set(id, file); return { id, path: file.path, scope: file.scope, size: file.size, association: file.association || 'shared' }; });
    this.lists.set(scope, { generation, time: now, signature, entries });
    return { files, warnings: result.warnings, scopeCount: result.scopeCount };
  }
  async read(team, id, member = null) {
    const scope = member ? JSON.stringify([team, member]) : team;
    if (!/^[a-f0-9]{40}$/.test(id || '')) throw new RulesError('not_found', 404);
    const record = this.lists.get(scope), entry = record?.entries.get(id);
    if (!entry || this.now() - record.time > 300_000) throw new RulesError('not_found', 404);
    if (record.signature !== this.current(team, member).signature) throw new RulesError('scope_changed', 409);
    const result = await this.run({ mode: 'read', ...entry });
    if (record !== this.lists.get(scope) || record.signature !== this.current(team, member).signature) throw new RulesError('scope_changed', 409);
    return { path: entry.path, scope: entry.scope, content: result.content, readAt: this.now() };
  }
}

module.exports = { RulesReader, RulesError };
