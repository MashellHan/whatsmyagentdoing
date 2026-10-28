const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execute = promisify(require('node:child_process').execFile);

test('the CLI reads an explicitly selected team outside Herdr without inventing caller context', async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'myoffice-herdr-session-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const bin = path.join(fixture, 'bin');
  fs.mkdirSync(bin);
  const callsFile = path.join(fixture, 'calls.jsonl');
  fs.writeFileSync(path.join(bin, 'herdr'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "fs.appendFileSync(process.env.WMAD_TEST_CALLS, JSON.stringify({ args, herdrEnv: process.env.HERDR_ENV ?? null }) + '\\n');",
    "if (args[0] !== '--session' || args[1] !== 'fixture-session' || args[3] !== 'list') process.exit(2);",
    "const field = args[2] === 'workspace' ? 'workspaces' : args[2] === 'agent' ? 'agents' : null;",
    'if (!field) process.exit(2);',
    "const record = field === 'workspaces' ? { workspace_id: 'fixture-team', label: 'Fixture team', agent_status: 'working' } : { workspace_id: 'fixture-team', pane_id: 'fixture-pane', name: 'Fixture member', agent: 'codex', agent_status: 'working' };",
    'console.log(JSON.stringify({ result: { [field]: [record] } }));',
  ].join('\n'), { mode: 0o755 });
  const env = { ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    CLAUDE_CONFIG_DIR: path.join(fixture, 'claude'),
    CODEX_HOME: path.join(fixture, 'codex'),
    GEMINI_CLI_HOME: path.join(fixture, 'gemini'),
    WMAD_TEST_CALLS: callsFile,
  };
  for (const key of Object.keys(env)) if (key.startsWith('HERDR_')) delete env[key];
  const run = args => execute(process.execPath, ['bin/cli.js', ...args], {
    cwd: path.join(__dirname, '..'), env, timeout: 10000,
  });

  for (const selector of [['--herdr-session', 'fixture-session'], ['--herdr-session=fixture-session']]) {
    const { stdout } = await run([...selector, '--json']);
    const data = JSON.parse(stdout);
    assert.equal(data.source.kind, 'logs+herdr');
    assert.equal(data.source.presence, 'fresh');
    assert.equal(data.source.scope, 'selected-herdr-session');
    assert.equal(data.source.session, 'fixture-session');
    assert.deepEqual(data.teams.map(team => team.id), ['fixture-team']);
    assert.equal(data.sessions.length, 1);
    assert.equal(data.sessions[0].displayName, 'Fixture member');
    assert.equal(data.sessions[0].teamId, 'fixture-team');
    assert.equal(data.sessions[0].status, 'thinking');
    assert.equal(data.sessions[0].statusSource, 'herdr');
  }
  const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.herdrEnv === null));

  await assert.rejects(run(['--json']), error => error.code === 1 && /pass --herdr-session/.test(error.stderr));
  for (const args of [['--herdr-session'], ['--herdr-session='], ['--herdr-session', '--json']]) {
    await assert.rejects(run(args), error => error.code === 1 && /requires a session name/.test(error.stderr));
  }
  for (const mode of ['--logs', '--demo']) {
    await assert.rejects(run(['--herdr-session', 'fixture-session', mode, '--json']), error => error.code === 1 && /cannot be combined/.test(error.stderr));
  }
  assert.equal(fs.readFileSync(callsFile, 'utf8').trim().split('\n').length, 4, 'invalid or ambiguous mode selections never contact Herdr');
});
