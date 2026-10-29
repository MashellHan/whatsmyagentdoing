'use strict';
const path = require('node:path');
const os = require('node:os');

// Only known instruction paths at a member's working-directory ancestors and
// provider profile. References come from that exact log's tool requests, never
// from a web path or a guessed member name. The Python reader pins every fd.
const NAMES = ['AGENTS.md', 'AGENTS.override.md', 'TEAM.md', 'TEAMS.md', 'CLAUDE.md', 'GEMINI.md', '.agents/team/playbook.md'];
function instructionPath(relative) {
  return /^(?:AGENTS(?:\.override)?|TEAM|TEAMS|CLAUDE|GEMINI)\.md$/i.test(relative) ||
    /^(?:\.agents\/)?(?:team|teams\/[^/.][^/]*)\/(?:playbook\.md|roles\/[^/.][^/]*\.md)$/i.test(relative) ||
    /^(?:(?:\.agents|\.codex|\.claude|\.gemini|\.copilot)\/)?skills\/(?:\.system\/)?[^/.][^/]*\/SKILL\.md$/i.test(relative) ||
    /^(?:\.claude\/)?agents\/[^/.][^/]*\.md$/i.test(relative);
}
function instructionScopes(context, provider, documents = []) {
  const home = os.homedir(), scopes = new Map();
  const add = (root, label, paths = []) => {
    if (!path.isAbsolute(root) || root === home || root === path.parse(root).root) return;
    if (!scopes.has(root) && scopes.size < 16) scopes.set(root, { root, label, files: [] });
    const scope = scopes.get(root);
    if (scope) for (const file of paths) if (!scope.files.some(f => f.path === file)) scope.files.push({ path: file, association: 'shared' });
  };
  for (const cwd of (context.directories || []).slice(0, 8)) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) continue;
    let dir = path.normalize(cwd);
    for (let i = 0; i < 16 && dir !== home && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
      // Never cross the user's home into other accounts or filesystem roots.
      if (cwd.startsWith(home + path.sep) && !dir.startsWith(home + path.sep)) break;
      add(dir, '工作区规则', NAMES);
    }
  }
  const profiles = {
    codex: process.env.CODEX_HOME || path.join(home, '.codex'),
    claude: process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    gemini: path.join(process.env.GEMINI_CLI_HOME || home, '.gemini'),
    copilot: path.join(home, '.copilot'),
  };
  if (profiles[provider]) add(profiles[provider], 'Agent 全局规则', provider === 'codex' ? ['AGENTS.md', 'AGENTS.override.md'] : provider === 'claude' ? ['CLAUDE.md'] : provider === 'gemini' ? ['GEMINI.md'] : []);
  // Cross-provider skills can be read explicitly without being all assigned to
  // the member. A directory containing SKILL.md alone is not an association.
  for (const name of ['.agents', '.codex', '.claude', '.gemini', '.copilot']) add(path.join(home, name), '会话读取的 Skill / 准则');
  for (const absolute of documents.slice(0, 32)) {
    if (typeof absolute !== 'string' || !path.isAbsolute(absolute)) continue;
    for (const scope of scopes.values()) {
      const relative = path.relative(scope.root, absolute).split(path.sep).join('/');
      if (!instructionPath(relative)) continue;
      const prior = scope.files.find(f => f.path === relative);
      if (prior) prior.association = 'observed';
      else if (scope.files.length < 40) scope.files.push({ path: relative, association: 'observed' });
      break;
    }
  }
  return [...scopes.values()].filter(scope => scope.files.length);
}
module.exports = { instructionScopes };
