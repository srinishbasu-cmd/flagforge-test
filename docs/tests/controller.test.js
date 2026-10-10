'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createController, normalizeUrls } = require('../js/controller.js');

class Err extends Error { constructor(code, message, extra = {}) { super(message); this.code = code; this.hint = extra.hint; this.details = { code, message, ...extra }; } }

function fakeSp(over = {}) {
	const calls = [];
	const sp = {
		calls, running: [],
		detect: async () => ({ extension: true, host: true, version: '0.1.0' }),
		doctor: async () => ({ daemon_running: true, compose_ok: true }),
		status: async () => ({ labs: sp.running }),
		start: async (id, o) => { calls.push(['start', id, !!o.replace]); o.onProgress({ stage: 'download', message: 'Downloading', percent: 40 }); sp.running = [{ lab: id, urls: [{ name: 'Portal', url: 'http://127.0.0.1:8081/' }], expires_in: 21600, services: [] }]; return { lab: id, urls: [{ name: 'Portal', url: 'http://127.0.0.1:8081/' }], expires_in: 21600, ready: true }; },
		stop: async (id) => { calls.push(['stop', id]); sp.running = []; return { stopped: true }; },
		extend: async (id, h) => { calls.push(['extend', id, h]); return { expires_in: 3600 * 7 }; },
		...over,
	};
	return sp;
}
const mk = (sp, ids = ['lab-a', 'lab-b'], o = {}) => createController(sp, ids, { now: () => 1000, setInterval: () => 1, clearInterval() {}, ...o });

test('setup: extension missing, launcher missing, docker bad, all good', async () => {
	let c = mk(fakeSp({ detect: async () => ({ extension: false, host: false }) }));
	await c.checkSetup();
	assert.deepEqual([c.state.setup.ext, c.state.setup.host, c.state.setup.docker], ['missing', 'unknown', 'unknown']);
	assert.equal(c.ready(), false);

	c = mk(fakeSp({ detect: async () => ({ extension: true, host: false, error: { code: 'HOST_NOT_INSTALLED', message: 'nope', hint: 'install it' } }) }));
	await c.checkSetup();
	assert.deepEqual([c.state.setup.ext, c.state.setup.host], ['ok', 'missing']);
	assert.equal(c.state.setup.error.hint, 'install it');

	c = mk(fakeSp({ doctor: async () => ({ daemon_running: false, compose_ok: false, error: { code: 'DOCKER_NOT_RUNNING', message: 'Docker is installed but not running.', hint: 'Start Docker' } }) }));
	await c.checkSetup();
	assert.equal(c.state.setup.docker, 'bad');
	assert.equal(c.state.setup.error.code, 'DOCKER_NOT_RUNNING');
	assert.equal(c.ready(), false);

	c = mk(fakeSp({ doctor: async () => { throw new Err('TIMEOUT', 'slow'); } }));
	await c.checkSetup();
	assert.equal(c.state.setup.docker, 'bad');

	c = mk(fakeSp());
	await c.checkSetup();
	assert.equal(c.ready(), true);
	assert.equal(c.state.setup.launcherVersion, '0.1.0');
});

test('start is blocked until setup is ready', async () => {
	const sp = fakeSp();
	const c = mk(sp);
	await c.start('lab-a');
	assert.equal(sp.calls.length, 0);
	assert.equal(c.state.labs['lab-a'].error.code, 'SETUP_INCOMPLETE');
});

test('start: progress, running state, countdown, URLs, polling begins', async () => {
	const sp = fakeSp();
	let ivs = 0;
	const c = mk(sp, undefined, { setInterval: () => ++ivs });
	await c.checkSetup();
	const seen = [];
	c.onChange((s) => { const p = s.labs['lab-a'].progress; if (p) seen.push(p.percent); });
	await c.start('lab-a');
	const L = c.state.labs['lab-a'];
	assert.equal(L.status, 'running');
	assert.ok(seen.includes(40));
	assert.equal(L.expiresAt, 1000 + 21600 * 1000);
	assert.deepEqual(L.urls, [{ name: 'Portal', url: 'http://127.0.0.1:8081/', link: true }]);
	assert.equal(ivs, 1);
	c.destroy();
});

