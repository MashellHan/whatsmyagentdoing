'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const { sessionFiles, CODEX_DIR } = require('./watcher');
const { dayKey } = require('./parsers');
const { sanitizeUsage, AGENTS } = require('./usage-schema');

const DAY = 86_400_000;
const counter = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
function sum(usage, fields) {
  if (!usage || typeof usage !== 'object') return null;
  const values = fields.map(key => usage[key]).filter(value => value !== undefined);
  if (!values.length || values.some(value => !counter(value))) return null;
  const total = values.reduce((a, b) => a + b, 0);
  return counter(total) ? total : null;
}

function record(agent, event, state) {
  let at = timestamp(event.timestamp), tokens = null, id;
  if (agent === 'codex') {
    if (event.type !== 'event_msg' || event.payload?.type !== 'token_count') return null;
    const info = event.payload.info;
    if (!info?.last_token_usage) return null;
    const total = info.total_token_usage;
    const totalTokens = sum(total, ['input_tokens', 'output_tokens']) ?? (counter(total?.total_tokens) ? total.total_tokens : null);
    const fingerprint = totalTokens === null ? null : String(totalTokens);
    // Codex re-emits the same cumulative usage when only rate limits change.
    if (fingerprint && fingerprint === state.codexTotal) return null;
    tokens = sum(info.last_token_usage, ['input_tokens', 'output_tokens']);
    if (tokens === null || !Number.isFinite(at) || at <= 0) return null;
    state.codexTotal = fingerprint;
    id = `${at}:${fingerprint || JSON.stringify(info.last_token_usage)}`;
  } else if (agent === 'claude') {
    if (event.type !== 'assistant' || event.message?.model === '<synthetic>') return null;
    const message = event.message;
    tokens = sum(message?.usage, ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']);
    id = message?.id || event.uuid;
  } else if (agent === 'copilot') {
    if (!['session.usage_record', 'assistant.usage'].includes(event.type)) return null;
    const usage = event.data?.usage || event.data;
    // Copilot input includes cache reads/writes; output includes reasoning.
    tokens = sum(usage, ['inputTokens', 'outputTokens']);
    id = usage?.accounting?.usageId ? `${usage.accounting.sourceSessionId || ''}:${usage.accounting.usageId}` : usage?.apiCallId || usage?.providerCallId || event.id;
  } else if (agent === 'gemini') {
    if (event.type !== 'gemini') return null;
    tokens = counter(event.tokens?.total) ? event.tokens.total : sum(event.tokens, ['input', 'output', 'thoughts', 'tool']);
    id = event.id;
  } else if (agent === 'omp') {
    if (event.type !== 'message' || event.message?.role !== 'assistant') return null;
    const message = event.message;
    at = timestamp(event.timestamp || message.timestamp);
    tokens = counter(message.usage?.totalTokens) ? message.usage.totalTokens : sum(message.usage, ['input', 'output', 'cacheRead', 'cacheWrite']);
    id = event.id || message.id;
  }
  if (!Number.isFinite(at) || at <= 0 || tokens === null) return null;
  return { key: `${agent}:${id || `${at}:${tokens}`}`, at, tokens, agent };
}

function periodStart(now) {
  const date = new Date(now);
  return Math.min(new Date(date.getFullYear(), date.getMonth(), 1).getTime(), now - 14 * DAY);
}

async function localFiles(since, ompDir) {
  const files = sessionFiles(since, ompDir);
  const archived = path.join(path.dirname(CODEX_DIR), 'archived_sessions');
  let entries = [];
  try { entries = await fs.promises.readdir(archived, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push({ agent: 'codex', file: path.join(archived, entry.name) });
  return files;
}

class UsageMonitor extends EventEmitter {
  constructor({ files, ompDir, now = Date.now, interval = 30_000 } = {}) {
    super();
    this.files = files || (since => localFiles(since, ompDir));
    this.now = now;
    this.interval = interval;
    this.trackers = new Map();
    this.value = sanitizeUsage({ status: 'loading' });
  }
  snapshot() { return this.value; }
  start() {
    if (this.timer) return this;
    this.stopped = false;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.interval);
    this.timer.unref();
    return this;
  }
  stop() { this.stopped = true; clearInterval(this.timer); this.timer = null; this.stream?.destroy(); }
  poll() {
    if (this.pending) return this.pending;
    this.pending = this.collect().catch(() => {
      if (!this.stopped) { this.value = sanitizeUsage({ ...this.value, status: this.value.updatedAt ? 'partial' : 'unavailable' }); this.emit('change'); }
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  observe(tracker, agent, event, since) {
    if (agent === 'gemini' && Array.isArray(event.$set?.messages)) {
      for (const message of event.$set.messages) this.observe(tracker, agent, message, since);
      return;
    }
    const item = record(agent, event, tracker);
    if (!item || item.at < since) return;
    const previous = tracker.records.get(item.key);
    if (!previous || item.tokens >= previous.tokens) tracker.records.set(item.key, item);
  }
  async read(candidate, stat, since) {
    let tracker = this.trackers.get(candidate.file);
    if (!tracker || tracker.ino !== stat.ino || stat.size < tracker.offset || (stat.size === tracker.offset && stat.mtimeMs !== tracker.mtime)) {
      tracker = { offset: 0, ino: stat.ino, decoder: new StringDecoder('utf8'), partial: '', records: new Map() };
      this.trackers.set(candidate.file, tracker);
    }
    if (tracker.offset === stat.size) return;
    if (candidate.file.endsWith('.json')) {
      if (stat.size > 32 * 1024 * 1024) throw new Error('usage document too large');
      const doc = JSON.parse(await fs.promises.readFile(candidate.file, 'utf8'));
      tracker.records.clear();
      for (const message of doc.messages || []) this.observe(tracker, candidate.agent, message, since);
    } else {
      const stream = fs.createReadStream(candidate.file, { start: tracker.offset, end: stat.size - 1 });
      this.stream = stream;
      for await (const chunk of stream) {
        if (this.stopped) { stream.destroy(); return; }
        const lines = (tracker.partial + tracker.decoder.write(chunk)).split('\n');
        tracker.partial = lines.pop();
        for (const line of lines) {
          // Avoid decoding prompts/tool output while streaming large histories.
          if (!/"(?:token_count|usage|tokens)"\s*[: ,}]/.test(line)) continue;
          try { this.observe(tracker, candidate.agent, JSON.parse(line), since); } catch {}
        }
        tracker.offset += chunk.length;
      }
      this.stream = null;
    }
    tracker.offset = stat.size;
    tracker.mtime = stat.mtimeMs;
  }
  async collect() {
    const since = periodStart(this.now()), seen = new Set();
    let errors = 0;
    for (const candidate of await this.files(since)) {
      if (this.stopped) return;
      if (!AGENTS.has(candidate.agent) || seen.has(candidate.file)) continue;
      try {
        const stat = await fs.promises.stat(candidate.file);
        if (!stat.isFile() || stat.mtimeMs < since) continue;
        seen.add(candidate.file);
        await this.read(candidate, stat, since);
      } catch { errors++; }
    }
    if (this.stopped) return;
    const now = this.now(), date = new Date(now);
    const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const monthStart = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
    const unique = new Map();
    for (const [file, tracker] of this.trackers) {
      if (!seen.has(file)) { this.trackers.delete(file); continue; }
      for (const [key, item] of tracker.records) {
        if (item.at < since) { tracker.records.delete(key); continue; }
        if (item.at > now) continue;
        const previous = unique.get(key);
        if (!previous || item.tokens > previous.tokens) unique.set(key, item);
      }
    }
    const value = { status: unique.size ? errors ? 'partial' : 'ready' : 'unavailable', updatedAt: now,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, day: dayKey(now), month: dayKey(now).slice(0, 7),
      agents: [...new Set([...unique.values()].map(item => item.agent))].sort(),
      todayTokens: 0, monthTokens: 0, weekTokens: 0, previousWeekTokens: 0 };
    for (const item of unique.values()) {
      if (item.at >= midnight) value.todayTokens += item.tokens;
      if (item.at >= monthStart) value.monthTokens += item.tokens;
      if (item.at >= now - 7 * DAY) value.weekTokens += item.tokens;
      else if (item.at >= now - 14 * DAY) value.previousWeekTokens += item.tokens;
    }
    this.value = sanitizeUsage(value);
    this.emit('change');
  }
}

module.exports = { UsageMonitor };
