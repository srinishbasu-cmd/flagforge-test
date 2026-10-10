'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const createPage = require('../js/challenge.js');
const { md } = require('../js/markdown.js');
const { createController } = require('../js/controller.js');
const { makeDoc } = require('./minidom');

const ROOT = path.join(__dirname, '..');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js', 'config.js'), 'utf8'), sandbox);
const CONFIG = JSON.parse(JSON.stringify(sandbox.window.FLAGFORGE));
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'challenges.json'), 'utf8'));

class Err extends Error { constructor(code, message, extra = {}) { super(message); this.code = code; this.details = { code, message, ...extra }; } }

function fakeSp(over = {}) {
	const sp = {
		calls: [], running: [],
		detect: async () => ({ extension: true, host: true, version: '0.1.0' }),
		doctor: async () => ({ daemon_running: true, compose_ok: true }),
		status: async () => ({ labs: sp.running }),
		start: async (id, o) => { sp.calls.push(['start', id, !!o.replace]); sp.running = [{ lab: id, urls: [{ name: 'Portal', url: 'http://127.0.0.1:8081/' }], expires_in: 7200 }]; return { urls: [{ name: 'Portal', url: 'http://127.0.0.1:8081/' }], expires_in: 7200, ready: true }; },
		stop: async (id) => { sp.calls.push(['stop', id]); sp.running = []; return {}; },
		extend: async () => ({ expires_in: 10800 }),
		...over,
	};
	return sp;
}

function setup({ query = '?c=burp-suite', platform = 'Linux x86_64', sp = fakeSp(), data = DATA, config = CONFIG, files = {} } = {}) {
	const doc = makeDoc(['app']);
	const env = {
		document: doc, location: { search: query }, navigator: { platform },
		config, md, createController, sp,
		fetch: async (url) => {
			if (url === 'data/challenges.json') return { ok: true, json: async () => data };
			const f = files[url] ?? (fs.existsSync(path.join(ROOT, url)) ? fs.readFileSync(path.join(ROOT, url), 'utf8') : null);
			return f == null ? { ok: false, status: 404 } : { ok: true, text: async () => f };
		},
	};
	return { env, doc, sp, page: createPage(env) };
}
const until = async (fn, ms = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); } assert.fail('timeout'); };
const app = (doc) => doc.els.app;
const btn = (root, text) => root.byTag('button').find((b) => b.textContent === text);
const link = (root, text) => root.byTag('a').find((a) => a.textContent.includes(text));

test('live challenge: hero, checklist, six missions, aside, README, contributors', async () => {
	const { doc, page } = setup();
	const { ctl } = await page.init();
	await until(() => ctl.ready());
	const root = app(doc);
	assert.equal(doc.title, 'Burp Suite-CTF · Flag Forge');
	assert.match(root.textContent, /Operation Silent Proxy/);
	assert.equal(root.byClass('mission').length, 6);
	assert.equal(root.byClass('dot').filter((d) => d.attrs.class.includes('ok')).length, 3);
	assert.ok(link(root, 'Download launcher for Linux').attrs.href.endsWith('/silentproxy-linux'));
	assert.equal(link(root, '▶ Start lab').attrs.href, '#launch');
	assert.ok(root.byClass('side').length === 1 && root.byTag('aside').length === 1);
	assert.deepEqual(root.byClass('crumbs')[0].byTag('a').map((a) => a.attrs.href), ['index.html', 'jr-pentest.html']);
	await until(() => root.byTag('h3').some((h) => h.textContent === 'Operation Silent Proxy')); // README rendered
	assert.match(root.byClass('person')[0].textContent, /Srinish Basu/);
	assert.equal(root.byClass('person')[0].byClass('avatar')[0].textContent, 'SB');
});

test('Start / Stop flow updates the mission row', async () => {
	const { doc, page, sp } = setup();
	const { ctl } = await page.init();
	await until(() => ctl.ready());
	const root = app(doc);
	const starts = root.byTag('button').filter((b) => b.textContent === '▶ Start lab');
	assert.equal(starts.length, 6);
	assert.ok(starts.every((b) => !b.disabled));
	starts[0].click();
	await until(() => root.byClass('mission')[0].attrs.class.includes('running'));
	assert.deepEqual(sp.calls[0], ['start', 'mission-1-recon', false]);
	const open = link(root.byClass('mission')[0], 'Open Portal');
	assert.equal(open.attrs.href, 'http://127.0.0.1:8081/');
	assert.equal(open.attrs.rel, 'noopener noreferrer');
	assert.match(root.byClass('mission')[0].textContent, /2h 00m left/);
	btn(root, 'Stop lab').click();
	await until(() => !root.byClass('mission')[0].attrs.class.includes('running'));
	assert.deepEqual(sp.calls.at(-1), ['stop', 'mission-1-recon']);
});

test('Start is disabled and explained until setup is complete', async () => {
	const sp = fakeSp({ detect: async () => ({ extension: true, host: false, error: { code: 'HOST_NOT_INSTALLED', message: 'Launcher missing.', hint: 'Run install.' } }) });
	const { doc, page } = setup({ sp });
	const { ctl } = await page.init();
	await until(() => ctl.state.setup.host === 'missing');
	const root = app(doc);
	assert.ok(root.byTag('button').filter((b) => b.textContent === '▶ Start lab').every((b) => b.disabled));
	assert.match(root.byClass('check')[1].textContent, /Launcher missing\. Run install\./);
	assert.equal(root.byClass('dot')[0].attrs.class.includes('ok'), true);
});

