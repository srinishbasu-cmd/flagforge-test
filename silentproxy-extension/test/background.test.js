'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeNative, createBrowser, sleep, tick } = require('./harness');

const PAGE = 'https://site.test/silent/index.html';

async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(5); }
  assert.fail('condition not met in time');
}

function setup(behavior) {
  const natives = [];
  const b = createBrowser({ nativeFactory: () => { const n = new FakeNative(behavior); natives.push(n); return n; } });
  const client = (url = PAGE) => {
    const port = b.clientRuntime(url).connect({ name: 'test' });
    const msgs = [];
    port.onMessage.addListener((m) => msgs.push(m));
    let disconnected = false;
    port.onDisconnect.addListener(() => { disconnected = true; });
    return { port, msgs, isDisconnected: () => disconnected, result: (id) => msgs.find((m) => m.id === id && m.type === 'result') };
  };
  return { b, natives, client };
}

test('rejects senders that are not our popup or the allowed website', async () => {
  const { b, natives, client } = setup();
  for (const url of ['https://evil.example/silent/', 'https://site.test/silent-evil/x', 'https://site.test/other/', 'http://site.test/silent/', '']) {
    const c = client(url);
    await until(() => c.isDisconnected());
  }
  assert.equal(natives.length, 0);
  assert.equal(b.record.connectNativeCalls, 0);
});

test('accepts the allowed site and the extension popup', async () => {
  const { natives, client } = setup((m, n) => n.ok(m.id, { version: '1.0' }));
  for (const url of [PAGE, 'https://site.test/silent/', 'chrome-extension://testextid/popup.html']) {
    const c = client(url);
    c.port.postMessage({ id: 'p', action: 'ping' });
    await until(() => c.result('p'));
    assert.equal(c.result('p').ok, true);
  }
  assert.equal(natives.length, 1); // one shared native connection
});

test('invalid requests never reach the launcher', async () => {
  const { natives, client } = setup();
  const c = client();
  c.port.postMessage({ id: 'a', action: 'rm -rf' });
  c.port.postMessage({ id: 'b', action: 'start', lab: '../../etc/passwd' });
  c.port.postMessage({ action: 'ping' });
  await until(() => c.msgs.length === 3);
  assert.deepEqual(c.msgs.map((m) => m.error.code), ['BAD_REQUEST', 'BAD_REQUEST', 'BAD_REQUEST']);
  assert.equal(c.result('a').ok, false);
  assert.equal(c.msgs[2].id, null);
  assert.equal(natives.length, 0);
});

test('only whitelisted fields are forwarded, with the native id rewritten', async () => {
  const { natives, client } = setup((m, n) => n.ok(m.id, {}));
  const c = client();
  c.port.postMessage({ id: 'mine', action: 'start', lab: 'demo-lab', replace: true, command: 'evil', path: '/etc' });
  await until(() => c.result('mine'));
  const sent = natives[0].sent[0];
  assert.deepEqual(Object.keys(sent).sort(), ['action', 'id', 'lab', 'replace']);
  assert.notEqual(sent.id, 'mine');
});

test('concurrent clients with the same request id get their own replies and progress', async () => {
  const { natives, client } = setup((m, n) => {
    n.progress(m.id, 'download', 'for ' + (m.lab || 'none'));
    n.ok(m.id, { lab: m.lab });
  });
  const a = client(PAGE);
  const p = client('chrome-extension://testextid/popup.html');
  a.port.postMessage({ id: 'x', action: 'start', lab: 'lab-aa' });
  p.port.postMessage({ id: 'x', action: 'stop', lab: 'lab-bb' });
  await until(() => a.result('x') && p.result('x'));
  assert.equal(a.result('x').data.lab, 'lab-aa');
  assert.equal(p.result('x').data.lab, 'lab-bb');
  assert.equal(a.msgs.find((m) => m.type === 'progress').message, 'for lab-aa');
  assert.equal(new Set(natives[0].sent.map((m) => m.id)).size, natives[0].sent.length);
});

test('ping result is annotated with the extension version', async () => {
  const { client } = setup((m, n) => n.ok(m.id, { version: '0.1.0', protocol: 1 }));
  const c = client();
  c.port.postMessage({ id: 'p', action: 'ping' });
  await until(() => c.result('p'));
  assert.equal(c.result('p').data.extension.version, '0.1.0');
  assert.equal(c.result('p').data.protocol, 1);
});

