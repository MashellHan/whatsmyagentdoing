const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const { RulesReader } = require('../src/rules');
const { createServer, snapshot } = require('../src/server');

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-rules-'));
  const root = path.join(temp, 'repo'), outside = path.join(temp, 'outside');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs')); fs.mkdirSync(path.join(root, '.codex'));
  fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Fixture rules\n\nNo real data.');
  fs.writeFileSync(path.join(root, 'teams.md'), '- Team fixture');
  fs.writeFileSync(path.join(root, 'docs', 'TEAM-GUIDE.md'), '**Fixture**');
  fs.writeFileSync(path.join(root, '.codex', 'AGENTS.md'), 'Code fixture');
  fs.writeFileSync(path.join(root, 'src', 'CLAUDE.md'), 'Subdirectory fixture');
  fs.writeFileSync(path.join(root, 'docs', 'extra.md'), 'Extra fixture');
  fs.writeFileSync(path.join(outside, 'SECRET.md'), 'OUTSIDE_SENTINEL');
  let now = 1000, context = { directories: [path.join(root, 'src')], extraFiles: ['docs/extra.md'], roots: [] };
  const reader = new RulesReader(team => team === 'fixture' ? context : null, { now: () => now });
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return { root, outside, reader, tick: () => { now += 1000; }, expire: () => { now += 301000; }, change: value => { context = value; } };
}

test('rules discovery is bounded to known repo/cwd and reads only selected files', async t => {
  const f = fixture(t); const list = await f.reader.list('fixture');
  assert.deepEqual(list.files.map(x => x.path).sort(), ['.codex/AGENTS.md', 'AGENTS.md', 'docs/TEAM-GUIDE.md', 'docs/extra.md', 'src/CLAUDE.md', 'teams.md']);
  assert.equal(JSON.stringify(list).includes(f.root), false);
  assert.equal(JSON.stringify(list).includes('No real data'), false);
  const file = list.files.find(x => x.path === 'AGENTS.md');
  assert.match(file.id, /^[a-f0-9]{40}$/);
  const body = await f.reader.read('fixture', file.id); assert.match(body.content, /Fixture rules/);
  await assert.rejects(f.reader.read('other', file.id), /not_found/);
  await assert.rejects(f.reader.read('fixture', '../AGENTS.md'), /not_found/);
  f.expire(); await assert.rejects(f.reader.read('fixture', file.id), /not_found/);
});

test('symlinks, hardlinks, nested repositories and path traversal cannot expose sentinels', async t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.outside, 'SECRET.md'), path.join(f.root, 'TEAM.md'));
  fs.symlinkSync(f.outside, path.join(f.root, 'linked'));
  fs.linkSync(path.join(f.outside, 'SECRET.md'), path.join(f.root, 'GEMINI.md'));
  fs.mkdirSync(path.join(f.root, 'nested', '.git'), { recursive: true }); fs.writeFileSync(path.join(f.root, 'nested', 'AGENTS.md'), 'NESTED_SENTINEL');
  f.change({ directories: [f.root], roots: [], extraFiles: ['../outside/SECRET.md', '/etc/passwd.md', 'linked/SECRET.md', 'nested/AGENTS.md', 'docs/../TEAM.md', 'C:\\secret.md', '.git/config.md'] });
  const list = await f.reader.list('fixture');
  assert.ok(list.warnings.length);
  for (const file of list.files) assert.doesNotMatch((await f.reader.read('fixture', file.id)).content, /SENTINEL/);
  assert.equal(list.files.some(x => ['TEAM.md', 'GEMINI.md'].includes(x.path)), false);
});

test('file and scope replacements invalidate entries; refreshed lists invalidate old IDs', async t => {
  const f = fixture(t); let list = await f.reader.list('fixture'), id = list.files.find(x => x.path === 'AGENTS.md').id;
  fs.writeFileSync(path.join(f.root, 'AGENTS.md'), 'changed');
  await assert.rejects(f.reader.read('fixture', id), /file_changed/);
  f.tick(); list = await f.reader.list('fixture');
  await assert.rejects(f.reader.read('fixture', id), /not_found/);
  id = list.files[0].id; f.change({ directories: [f.outside], roots: [], extraFiles: [] });
  await assert.rejects(f.reader.read('fixture', id), /scope_changed/);
});

test('oversized and invalid UTF-8 documents fail without partial contents', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'TEAM.md'), Buffer.alloc(256 * 1024 + 1, 65));
  fs.writeFileSync(path.join(f.root, 'GEMINI.md'), Buffer.from([0xff, 0xfe]));
  const list = await f.reader.list('fixture'); assert.equal(list.files.some(x => x.path === 'TEAM.md'), false);
  const binary = list.files.find(x => x.path === 'GEMINI.md'); await assert.rejects(f.reader.read('fixture', binary.id), /not_utf8/);
  await assert.rejects(f.reader.list('fixture'), /rate_limited/);
});

test('intermediate directory swapped after open stays pinned and never follows replacement symlink', async t => {
  const f = fixture(t); const list = await f.reader.list('fixture');
  const record = f.reader.lists.get('fixture').entries.get(list.files.find(x => x.path === 'docs/TEAM-GUIDE.md').id);
  fs.writeFileSync(path.join(f.outside, 'TEAM-GUIDE.md'), 'OUTSIDE_RACE_SENTINEL');
  const code = `import importlib.util,json,os,sys\nspec=importlib.util.spec_from_file_location('reader',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nr=json.loads(sys.argv[2]);orig=os.open\ndef race(name,flags,*a,**kw):\n fd=orig(name,flags,*a,**kw)\n if name=='docs':\n  os.rename(os.path.join(r['root'],'docs'),os.path.join(r['root'],'moved-docs'))\n  os.symlink(sys.argv[3],os.path.join(r['root'],'docs'))\n return fd\nos.open=race\nprint(json.dumps(m.read_file(r)))`;
  const { stdout } = await promisify(execFile)(f.reader.python, ['-I', '-B', '-c', code, path.join(__dirname, '../src/rules_fs.py'), JSON.stringify(record), f.outside]);
  assert.equal(JSON.parse(stdout).content, '**Fixture**'); assert.doesNotMatch(stdout, /SENTINEL/);
});

