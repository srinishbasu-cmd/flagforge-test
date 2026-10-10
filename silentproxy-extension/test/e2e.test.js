'use strict';
// Page -> SDK -> content script -> background -> REAL Python launcher (fake docker) -> back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { RealHostPort, MockWindow, createBrowser, loadContentScript, loadSdk, sleep } = require('./harness');

const LAUNCHER = process.env.LAUNCHER_DIR || path.join(__dirname, '..', '..', 'silentproxy-launcher');
const have = fs.existsSync(path.join(LAUNCHER, 'silentproxy', 'cli.py'));
const PORT = 18097;

test('full lifecycle against the real launcher', { skip: !have && 'set LAUNCHER_DIR to the silentproxy-launcher checkout' }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ext-'));
  const srvDir = path.join(tmp, 'srv');
  const meta = JSON.parse(execFileSync('python3', [path.join(__dirname, 'support', 'make_lab.py'), srvDir, String(PORT)]));
  const server = http.createServer((req, res) => {
    const f = path.join(srvDir, path.basename(req.url));
    fs.existsSync(f) ? res.end(fs.readFileSync(f)) : (res.statusCode = 404, res.end());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const registry = path.join(tmp, 'labs.json');
  fs.writeFileSync(registry, JSON.stringify({ schema: 1, labs: [{
    id: 'demo-lab', title: 'Demo lab', version: '1.0.0', url: `${base}/demo-lab.zip`, sha256: meta.sha256, size: meta.size,
    ttl_hours: 6, ports: [{ name: 'Demo site', host: PORT, check: false }] }] }));
  fs.mkdirSync(path.join(tmp, 'fake-state'));
  const env = { ...process.env, SILENTPROXY_DEV: '1', SILENTPROXY_HOME: path.join(tmp, 'home'), SILENTPROXY_REGISTRY: registry,
    SILENTPROXY_DOCKER_BIN: path.join(LAUNCHER, 'tests', 'fake_docker.py'), FAKE_DOCKER_STATE: path.join(tmp, 'fake-state'),
    PYTHONPATH: LAUNCHER };

  const hosts = [];
  const b = createBrowser({ nativeFactory: () => { const h = new RealHostPort({ env, cwd: LAUNCHER }); hosts.push(h); return h; } });
  const win = new MockWindow('https://site.test');
  loadContentScript(win, b.clientRuntime('https://site.test/silent/'));
  const sdk = loadSdk(win);

  t.after(async () => {
    try { await sdk.stopAll(); } catch (_e) { /* best effort */ }
    for (const h of hosts) await h.shutdown();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const info = await sdk.detect();
  assert.equal(info.extension && info.host, true, JSON.stringify(info));

  const doc = await sdk.doctor();
  assert.ok(doc.daemon_running && doc.compose_ok);

  const { labs } = await sdk.list();
  assert.deepEqual(labs.map((l) => l.id), ['demo-lab']);

  const stages = [];
  const started = await sdk.start('demo-lab', { onProgress: (p) => stages.push(p.stage) });
  for (const s of ['download', 'verify', 'extract', 'validate', 'starting', 'ready']) assert.ok(stages.includes(s), 'missing stage ' + s);
  assert.equal(started.status, 'running');
  assert.equal(started.urls[0].url, `http://127.0.0.1:${PORT}/`);
  assert.equal(b.record.badge.at(-1), 'ON');
  assert.ok(b.record.alarmsCreated.length >= 1);

  const st = await sdk.status();
  assert.equal(st.labs[0].lab, 'demo-lab');
  assert.equal(st.labs[0].services[0].state, 'running');

  const ext = await sdk.extend('demo-lab', 3);
  assert.ok(ext.expires_in > 5 * 3600 || ext.expires_in > 2.9 * 3600);

  await assert.rejects(sdk.start('ghost-lab'), (e) => e.code === 'LAB_UNKNOWN');

  await sdk.stop('demo-lab');
  await sleep(300); // background refreshes its badge after a stop
  assert.equal((await sdk.status()).labs.length, 0);
  assert.equal(b.record.badge.at(-1), '');
  assert.equal(fs.existsSync(path.join(tmp, 'fake-state', 'silentproxy-demo-lab.up')), false);
});
