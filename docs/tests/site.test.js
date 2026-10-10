'use strict';
// Static checks: every link resolves, data is consistent, and the pages stay CSP-clean.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(ROOT, f));
const DATA = JSON.parse(read('data/challenges.json'));
const PAGES = ['index.html', 'jr-pentest.html', 'challenge.html'];
const sandbox = { window: {} };
vm.runInNewContext(read('js/config.js'), sandbox);
const CFG = sandbox.window.FLAGFORGE;

test('every card on jr-pentest.html opens a challenge that exists, and every challenge has a card', () => {
	const linked = [...read('jr-pentest.html').matchAll(/href="challenge\.html\?c=([^"]+)"/g)].map((m) => m[1]);
	const slugs = DATA.challenges.map((c) => c.slug);
	assert.deepEqual([...linked].sort(), [...slugs].sort());
	assert.ok(read('index.html').includes('href="jr-pentest.html"'));
	for (const t of DATA.tracks) assert.ok(exists(t.page), t.page);
});

test('challenge data is consistent', () => {
	const seen = new Set();
	for (const c of DATA.challenges) {
		assert.match(c.slug, /^[a-z0-9-]+$/);
		assert.ok(!seen.has(c.slug)); seen.add(c.slug);
		assert.ok(DATA.tracks.some((t) => t.slug === c.track), c.slug + ' track');
		assert.ok(['live', 'coming-soon'].includes(c.status));
		assert.ok(c.title && c.tagline && c.difficulty);
		assert.ok(exists(c.readme), c.readme);
		assert.match(c.repo, /^https:\/\/github\.com\//);
		if (c.status === 'live') assert.ok(c.labs.length > 0, 'live challenge needs labs');
		const ids = c.labs.map((l) => l.id);
		assert.equal(new Set(ids).size, ids.length);
		for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9-]{1,47}$/, 'lab id must match the launcher rule');
		for (const p of c.contributors) {
			assert.ok(p.name);
			if (p.github) assert.match(p.github, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);
			if (p.photo) { assert.match(p.photo, /^[\w./-]+$/); assert.ok(!p.photo.includes('..')); assert.ok(exists(p.photo), p.photo); }
		}
	}
});

test('Burp lab ids match the launcher labs naming (mission-N-...)', () => {
	const ids = DATA.challenges.find((c) => c.slug === 'burp-suite').labs.map((l) => l.id);
	ids.forEach((id, i) => assert.ok(id.startsWith(`mission-${i + 1}-`), id));
});

test('pages are CSP-clean: same policy everywhere, no inline script, style or handlers', () => {
	const policies = new Set();
	for (const f of PAGES) {
		const html = read(f);
		const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
		assert.ok(csp, f + ' needs a CSP');
		policies.add(csp[1]);
		assert.match(csp[1], /script-src 'self'(;|$)/);
		assert.ok(!/unsafe-inline|unsafe-eval/.test(csp[1]));
		assert.ok(![...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>/gi)].length, f + ' has an inline script');
		assert.ok(!/\sstyle=/i.test(html), f + ' has an inline style attribute');
		assert.ok(!/\son[a-z]+=/i.test(html), f + ' has an inline handler');
	}
	assert.equal(policies.size, 1);
});

test('every local asset a page references exists, scripts load in dependency order', () => {
	for (const f of PAGES) {
		for (const m of read(f).matchAll(/(?:src|href)="([^"#?]+)"/g)) {
			if (/^https?:|^#/.test(m[1])) continue;
			assert.ok(exists(m[1]), `${f} -> ${m[1]}`);
		}
	}
	const order = [...read('challenge.html').matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
	assert.deepEqual(order, ['js/config.js', 'js/markdown.js', 'js/controller.js', 'js/silentproxy-client.js', 'js/challenge.js']);
});

test('download links point at GitHub and use the launcher release file names', () => {
	for (const url of [...Object.values(CFG.launcher.downloads), CFG.launcher.releasesPage, CFG.extension.firefox, CFG.extension.chrome]) {
		assert.match(url, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\//);
	}
	for (const os of ['linux', 'macos', 'windows']) assert.ok(CFG.launcher.downloads[os].endsWith('/' + CFG.launcher.fileNames[os]));
	const wf = path.join(ROOT, '..', 'silentproxy-launcher', '.github', 'workflows', 'release.yml');
	if (fs.existsSync(wf)) {
		const text = fs.readFileSync(wf, 'utf8');
		for (const name of Object.values(CFG.launcher.fileNames)) assert.ok(text.includes(name), name + ' not produced by the launcher release workflow');
	}
});

test('the bundled SDK is the extension SDK (same file)', () => {
	const ext = path.join(ROOT, '..', 'silentproxy-extension', 'sdk', 'silentproxy-client.js');
	if (fs.existsSync(ext)) assert.equal(read('js/silentproxy-client.js'), fs.readFileSync(ext, 'utf8'));
});
