const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createServer } = require('../src/server');
const updater = require('../src/update');
const { spawn } = require('node:child_process');
const http = require('node:http');

test('updater never checks network or enables git mutation', async () => {
  delete process.env.WMAD_NO_UPDATE_CHECK;
  process.env.WMAD_LATEST_VERSION = '999.0.0';
  assert.equal(await updater.checkLatest(true), null);
  assert.equal(updater.info().canUpdate, false);
  assert.equal(updater.info().updateAvailable, false);
  await assert.rejects(updater.update(), /disabled/);
});
test('private API, loopback Host guard, disabled update/install and SSE work', async t => {
  const w = new EventEmitter();
  w.sessions = () => [{ id: 'x', agent: 'codex', status: 'thinking', prompt: 'SECRET', reply: 'SECRET', title: 'SECRET', error: 'SECRET' }];
  const server = createServer(w);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(server.address().address, '127.0.0.1');
  assert.equal((await (await fetch(base + '/api/sessions')).text()).includes('SECRET'), false);
  for (const endpoint of ['update', 'scenes/install?id=anything']) {
    assert.equal((await fetch(base + '/api/' + endpoint, { method: 'POST', headers: { 'x-whatsmyagentdoing': 'update' } })).status, 403);
  }
  assert.equal((await (await fetch(base + '/api/version')).json()).canUpdate, false);
  // Node's fetch may replace Host; send the wire-level header explicitly.
  const badHost = await new Promise((resolve, reject) => {
    http.get(base + '/api/sessions', { headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await fetch(base + '/scenes/%ZZ')).status, 400);
  const abort = new AbortController();
  const sse = await fetch(base + '/events', { signal: abort.signal });
  const reader = sse.body.getReader(); const first = await reader.read();
  const body = new TextDecoder().decode(first.value);
  assert.ok(body.startsWith('data: ')); assert.equal(body.includes('SECRET'), false); abort.abort();
});
test('--stop does not stop the original dashboard or scan other ports', async t => {
  let shutdowns = 0;
  const original = http.createServer((req, res) => {
    if (req.url === '/api/shutdown') shutdowns++;
    res.end(JSON.stringify({ app: 'whatsmyagentdoing' }));
  });
  await new Promise(resolve => original.listen(0, '127.0.0.1', resolve));
  t.after(() => original.close());
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/cli.js', '--stop', '--port', String(original.address().port)], { cwd: require('node:path').join(__dirname, '..') });
    child.on('error', reject); child.on('exit', resolve);
  });
  assert.equal(result, 0); assert.equal(shutdowns, 0);
});
