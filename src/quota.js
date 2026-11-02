'use strict';

const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { homedir } = require('node:os');
const { sanitizeQuotaSnapshot, POLL_MS } = require('./quota-schema');
const exec = promisify(execFile);
const FILTER = '{login,copilot_plan,quota_reset_date,quota_snapshots:{premium_interactions:(.quota_snapshots.premium_interactions|{unlimited,has_quota,percent_remaining,credits_used,entitlement}),chat:{unlimited:.quota_snapshots.chat.unlimited},completions:{unlimited:.quota_snapshots.completions.unlimited}}}';

function invalid(code) { return Object.assign(new Error(`quota ${code}`), { quotaError: code }); }

function normalizeQuota(account, raw, now) {
  if (typeof raw?.login !== 'string' || raw.login.toLowerCase() !== account.login.toLowerCase()) throw invalid('identity');
  const p = raw.quota_snapshots?.premium_interactions;
  if (!p || typeof p.unlimited !== 'boolean' || (!p.unlimited && (p.has_quota !== true || typeof p.percent_remaining !== 'number' || !Number.isFinite(p.percent_remaining) || p.percent_remaining < 0 || p.percent_remaining > 100))) throw invalid('invalid-response');
  return sanitizeQuotaSnapshot({ capturedAt: now, accounts: [{
    ...account, plan: raw.copilot_plan, status: 'ok', error: null, checkedAt: now, updatedAt: now,
    resetDate: raw.quota_reset_date,
    premium: { unlimited: p.unlimited, hasQuota: p.has_quota, remainingPercent: p.percent_remaining, used: p.credits_used, limit: p.entitlement },
    chatUnlimited: raw.quota_snapshots.chat?.unlimited,
    completionsUnlimited: raw.quota_snapshots.completions?.unlimited,
  }] }).accounts[0];
}

async function queryHelper(helper, account, { signal }) {
  const env = { ...process.env };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_DEBUG', 'GH_HOST']) delete env[key];
  try {
    // The existing helper selects a keyring credential and verifies /user
    // before querying quota. No tokens travel in command arguments or output.
    const { stdout } = await exec('python3', [helper, 'gh', account.id, 'api', 'copilot_internal/user', '--jq', FILTER], { env, signal, timeout: 30_000, maxBuffer: 64 * 1024 });
    try { return JSON.parse(stdout); } catch { throw invalid('invalid-response'); }
  } catch (error) {
    if (error.quotaError) throw error;
    throw invalid(/No stored credential|HTTP 401/i.test(error.stderr || '') ? 'authentication' : 'request');
  }
}

class QuotaMonitor extends EventEmitter {
  constructor({ accounts, query, now = Date.now }) {
    super();
    this.accounts = accounts;
    this.query = query;
    this.now = now;
    this.state = sanitizeQuotaSnapshot({ capturedAt: null, accounts: accounts.map(a => ({ ...a, status: 'pending' })) });
    this.controller = new AbortController();
    this.stopped = false;
    this.inFlight = null;
  }
  snapshot() { return sanitizeQuotaSnapshot(this.state); }
  refresh() {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const checkedAt = this.now();
    this.inFlight = Promise.all(this.accounts.map(async (account, i) => {
      try { return normalizeQuota(account, await this.query(account, { signal: this.controller.signal }), checkedAt); }
      catch (error) {
        return { ...this.state.accounts[i], checkedAt, status: error.quotaError === 'authentication' ? 'auth-required' : 'error', error: error.quotaError || 'request' };
      }
    })).then(accounts => {
      if (this.stopped) return;
      this.state = sanitizeQuotaSnapshot({ capturedAt: checkedAt, accounts });
      this.emit('change');
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  start() {
    if (this.timer || this.stopped) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, POLL_MS);
    this.timer.unref();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.controller.abort();
  }
}

function configuredQuotaMonitor(file = process.env.WMAD_QUOTA_CONFIG || path.join(homedir(), '.config', 'agent-town', 'quota.json')) {
  if (!fs.existsSync(file)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!path.isAbsolute(config.helper || '') || !fs.statSync(config.helper).isFile() || !Array.isArray(config.profiles) || !config.profiles.length || config.profiles.length > 8 || new Set(config.profiles).size !== config.profiles.length) throw invalid('invalid-response');
    const mapping = JSON.parse(fs.readFileSync(path.join(path.dirname(config.helper), '../references/accounts.json'), 'utf8'));
    const accounts = config.profiles.map(id => {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw invalid('invalid-response');
      const entry = mapping[id];
      const result = sanitizeQuotaSnapshot({ accounts: [{ id, host: entry?.host, login: entry?.login }] });
      if (result.accounts.length !== 1) throw invalid('identity');
      return { id, host: entry.host, login: entry.login };
    });
    return new QuotaMonitor({ accounts, query: (account, options) => queryHelper(config.helper, account, options) });
  } catch {
    throw new Error('Copilot quota configuration is invalid; check the helper path and confirmed account profiles.');
  }
}

module.exports = { QuotaMonitor, normalizeQuota, configuredQuotaMonitor };
