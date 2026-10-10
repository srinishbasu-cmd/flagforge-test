'use strict';
// Runs the real popup.js against a tiny fake DOM, wired to the real background via the mock runtime.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { FakeNative, createBrowser, sleep } = require('./harness');

class El {
  constructor(tag) { this.tag = tag; this.nodeType = 1; this.children = []; this.attrs = {}; this.listeners = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.className = ''; this._text = ''; }
  append(...n) { for (const x of n) this.children.push(x); }
  get firstChild() { return this.children[0] || null; }
  removeChild(c) { this.children.splice(this.children.indexOf(c), 1); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'hidden') this.hidden = true; if (k === 'disabled') this.disabled = true; if (k.startsWith('data-')) this.dataset[k.slice(5)] = String(v); }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  click() { for (const f of this.listeners.click || []) f({ target: this }); }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => (c.nodeType === 1 ? c.textContent : c.data)).join(''); }
  walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
  find(pred) { const out = []; this.walk((e) => { if (pred(e)) out.push(e); }); return out; }
}

const POPUP_URL = 'chrome-extension://testextid/popup.html';
const LAB = { id: 'demo-lab', title: 'Demo lab', summary: 'A demo', version: '1.0.0', size: 3e6, installed: false, running: false, ports: [] };

async function openPopup(behavior, { confirmAnswer = true } = {}) {
  const natives = [];
  const b = createBrowser({ nativeFactory: () => { const n = new FakeNative(behavior); natives.push(n); return n; } });
  const ids = ['host-pill', 'alert', 'running', 'running-list', 'labs', 'labs-list', 'footer'];
  const els = Object.fromEntries(ids.map((i) => [i, new El('div')]));
  for (const i of ['alert', 'running', 'labs']) els[i].hidden = true; // `hidden` in popup.html
  const root = new El('body');
  for (const e of Object.values(els)) root.append(e);
  const tabs = [];
  const confirms = [];
  const document = {
    createElement: (t) => new El(t), createTextNode: (t) => ({ nodeType: 3, data: String(t) }),
    getElementById: (id) => els[id], querySelectorAll: () => root.find((e) => 'expires' in e.dataset),
  };
  const rt = b.clientRuntime(POPUP_URL);
  const chrome = { runtime: rt, tabs: { create: (o) => tabs.push(o.url) } };
  const ctx = vm.createContext({ document, chrome, URL, Date, Promise, Math, Object, String, Number, setInterval: () => 0, clearInterval() {},
    confirm: (m) => { confirms.push(m); return confirmAnswer; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'common.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'popup.js'), 'utf8'), ctx);
  await sleep(80);
  return { els, root, natives, tabs, confirms, b };
}

const ok = (n, m, data) => n.ok(m.id, data);
const base = (over = {}) => (m, n) => {
  const table = {
    ping: { version: '0.1.0', protocol: 1 },
    doctor: { docker_installed: true, daemon_running: true, compose_ok: true },
    list: { labs: [LAB] }, status: { labs: [] }, ...over,
  };
  if (typeof table[m.action] === 'function') table[m.action](m, n); else ok(n, m, table[m.action] ?? {});
};

test('missing launcher: shows the problem and the extension id to register', async () => {
  const natives = [];
  const b = createBrowser({ nativeFactory: (rt) => { const n = new FakeNative(); n.drop('Specified native messaging host not found.', rt); natives.push(n); return n; } });
  void b; // build a second popup against this browser
  const ids = ['host-pill', 'alert', 'running', 'running-list', 'labs', 'labs-list', 'footer'];
  const els = Object.fromEntries(ids.map((i) => [i, new El('div')]));
  for (const i of ['alert', 'running', 'labs']) els[i].hidden = true;
  const doc = { createElement: (t) => new El(t), createTextNode: (t) => ({ nodeType: 3, data: String(t) }), getElementById: (i) => els[i], querySelectorAll: () => [] };
  const ctx = vm.createContext({ document: doc, chrome: { runtime: b.clientRuntime(POPUP_URL), tabs: {} }, URL, Date, Promise, Math, Object, String, Number, setInterval: () => 0, confirm: () => true });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'common.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'popup.js'), 'utf8'), ctx);
  await sleep(80);
  assert.equal(els['host-pill'].textContent, 'launcher missing');
  assert.match(els.alert.textContent, /not installed/);
  assert.match(els.alert.textContent, /testextid/);
  assert.equal(els.labs.hidden, true);
});

test('normal state: launcher pill, lab card with Start, Docker ok', async () => {
  const { els } = await openPopup(base());
  assert.equal(els['host-pill'].textContent, 'launcher v0.1.0');
  assert.equal(els.alert.hidden, true);
  assert.match(els['labs-list'].textContent, /Demo lab/);
  assert.match(els['labs-list'].textContent, /3 MB download/);
});

test('Docker problems are surfaced as a warning with the fix', async () => {
  const { els } = await openPopup(base({ doctor: { daemon_running: false, compose_ok: false, error: { code: 'DOCKER_NOT_RUNNING', message: 'Docker is installed but not running.', hint: 'Start Docker' } } }));
  assert.match(els.alert.textContent, /not running/);
  assert.match(els.alert.textContent, /Start Docker/);
});

test('running lab: URLs open only if http(s); Stop and +1 hour send the right requests', async () => {
  const running = { labs: [{ lab: 'demo-lab', status: 'running', expires_in: 7200, services: [{ service: 'web', state: 'running' }],
    urls: [{ name: 'Portal', url: 'http://127.0.0.1:8081/' }, { name: 'Sneaky', url: 'javascript:alert(1)' }] }] };
  const { els, root, natives, tabs } = await openPopup(base({ status: running }));
  assert.equal(els.running.hidden, false);
  assert.match(els['running-list'].textContent, /time left 2h 00m/);
  const links = root.find((e) => e.tag === 'a');
  links.find((l) => l.textContent === 'Portal').click();
  links.find((l) => l.textContent === 'Sneaky').click();
  assert.deepEqual(tabs, ['http://127.0.0.1:8081/']);

  const buttons = root.find((e) => e.tag === 'button');
  buttons.find((b) => b.textContent === '+1 hour').click();
  buttons.find((b) => b.textContent === 'Stop lab').click();
  await sleep(60);
  const sent = natives[0].sent.map((m) => m.action);
  assert.ok(sent.includes('extend') && sent.includes('stop'));
  assert.equal(natives[0].sent.find((m) => m.action === 'extend').hours, 1);
});

test('launcher-provided text is never interpreted as HTML', async () => {
  const evil = { ...LAB, title: '<img src=x onerror=alert(1)>', summary: '<script>alert(2)</script>' };
  const { els, root } = await openPopup(base({ list: { labs: [evil] } }));
  assert.match(els['labs-list'].textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(root.find((e) => e.tag === 'img' || e.tag === 'script').length, 0);
});

test('starting while another lab runs asks to replace it, then retries with replace:true', async () => {
  const { root, natives, confirms } = await openPopup(base({
    start: (m, n) => (m.replace
      ? n.ok(m.id, { lab: m.lab })
      : n.reply({ id: m.id, type: 'result', ok: false, error: { code: 'OTHER_LAB_RUNNING', message: 'Another lab is running.', running: ['mission-0'] } })),
  }));
  root.find((e) => e.tag === 'button' && e.textContent === 'Start')[0].click();
  await sleep(150);
  assert.equal(confirms.length, 1);
  assert.match(confirms[0], /mission-0/);
  const starts = natives[0].sent.filter((m) => m.action === 'start');
  assert.deepEqual(starts.map((x) => x.replace), [false, true]);
});

test('declining the replace prompt leaves the other lab alone', async () => {
  const { root, natives } = await openPopup(base({
    start: (m, n) => n.reply({ id: m.id, type: 'result', ok: false, error: { code: 'OTHER_LAB_RUNNING', message: 'x', running: ['mission-0'] } }),
  }), { confirmAnswer: false });
  root.find((e) => e.tag === 'button' && e.textContent === 'Start')[0].click();
  await sleep(150);
  assert.equal(natives[0].sent.filter((m) => m.action === 'start').length, 1);
});