test('another lab running: offers replace and retries with replace', async () => {
	const sp = fakeSp({ start: async (id, o) => { sp.calls.push(['start', id, !!o.replace]); if (!o.replace) throw new Err('OTHER_LAB_RUNNING', 'busy', { running: ['mission-9'] }); return { urls: [], expires_in: 60 }; } });
	const { doc, page } = setup({ sp });
	const { ctl } = await page.init();
	await until(() => ctl.ready());
	const root = app(doc);
	root.byTag('button').find((b) => b.textContent === '▶ Start lab').click();
	await until(() => btn(root, 'Stop it and start'));
	assert.match(root.textContent, /mission-9/);
	btn(root, 'Stop it and start').click();
	await until(() => sp.calls.length === 2);
	assert.equal(sp.calls[1][2], true);
});

test('coming-soon challenge has no lab controls or launcher sidebar', async () => {
	const { doc, page } = setup({ query: '?c=nmap' });
	const r = await page.init();
	assert.equal(r.ctl, null);
	const root = app(doc);
	assert.match(root.textContent, /not ready yet/);
	assert.equal(root.byTag('button').filter((b) => /Start lab/.test(b.textContent)).length, 0);
	assert.equal(root.byClass('side')[0].children.length, 0);
	assert.match(root.textContent, /Coming soon/);
});

test('unknown slug and data load failures show friendly messages', async () => {
	let { doc, page } = setup({ query: '?c=../../etc' });
	assert.equal(await page.init(), null);
	assert.match(app(doc).textContent, /Challenge not found/);
	({ doc, page } = setup({ query: '' }));
	await page.init();
	assert.match(app(doc).textContent, /Challenge not found/);
	const env = setup().env;
	env.fetch = async () => { throw new Error('file://'); };
	const doc2 = env.document;
	assert.equal(await createPage(env).init(), null);
	assert.match(doc2.els.app.textContent, /local web server/);
});

test('install commands per OS, with the Chrome extension id filled in when configured', () => {
	const mk = (platform, cfg = CONFIG) => setup({ platform, config: cfg }).page;
	assert.equal(mk('Win32').detectOS(), 'windows');
	assert.equal(mk('MacIntel').detectOS(), 'macos');
	assert.equal(mk('Linux x86_64').detectOS(), 'linux');
	assert.equal(mk('Win32').installCommands('windows').firefox, '.\\silentproxy-windows.exe install');
	assert.match(mk('MacIntel').installCommands('macos').firefox, /xattr -d com\.apple\.quarantine silentproxy-macos.*\.\/silentproxy-macos install/);
	assert.match(mk('Linux').installCommands('linux').chrome, /--chrome-id <extension-id>/);
	const withId = { ...CONFIG, extension: { ...CONFIG.extension, chromeId: 'abcdefghijklmnopabcdefghijklmnop' } };
	assert.match(mk('Linux', withId).installCommands('linux').chrome, /--chrome-id abcdefghijklmnopabcdefghijklmnop$/);
});

test('contributor cards are hardened', async () => {
	const data = JSON.parse(JSON.stringify(DATA));
	data.challenges[1].contributors = [
		{ name: 'Good User', role: 'Author', github: 'good-user', photo: 'assets/contributors/good.jpg' },
		{ name: 'Bad Handle', github: 'a/b"onerror=x', photo: '../../etc/passwd' },
		{ name: 'Only Name' },
		{ name: '<img src=x onerror=alert(1)>', github: '' },
	];
	const { doc, page } = setup({ query: '?c=nmap', data });
	await page.init();
	const people = app(doc).byClass('person');
	assert.equal(people.length, 4);
	assert.equal(people[0].byTag('a')[0].attrs.href, 'https://github.com/good-user');
	assert.equal(people[0].byTag('img')[0].attrs.src, 'assets/contributors/good.jpg');
	assert.equal(people[1].byTag('a').length, 0);
	assert.equal(people[1].byTag('img').length, 0);       // traversal path rejected, bad handle rejected
	assert.equal(people[1].byClass('avatar')[0].textContent, 'BH');
	assert.equal(people[2].byClass('avatar')[0].textContent, 'ON');
	assert.equal(app(doc).byTag('img').filter((i) => /onerror/.test(i.attrs.src || '')).length, 0);
	assert.match(people[3].textContent, /<img src=x onerror=alert\(1\)>/);   // shown as text
});

test('data from the JSON is never interpreted as HTML', async () => {
	const data = JSON.parse(JSON.stringify(DATA));
	data.challenges[0].title = '<script>alert(1)</script>';
	data.challenges[0].labs[0].summary = '<img src=x onerror=alert(2)>';
	const { doc, page } = setup({ data });
	await page.init();
	assert.equal(app(doc).byTag('script').length, 0);
	assert.equal(app(doc).byTag('img').length, 0);
	assert.match(app(doc).textContent, /<script>alert\(1\)<\/script>/);
});

test('missing README is handled', async () => {
	const data = JSON.parse(JSON.stringify(DATA));
	data.challenges[1].readme = 'challenges/nope/README.md';
	const { doc, page } = setup({ query: '?c=nmap', data });
	await page.init();
	await until(() => /could not be loaded/.test(app(doc).textContent));
});
