'use strict';
// A minimal browser-extension runtime so the real extension scripts can run under Node.
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const clone = (o) => JSON.parse(JSON.stringify(o));
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEvent() {
  const ls = [];
  return { addListener: (f) => ls.push(f), fire: (...a) => ls.slice().forEach((f) => f(...a)), count: () => ls.length };
}

class MockPort {
  constructor(name, sender) {
    this.name = name; this.sender = sender; this.peer = null; this.closed = false;
    this.onMessage = makeEvent(); this.onDisconnect = makeEvent();
  }
  postMessage(m) {
    if (this.closed) throw new Error('Attempting to use a disconnected port object');
    const peer = this.peer;
    setImmediate(() => { if (!peer.closed) peer.onMessage.fire(clone(m)); });
  }
  disconnect() {
    if (this.closed) return;
    this.closed = true;
    const peer = this.peer;
    peer.closed = true;
    setImmediate(() => peer.onDisconnect.fire());
  }
}

/** Scripted native port: records what the extension sends, lets tests answer. */
class FakeNative {
  constructor(behavior) {
    this.sent = []; this.behavior = behavior || (() => {}); this.closed = false;
    this.onMessage = makeEvent(); this.onDisconnect = makeEvent();
  }
  postMessage(m) {
    if (this.closed) throw new Error('Attempting to use a disconnected port object');
    const msg = clone(m);
    this.sent.push(msg);
    setImmediate(() => this.behavior(msg, this));
  }
  reply(obj) { setImmediate(() => this.onMessage.fire(clone(obj))); }
  progress(id, stage, message) { this.reply({ id, type: 'progress', stage, message }); }
  ok(id, data) { this.reply({ id, type: 'result', ok: true, data }); }
  fail(id, code, message) { this.reply({ id, type: 'result', ok: false, error: { code, message } }); }
  drop(errorMessage, runtime, via = 'lastError') {
    setImmediate(() => {  // like a real browser, the port only reports "closed" once the disconnect event runs
      this.closed = true;
      if (via === 'error') this.error = { message: errorMessage };
      else runtime.lastError = { message: errorMessage };
      this.onDisconnect.fire();
      runtime.lastError = null;
    });
  }
}

/** Spawns the real Python launcher and speaks native-messaging framing to it. */
class RealHostPort {
  constructor({ env, cwd }) {
    this.onMessage = makeEvent(); this.onDisconnect = makeEvent(); this.closed = false;
    this.proc = spawn('python3', ['-m', 'silentproxy', 'chrome-extension://testextid/'], { env, cwd });
    this.buf = Buffer.alloc(0);
    this.stderr = '';
    this.proc.stderr.on('data', (d) => { this.stderr += d; });
    this.proc.stdout.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      for (;;) {
        if (this.buf.length < 4) return;
        const len = os.endianness() === 'LE' ? this.buf.readUInt32LE(0) : this.buf.readUInt32BE(0);
        if (this.buf.length < 4 + len) return;
        const msg = JSON.parse(this.buf.subarray(4, 4 + len).toString('utf8'));
        this.buf = this.buf.subarray(4 + len);
        this.onMessage.fire(msg);
      }
    });
    this.proc.on('exit', () => { if (!this.closed) { this.closed = true; this.error = { message: 'Native host has exited.' }; this.onDisconnect.fire(); } });
  }
  postMessage(m) {
    if (this.closed) throw new Error('Attempting to use a disconnected port object');
    const body = Buffer.from(JSON.stringify(m));
    const head = Buffer.alloc(4);
    if (os.endianness() === 'LE') head.writeUInt32LE(body.length); else head.writeUInt32BE(body.length);
    this.proc.stdin.write(Buffer.concat([head, body]));
  }
  async shutdown() {
    this.closed = true;
    this.proc.stdin.end();
    await new Promise((r) => (this.proc.exitCode !== null ? r() : this.proc.once('exit', r)));
    for (const s of [this.proc.stdout, this.proc.stderr, this.proc.stdin]) s.destroy();
  }
}

function createBrowser({ extId = 'testextid', prefixes = ['https://site.test/silent/'], nativeFactory } = {}) {
  const record = { badge: [], alarmsCreated: [], alarmsCleared: [], connectNativeCalls: 0 };
  const alarmEvent = makeEvent();
  const runtime = {
    id: extId, lastError: null, onConnect: makeEvent(),
    getURL: (p) => `chrome-extension://${extId}/${p}`,
    getManifest: () => ({ version: '0.1.0' }),
    connectNative: () => { record.connectNativeCalls += 1; return nativeFactory(runtime); },
  };
  const chrome = {
    runtime,
    action: {
      setBadgeText: ({ text }) => { record.badge.push(text); return Promise.resolve(); },
      setBadgeBackgroundColor: () => Promise.resolve(),
    },
    alarms: {
      create: (name, info) => { record.alarmsCreated.push([name, info]); },
      clear: (name) => { record.alarmsCleared.push(name); return Promise.resolve(true); },
      onAlarm: alarmEvent,
    },
  };
  const ctx = vm.createContext({ chrome, console, setTimeout, clearTimeout, JSON, Promise });
  vm.runInContext(read('common.js'), ctx);
  vm.runInContext(`globalThis.SP_CONFIG = ${JSON.stringify({ allowedPrefixes: prefixes })};`, ctx);
  vm.runInContext(read('background.js'), ctx);

  /** A runtime object as seen from a content script / popup whose page URL is senderUrl. */
  function clientRuntime(senderUrl) {
    return {
      connect({ name }) {
        const client = new MockPort(name, null);
        const bg = new MockPort(name, { id: extId, url: senderUrl });
        client.peer = bg; bg.peer = client;
        runtime.onConnect.fire(bg);
        return client;
      },
      getManifest: runtime.getManifest, id: extId,
    };
  }
  return { chrome, runtime, record, clientRuntime, fireAlarm: (name) => alarmEvent.fire({ name }), SP: ctx.SP };
}

class MockWindow {
  constructor(origin) { this.location = { origin }; this.listeners = []; this.posted = []; }
  addEventListener(type, f) { if (type === 'message') this.listeners.push(f); }
  postMessage(data, targetOrigin) {
    if (targetOrigin !== '*' && targetOrigin !== this.location.origin) return;
    this.deliver({ data: clone(data), origin: this.location.origin, source: this });
  }
  deliver(ev) { setImmediate(() => this.listeners.slice().forEach((f) => f(ev))); }
}

function loadContentScript(win, runtime) {
  const ctx = vm.createContext({ window: win, chrome: { runtime }, JSON, Promise, Set, Object });
  vm.runInContext(read('common.js'), ctx);
  vm.runInContext(read('content.js'), ctx);
  return ctx;
}

function loadSdk(win) {
  const ctx = vm.createContext({ window: win, setTimeout, clearTimeout, Date, Promise, Error, Object, Map });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sdk', 'silentproxy-client.js'), 'utf8'), ctx);
  return win.SilentProxy;
}

module.exports = { FakeNative, RealHostPort, MockPort, MockWindow, createBrowser, loadContentScript, loadSdk, tick, sleep, clone, makeEvent };
