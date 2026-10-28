// Adapted from upstream 7146df1 (#10): malformed URL survival and boundaries.
// A synthetic scene resolver avoids reading or changing the user's scene store.
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const scenes = require('../src/scenes');
const { createServer } = require('../src/server');

test('upstream HTTP regression: malformed asset/scene paths never terminate server', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmad-url-regression-'));
  const fixture = path.join(root, 'fixture'); fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'hello world.json'), '{"fixture":true}');
  fs.writeFileSync(path.join(fixture, 'literal%name.json'), '{"percent":true}');
  fs.writeFileSync(path.join(fixture, 'blocked.txt'), 'not allowed');
  fs.writeFileSync(path.join(root, 'outside.json'), '{"outside":true}');
  const original = scenes.sceneDir; scenes.sceneDir = id => id === 'fixture' ? fixture : null;
  const watcher = new EventEmitter(); watcher.sessions = () => [];
  const server = createServer(watcher);
  t.after(async () => { scenes.sceneDir = original; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const request = (url, host = 'localhost') => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.address().port, path: url, headers: { host: `${host}:${server.address().port}` } }, res => {
      const chunks = []; res.on('data', x => chunks.push(x)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('request timeout')));
  });
  const ping = async host => { const r = await request('/api/ping', host); assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).app, 'agent-office-team-houses'); };
  for (const prefix of ['/assets/', '/scenes/', '/scenes/fixture/']) {
    for (const suffix of ['%', '%2', '%GG', '%E0%A4', '%FF']) {
      assert.equal((await request(prefix + suffix)).status, 400, prefix + suffix);
      await ping();
      assert.equal((await request('/scenes/fixture/hello%20world.json')).body.toString(), '{"fixture":true}');
    }
  }
  const logo = await request('/assets/agents%2F%63laude.png');
  assert.equal(logo.status, 200); assert.equal(logo.headers['content-type'], 'image/png');
  assert.deepEqual(logo.body, fs.readFileSync(path.join(__dirname, '../assets/agents/claude.png')));
  for (const url of ['/assets/%', '/scenes/%']) assert.equal((await request(url, 'untrusted.example')).status, 403);
  for (const host of ['localhost', '127.0.0.1', '[::1]']) await ping(host);
  for (const url of ['/assets/%2e%2e%2fpackage.json', '/scenes/fixture/%2e%2e%2foutside.json', '/scenes/%2e%2e%2ffixture/manifest.json', '/assets/agents/README.md', '/scenes/fixture/blocked.txt', '/assets/missing.png', '/scenes/missing/manifest.json']) assert.equal((await request(url)).status, 404, url);
  assert.equal((await request('/scenes/fixture/literal%25name.json')).body.toString(), '{"percent":true}');
  const office = await request('/office.js'); assert.equal(office.status, 200); assert.equal(office.headers['cache-control'], 'no-store');
  await ping();
});
