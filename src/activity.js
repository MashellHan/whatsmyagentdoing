'use strict';

// Private, bounded observations of tool requests. Never attach these to session
// snapshots: only the on-demand local member endpoint may expose the snippets.
const { createHash } = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const LIMIT = 30, TEXT_LIMIT = 360, SCAN_LIMIT = 64 * 1024;

function clipped(value, max = TEXT_LIMIT) {
  const text = typeof value === 'string' ? value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim() : '';
  // Keep surrogate pairs intact, including when a command contains emoji.
  const chars = Array.from(text.slice(0, max * 2 + 2));
  const truncated = chars.length > max || text.length > max * 2 + 2;
  return { text: truncated ? chars.slice(0, max - 1).join('') + '…' : chars.join(''), truncated };
}
function argumentsOf(value) {
  if (typeof value !== 'string') return value || {};
  if (value.length <= SCAN_LIMIT) { try { return JSON.parse(value); } catch {} }
  return value.slice(0, SCAN_LIMIT);
}
function commandText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(x => typeof x === 'string')) {
    return value.some(x => ['-c', '-lc'].includes(x)) ? value.at(-1) : value.join(' ');
  }
  return '';
}
function stringLiteral(value) {
  if (value.startsWith('"')) { try { return JSON.parse(value); } catch {} }
  // Decode only simple escapes. Never evaluate JS, shell or template strings.
  return value.slice(1, -1).replace(/\\([\\'"nrt])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' }[c] || c));
}
function descriptions(name, value) {
  const args = argumentsOf(value);
  if (typeof args === 'string') {
    if (/(?:^|\.)exec$/.test(name)) {
      const commands = [...args.matchAll(/\b(?:cmd|command)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)]
        .slice(-LIMIT).map(m => ({ text: stringLiteral(m[1]), cwd: null }));
      if (commands.length) return commands;
    }
    return [{ text: args, cwd: null }];
  }
  const command = commandText(args?.cmd || args?.command || args?.action?.command);
  const text = command || args?.file_path || args?.absolute_path || args?.path || args?.pattern || args?.query || args?.url || args?.skill || '';
  return [{ text: typeof text === 'string' ? text : '', cwd: args?.workdir || args?.cwd || null }];
}

function calls(agent, d) {
  const p = d.payload || {}, m = d.message || {}, data = d.data || {};
  if (agent === 'codex') {
    if (d.type === 'response_item' && ['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call'].includes(p.type)) {
      return [{ id: p.call_id || p.id, name: p.name || p.type, args: p.arguments ?? p.input ?? p.action }];
    }
    if (d.type === 'event_msg' && p.type === 'item_started') {
      const item = p.item || {};
      if (item.type === 'CommandExecution') return [{ id: item.id, name: 'Shell', args: { command: item.command } }];
      if (item.type === 'McpToolCall') return [{ id: item.id, name: `${item.server || 'mcp'}.${item.tool || 'tool'}`, args: item.arguments }];
      if (item.type === 'FileChange') return [{ id: item.id, name: 'FileChange', args: Object.keys(item.changes || {}).join('\n') }];
    }
  }
  if (agent === 'claude' && d.type === 'assistant') return (Array.isArray(m.content) ? m.content : [])
    .filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input }));
  if (agent === 'gemini') {
    if (d.type === 'gemini') return (d.toolCalls || []).map(tc => ({ id: tc.id, name: tc.name || tc.displayName, args: tc.args }));
  }
  if (agent === 'copilot' && d.type === 'tool.execution_start') return [{ id: data.toolCallId || d.id, name: data.toolName || data.tool_name, args: data.arguments || data.args }];
  if (agent === 'omp') {
    if (d.type === 'custom' && d.customType === 'tool_execution_start') return [{ id: data.toolCallId, name: data.toolName, args: data.args }];
    if (d.type === 'message' && m.role === 'assistant') return (Array.isArray(m.content) ? m.content : [])
      .filter(b => b.type === 'toolCall').map(b => ({ id: b.id, name: b.name, args: b.arguments }));
  }
  if (agent === 'kimi' && d.type === 'context.append_loop_event' && d.event?.type === 'tool.call') {
    const e = d.event; return [{ id: e.toolCallId, name: e.name, args: e.arguments || e.input }];
  }
  if (agent === 'dsh' && d.type === 'tool/call') return [{ id: data.callId, name: data.name, args: data.arguments || data.input }];
  if (agent === 'grok' && d.params?.update?.sessionUpdate === 'tool_call') {
    const e = d.params.update; return [{ id: e.toolCallId, name: e.title || e._meta?.['x.ai/tool']?.name, args: e.rawInput }];
  }
  return [];
}

class RecentActivity {
  constructor() { this.entries = new Map(); this.documents = new Set(); }
  observe(session, d) {
    if (!d || typeof d !== 'object') return;
    const messages = session.agent === 'gemini' && (d.$set?.messages || (!d.type && d.messages));
    if (Array.isArray(messages)) {
      for (const message of messages) if (message?.type === 'gemini') this.observe(session, message);
      return;
    }
    const requests = calls(session.agent, d).slice(-LIMIT);
    if (!requests.length) return;
    let at = d.timestamp ?? d.time ?? d.message?.timestamp;
    if (typeof at === 'number') at = at < 1e11 ? at * 1000 : at;
    else at = Date.parse(at);
    if (!Number.isFinite(at)) at = session.lastEventAt || null;
    for (const call of requests) {
      const tool = clipped(call.name || 'tool', 80).text;
      for (const [index, detail] of descriptions(tool, call.args).entries()) {
        const value = clipped(detail.text || tool);
        const identity = call.id ? `${call.id}:${index}` : `${at}:${tool}:${index}:${value.text}`;
        const id = createHash('sha256').update(identity).digest('hex').slice(0, 24);
        // Repeated whole-message updates (Gemini/OMP) update the original row.
        this.entries.set(id, { id, at, tool, ...value });
        if (/(?:read|exec|shell|bash|cat)/i.test(tool)) this.rememberDocuments(detail.text, detail.cwd || session.cwd);
      }
    }
    // Whole-message updates may arrive after newer requests. Keep the most
    // recent request times, not a re-appended old message's arrival order.
    this.entries = new Map([...this.entries].sort((a, b) => (a[1].at || 0) - (b[1].at || 0)).slice(-LIMIT));
  }
  rememberDocuments(text, cwd) {
    if (typeof text !== 'string' || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return;
    const matches = text.slice(0, SCAN_LIMIT).matchAll(/"([^"\n]+\.md)"|'([^'\n]+\.md)'|([^\s`"';|<>]+\.md)\b/gi);
    for (const m of matches) {
      const file = m[1] || m[2] || m[3];
      if (!/(?:^|\/)(?:agents|team|teams|claude|gemini|skill)\.md$/i.test(file) &&
          !/(?:^|\/)\.agents\/(?:team|teams\/[^/]+)\/(?:playbook\.md|roles\/[^/]+\.md)$/i.test(file) &&
          !/(?:^|\/)\.claude\/agents\/[^/]+\.md$/i.test(file)) continue;
      const absolute = path.resolve(cwd, file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file);
      this.documents.add(absolute);
      while (this.documents.size > 32) this.documents.delete(this.documents.values().next().value);
    }
  }
  snapshot() { return { entries: [...this.entries.values()].map(row => ({ ...row })), limit: LIMIT, textLimit: TEXT_LIMIT }; }
}

module.exports = { RecentActivity, LIMIT, TEXT_LIMIT };
