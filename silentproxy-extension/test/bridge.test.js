'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeNative, MockWindow, createBrowser, loadContentScript, loadSdk, sleep } = require('./harness');

const plain = (o) => JSON.parse(JSON.stringify(o)); // objects from the vm realm have a different prototype
const ORIGIN = 'https://site.test';
const PAGE = 'https://site.test/silent/index.html';

function chain(behavior, { withContentScript = true } = {}) {
  const natives = [];
  const b = createBrowser({ nativeFactory: (rt) => { const n = new FakeNative(behavior); n.rt = rt; natives.push(n); return n; } });
  const win = new MockWindow(ORIGIN);
  if (withContentScript) loadContentScript(win, b.clientRuntime(PAGE));
  const sdk = loadSdk(win);
  return { b, natives, win, sdk };
}

test('detect(): extension and launcher present', async () => {
  const { sdk } = chain((m, n) => n.ok(m.id, { version: '0.1.0', protocol: 1 }));
  assert.deepEqual(plain(await sdk.detect()), { extension: true, host: true, version: '0.1.0', extensionVersion: '0.1.0' });
});

test('detect(): extension present but launcher not installed', async () => {
  const natives = [];
  const b = createBrowser({ nativeFactory: (rt) => { const n = new FakeNative(); n.drop('Specified native messaging host not found.', rt); natives.push(n); return n; } });
  const win = new MockWindow(ORIGIN);
  loadContentScript(win, b.clientRuntime(PAGE));
  const s = loadSdk(win);
  const r = await s.detect();
  assert.equal(r.extension, true);
  assert.equal(r.host, false);
  assert.equal(r.error.code, 'HOST_NOT_INSTALLED');
});

test('detect(): no extension at all (no content script answers)', async () => {
  const { sdk } = chain(() => {}, { withContentScript: false });
  assert.deepEqual(plain(await sdk.detect()), { extension: false, host: false });
});

test('start(): progress events arrive in order, then the result', async () => {
  const { sdk, natives } = chain((m, n) => {
    n.progress(m.id, 'download', 'Downloading');
    n.progress(m.id, 'verify', 'Checksum verified');
    setTimeout(() => n.ok(m.id, { lab: m.lab, urls: [{ name: 'web', url: 'http://127.0.0.1:8081/' }] }), 20);
  });
  const seen = [];
  const res = await sdk.start('demo-lab', { onProgress: (p) => seen.push(p.stage) });
  assert.deepEqual(seen, ['download', 'verify']);
  assert.equal(res.urls[0].url, 'http://127.0.0.1:8081/');
  assert.equal(natives[0].sent[0].replace, false);
});

test('errors reject with SilentProxyError carrying code and hint', async () => {
  const { sdk } = chain((m, n) => n.reply({ id: m.id, type: 'result', ok: false, error: { code: 'DOCKER_NOT_RUNNING', message: 'Docker is installed but not running.', hint: 'Start Docker' } }));
  await assert.rejects(sdk.doctor(), (e) => {
    assert.equal(e.name, 'SilentProxyError');
    assert.equal(e.code, 'DOCKER_NOT_RUNNING');
    assert.equal(e.hint, 'Start Docker');
    return true;
  });
});

test('SDK validation failures come back as BAD_REQUEST without touching the launcher', async () => {
  const { sdk, natives } = chain(() => assert.fail('must not be called'));
  await assert.rejects(sdk.start('../../etc/passwd'), (e) => e.code === 'BAD_REQUEST');
  await assert.rejects(sdk.extend('demo-lab', 500), (e) => e.code === 'BAD_REQUEST');
  assert.equal(natives.length, 0);
});

test('content script ignores foreign origins, foreign sources and malformed envelopes', async () => {
  const { win, natives } = chain((m, n) => n.ok(m.id, {}));
  const payload = { id: 'evil1', action: 'ping' };
  const good = { ns: 'silentproxy.v1', dir: 'to-ext', payload };
  win.deliver({ data: good, origin: 'https://evil.example', source: win });            // wrong origin
  win.deliver({ data: good, origin: ORIGIN, source: {} });                              // not from this window (e.g. iframe)
  win.deliver({ data: { ...good, ns: 'other' }, origin: ORIGIN, source: win });         // wrong namespace
  win.deliver({ data: { ...good, dir: 'from-ext' }, origin: ORIGIN, source: win });     // wrong direction
  win.deliver({ data: 'ping', origin: ORIGIN, source: win });
  win.deliver({ data: null, origin: ORIGIN, source: win });
  await sleep(60);
  assert.equal(natives.length, 0);
  assert.equal(win.listeners.length, 2); // content script + SDK only
});

test('extension reload: pending calls fail with EXT_DISCONNECTED and the next call reconnects', async () => {
  const natives = [];
  const b = createBrowser({ nativeFactory: () => { const n = new FakeNative((m, port) => { if (m.action === 'start') return; port.ok(m.id, { version: '1' }); }); natives.push(n); return n; } });
  const win = new MockWindow(ORIGIN);
  const rt = b.clientRuntime(PAGE);
  let lastPort;
  const origConnect = rt.connect;
  rt.connect = (o) => (lastPort = origConnect(o));
  loadContentScript(win, rt);
  const sdk = loadSdk(win);

  const pendingStart = sdk.start('demo-lab').then(() => 'resolved', (e) => e.code);
  await sleep(30);
  lastPort.peer.disconnect(); // background side goes away (extension reloaded / worker killed)
  assert.equal(await pendingStart, 'EXT_DISCONNECTED');

  const info = await sdk.detect();
  assert.equal(info.host, true);
});

test('a page cannot make the extension talk to anything but the whitelisted actions', async () => {
  const { sdk, natives } = chain((m, n) => n.ok(m.id, {}));
  await assert.rejects(sdk.request('exec', { cmd: 'calc' }), (e) => e.code === 'BAD_REQUEST');
  await assert.rejects(sdk.request('start', { lab: 'demo-lab', replace: 'true' }), (e) => e.code === 'BAD_REQUEST');
  await sdk.request('stop', { lab: 'demo-lab', extra: 'dropped' });
  assert.deepEqual(Object.keys(natives[0].sent[0]).sort(), ['action', 'id', 'lab']);
});