test('badge and polling alarm follow lab state', async () => {
  const { b, natives, client } = setup((m, n) => {
    if (m.action === 'status') n.ok(m.id, { labs: n.labs || [] });
    else n.ok(m.id, { stopped: true });
  });
  const c = client();
  c.port.postMessage({ id: 's', action: 'start', lab: 'demo-lab' });
  await until(() => c.result('s'));
  assert.deepEqual(b.record.badge.at(-1), 'ON');
  assert.equal(b.record.alarmsCreated[0][0], 'sp-poll');

  natives[0].labs = [{ lab: 'demo-lab' }];
  b.fireAlarm('sp-poll');
  await until(() => natives[0].sent.some((m) => m.action === 'status'));

  natives[0].labs = [];
  c.port.postMessage({ id: 't', action: 'stop', lab: 'demo-lab' });
  await until(() => b.record.alarmsCleared.includes('sp-poll'));
  assert.equal(b.record.badge.at(-1), '');
  b.fireAlarm('something-else');
  await tick();
  assert.equal(natives[0].sent.filter((m) => m.action === 'status').length, 2); // poll + post-stop refresh, not the unrelated alarm
});

test('missing launcher gives an install hint with the extension id, and later requests reconnect', async () => {
  const natives = [];
  const b = createBrowser({ nativeFactory: (rt) => {
    const n = new FakeNative();
    natives.push(n);
    if (natives.length === 1) n.drop('Specified native messaging host not found.', rt);
    else n.behavior = (m, port) => port.ok(m.id, { version: '1.0' });
    return n;
  } });
  const port = b.clientRuntime(PAGE).connect({ name: 't' });
  const msgs = [];
  port.onMessage.addListener((m) => msgs.push(m));
  port.postMessage({ id: 'p1', action: 'ping' });
  await until(() => msgs.length === 1);
  assert.equal(msgs[0].error.code, 'HOST_NOT_INSTALLED');
  assert.match(msgs[0].error.hint, /testextid/);
  port.postMessage({ id: 'p2', action: 'ping' });
  await until(() => msgs.length === 2);
  assert.equal(msgs[1].ok, true);
  assert.equal(b.record.connectNativeCalls, 2);
});

test('Firefox-style port.error and forbidden hosts are understood', async () => {
  const b = createBrowser({ nativeFactory: (rt) => { const n = new FakeNative(); n.drop('No such native application com.operationsilentproxy.launcher', rt, 'error'); return n; } });
  const port = b.clientRuntime(PAGE).connect({ name: 't' });
  const msgs = [];
  port.onMessage.addListener((m) => msgs.push(m));
  port.postMessage({ id: 'p1', action: 'ping' });
  await until(() => msgs.length);
  assert.equal(msgs[0].error.code, 'HOST_NOT_INSTALLED');

  const b2 = createBrowser({ nativeFactory: (rt) => { const n = new FakeNative(); n.drop('Access to the specified native messaging host is forbidden.', rt); return n; } });
  const p2 = b2.clientRuntime(PAGE).connect({ name: 't' });
  const m2 = [];
  p2.onMessage.addListener((m) => m2.push(m));
  p2.postMessage({ id: 'p1', action: 'ping' });
  await until(() => m2.length);
  assert.equal(m2[0].error.code, 'HOST_FORBIDDEN');
  assert.equal(m2[0].error.extension_id, 'testextid');
});

test('launcher crash during a start fails that request cleanly', async () => {
  const { b, natives, client } = setup((m, n) => { n.progress(m.id, 'download', '10%'); });
  const c = client();
  c.port.postMessage({ id: 's', action: 'start', lab: 'demo-lab' });
  await until(() => c.msgs.some((m) => m.type === 'progress'));
  natives[0].drop('Native host has exited.', b.runtime);
  await until(() => c.result('s'));
  assert.equal(c.result('s').error.code, 'HOST_CRASHED');
});

test('closing the page mid-start does not break the launcher flow or the badge', async () => {
  const { b, natives, client } = setup((m, n) => { setTimeout(() => n.ok(m.id, { lab: m.lab }), 30); });
  const c = client();
  c.port.postMessage({ id: 's', action: 'start', lab: 'demo-lab' });
  await until(() => natives[0] && natives[0].sent.length === 1);
  c.port.disconnect();
  await sleep(80);
  assert.equal(b.record.badge.at(-1), 'ON'); // result still processed
  const c2 = client();
  c2.port.postMessage({ id: 'again', action: 'ping' });
  await until(() => c2.result('again'));
});