test('rules HTTP is same-origin, custom-header, no-store and never included in SSE/status', async t => {
  const f = fixture(t), watcher = new EventEmitter(); watcher.sessions = () => []; watcher.teams = () => [{ id: 'fixture' }];
  const server = createServer(watcher, {}, { rulesReader: f.reader });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, headers = { 'x-agent-office-rule-read': '1' };
  assert.equal((await fetch(base + '/api/rules?team=fixture')).status, 403);
  for (const extra of [{ origin: 'http://localhost:4545' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'x-forwarded-for': '127.0.0.1' }, { range: 'bytes=0-1' }]) {
    assert.equal((await fetch(base + '/api/rules?team=fixture', { headers: { ...headers, ...extra } })).status, 403);
  }
  assert.equal((await fetch(base + '/api/rules?team=fixture&path=/etc/passwd', { headers })).status, 404);
  const response = await fetch(base + '/api/rules?team=fixture', { headers }); assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const list = await response.json(); assert.ok(list.files.length);
  const content = await (await fetch(base + '/api/rules/file?team=fixture&id=' + list.files[0].id, { headers })).json(); assert.ok(content.content);
  const state = JSON.stringify(snapshot(watcher)); assert.doesNotMatch(state, /Fixture rules|AGENTS|rootIdentity|root|files/);
  assert.equal((await fetch(base + '/api/rules/file?team=other&id=' + list.files[0].id, { headers })).status, 404);
});

test('member file IDs cannot cross members or team scope, and occupant changes invalidate them', async t => {
  const f = fixture(t);
  let occupant = 'first';
  const reader = new RulesReader((team, member) => team === 'fixture' ? {
    directories: [f.root], roots: [], extraFiles: [], memberKey: member, occupant,
  } : null);
  const a = await reader.list('fixture', 'member-a'), b = await reader.list('fixture', 'member-b');
  const fileA = a.files.find(f => f.path === 'AGENTS.md'), fileB = b.files.find(f => f.path === 'AGENTS.md');
  assert.notEqual(fileA.id, fileB.id);
  await assert.rejects(reader.read('fixture', fileA.id, 'member-b'), /not_found/);
  await assert.rejects(reader.read('fixture', fileA.id), /not_found/);
  assert.match((await reader.read('fixture', fileA.id, 'member-a')).content, /Fixture rules/);
  occupant = 'replacement';
  await assert.rejects(reader.read('fixture', fileA.id, 'member-a'), /scope_changed/);
});

test('exact ancestor and skill instructions admit observed rules without broadening to arbitrary files or links', async t => {
  const f = fixture(t), root = fs.realpathSync(f.root), parent = path.dirname(root);
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  write(path.join(parent, 'AGENTS.md'), 'SHARED_ANCESTOR');
  write(path.join(parent, '.agents/team/playbook.md'), 'TEAM_PLAYBOOK');
  write(path.join(parent, '.agents/team/roles/reviewer.md'), 'OBSERVED_REVIEWER');
  write(path.join(root, '.agents/team/roles/implementer.md'), 'ASSIGNED_IMPLEMENTER');
  write(path.join(parent, '.codex/skills/check/SKILL.md'), 'OBSERVED_SKILL');
  write(path.join(parent, 'private.md'), 'OUTSIDE_PRIVATE_SENTINEL');
  fs.symlinkSync(path.join(parent, 'private.md'), path.join(parent, '.agents/team/roles/symlink.md'));
  const reader = new RulesReader(() => ({ directories: [root], roots: [], extraFiles: ['.agents/team/roles/implementer.md'],
    memberFiles: ['.agents/team/roles/implementer.md'], instructionRoots: [
      { root: parent, label: 'Ancestor', files: [
        { path: 'AGENTS.md' }, { path: '.agents/team/playbook.md' },
        { path: '.agents/team/roles/reviewer.md', association: 'observed' },
        { path: '.agents/team/roles/symlink.md', association: 'observed' },
        { path: 'private.md' }, { path: '../outside/SECRET.md' },
      ] },
      { root: path.join(parent, '.codex'), label: 'Skills', files: [{ path: 'skills/check/SKILL.md', association: 'observed' }] },
    ] }));
  const list = await reader.list('fixture', 'reviewer');
  assert.equal(list.files.find(f => f.path.endsWith('reviewer.md')).association, 'observed');
  assert.equal(list.files.find(f => f.path.endsWith('implementer.md')).association, 'configured');
  assert.ok(list.files.some(f => f.path === 'skills/check/SKILL.md'));
  assert.ok(list.files.some(f => f.path === '.agents/team/playbook.md'));
  for (const file of list.files) assert.doesNotMatch((await reader.read('fixture', file.id, 'reviewer')).content, /SENTINEL/);
  assert.ok(list.warnings.includes('invalid_instruction_file'));
  const skill = list.files.find(f => f.path.endsWith('SKILL.md'));
  const dir = path.join(parent, '.codex/skills/check'); fs.renameSync(dir, dir + '-old'); fs.symlinkSync(f.outside, dir);
  await assert.rejects(reader.read('fixture', skill.id, 'reviewer'));
});