test('one lab at a time: conflict is surfaced, replace retries', async () => {
	const sp = fakeSp({ start: async (id, o) => { sp.calls.push(['start', id, !!o.replace]); if (!o.replace) throw new Err('OTHER_LAB_RUNNING', 'busy', { running: ['mission-0'] }); return { urls: [], expires_in: 60 }; } });
	const c = mk(sp);
	await c.checkSetup();
	await c.start('lab-a');
	assert.deepEqual(c.state.conflict, { labId: 'lab-a', running: ['mission-0'] });
	assert.equal(c.state.labs['lab-a'].status, 'idle');
	assert.equal(c.state.labs['lab-a'].error, null);
	await c.start('lab-a', { replace: true });
	assert.equal(c.state.conflict, null);
	assert.deepEqual(sp.calls.map((x) => x[2]), [false, true]);
	c.destroy();
});

test('start failures keep code, hint and policy problems', async () => {
	const sp = fakeSp({ start: async () => { throw new Err('UNSAFE_LAB', 'bad lab', { hint: 'h', problems: ['service web: privileged'] }); } });
	const c = mk(sp);
	await c.checkSetup();
	await c.start('lab-a');
	const e = c.state.labs['lab-a'].error;
	assert.equal(e.code, 'UNSAFE_LAB');
	assert.deepEqual(e.problems, ['service web: privileged']);
	assert.equal(c.state.labs['lab-a'].status, 'idle');
});

test('double start while starting is ignored', async () => {
	let release;
	const sp = fakeSp({ start: (id, o) => new Promise((r) => { sp.calls.push(['start', id]); release = () => r({ urls: [], expires_in: 60 }); }) });
	const c = mk(sp);
	await c.checkSetup();
	const p = c.start('lab-a');
	await c.start('lab-a');
	assert.equal(sp.calls.length, 1);
	release();
	await p;
	c.destroy();
});

test('stop and extend', async () => {
	const sp = fakeSp();
	const c = mk(sp);
	await c.checkSetup();
	await c.start('lab-a');
	await c.extend('lab-a', 1);
	assert.equal(c.state.labs['lab-a'].expiresAt, 1000 + 7 * 3600 * 1000);
	await c.stop('lab-a');
	assert.equal(c.state.labs['lab-a'].status, 'idle');
	await c.extend('lab-a');                      // not running: ignored
	assert.equal(sp.calls.filter((x) => x[0] === 'extend').length, 1);
	c.destroy();
});

test('failed stop leaves the lab marked running with an error', async () => {
	const sp = fakeSp();
	const c = mk(sp);
	await c.checkSetup();
	await c.start('lab-a');
	sp.stop = async () => { throw new Err('STOP_FAILED', 'could not stop'); };
	await c.stop('lab-a');
	assert.equal(c.state.labs['lab-a'].status, 'running');
	assert.equal(c.state.labs['lab-a'].error.code, 'STOP_FAILED');
	c.destroy();
});

test('status refresh adopts labs started elsewhere, notices expiry, and flags other challenges', async () => {
	const sp = fakeSp();
	const c = mk(sp);
	await c.checkSetup();
	sp.running = [{ lab: 'lab-b', urls: [], expires_in: 120 }, { lab: 'other-mission', urls: [], expires_in: 5 }];
	await c.refreshStatus();
	assert.equal(c.state.labs['lab-b'].status, 'running');
	assert.deepEqual(c.state.others, ['other-mission']);
	sp.running = [];
	await c.refreshStatus();
	assert.equal(c.state.labs['lab-b'].status, 'idle');
	assert.deepEqual(c.state.others, []);
	c.destroy();
});

test('polling stops when nothing is running', async () => {
	const sp = fakeSp();
	const cleared = [];
	const c = mk(sp, undefined, { setInterval: () => 7, clearInterval: (t) => cleared.push(t) });
	await c.checkSetup();
	await c.start('lab-a');
	await c.stop('lab-a');
	assert.deepEqual(cleared, [7]);
});

test('only loopback http(s) URLs become links', () => {
	const u = normalizeUrls([
		{ name: 'ok', url: 'http://127.0.0.1:8081/x' }, { name: 'lh', url: 'http://localhost:9/' },
		{ name: 'ext', url: 'https://evil.example/' }, { name: 'js', url: 'javascript:alert(1)' }, { name: 'tcp', url: 'tcp://127.0.0.1:2222' }, { name: 'junk', url: 'not a url' },
	]);
	assert.deepEqual(u.map((x) => x.link), [true, true, false, false, false, false]);
	assert.deepEqual(normalizeUrls(null), []);
});
