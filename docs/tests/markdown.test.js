'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { md } = require('../js/markdown.js');
const { makeDoc } = require('./minidom');

function render(src) {
	const doc = makeDoc();
	const box = doc.createElement('div');
	md.renderInto(box, src, doc);
	return box;
}
const hrefs = (box) => box.byTag('a').map((a) => a.getAttribute('href'));

test('renders the common README building blocks', () => {
	const box = render('# Title\n\nPara with **bold**, *em* and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n> quote\n\n---\n\n```bash\nls -la\n```\n');
	assert.deepEqual(box.children.map((c) => c.tag), ['h3', 'p', 'ul', 'ol', 'blockquote', 'hr', 'pre']);
	assert.equal(box.byTag('strong')[0].textContent, 'bold');
	assert.equal(box.byTag('em')[0].textContent, 'em');
	assert.equal(box.byTag('pre')[0].textContent, 'ls -la');
	assert.equal(box.byTag('pre')[0].byTag('code')[0].attrs.class, 'lang-bash');
});

test('heading levels are shifted below the page h1/h2', () => {
	const box = render('# a\n## b\n#### c\n###### d');
	assert.deepEqual(box.children.map((c) => c.tag), ['h3', 'h4', 'h6', 'h6']);
});

test('nested lists and multi-line items', () => {
	const box = render('- a\n  - a1\n  - a2\n- b\n  continued');
	const ul = box.children[0];
	assert.equal(ul.children.length, 2);
	assert.equal(ul.children[0].byTag('ul').length, 1);
	assert.equal(ul.children[0].byTag('li').length, 3);
	assert.match(ul.children[1].textContent, /b continued/);
});

test('tables', () => {
	const box = render('| A | B |\n| --- | --- |\n| 1 | **2** |\n| 3 | 4 |\n');
	const t = box.byTag('table')[0];
	assert.deepEqual(t.byTag('th').map((e) => e.textContent), ['A', 'B']);
	assert.equal(t.byTag('tr').length, 3);
	assert.equal(t.byTag('strong').length, 1);
});

test('raw HTML is shown as text, never created as elements', () => {
	const box = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> and <b>bold</b>');
	assert.equal(box.byTag('script').length, 0);
	assert.equal(box.byTag('img').length, 0);
	assert.equal(box.byTag('b').length, 0);
	assert.match(box.textContent, /<script>alert\(1\)<\/script>/);
});

test('only https and relative URLs survive in links and images', () => {
	const bad = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hi', 'vbscript:x', 'http://plain.example', '//evil.example/x', 'ftp://x', 'file:///etc/passwd'];
	for (const u of bad) {
		const box = render(`[x](${u}) ![i](${u})`);
		assert.deepEqual(hrefs(box), [], u);
		assert.equal(box.byTag('img').length, 0, u);
	}
	// whitespace inside a URL is cut at the first space, so only a harmless relative "java" can remain
	assert.ok(hrefs(render('[x](java\tscript:alert(1))')).every((h) => !/script/i.test(h)));
	const ok = render('[a](https://example.com/x) [b](docs/page.md) [c](#top) ![i](assets/shot.png) ![j](https://example.com/p.png)');
	assert.deepEqual(hrefs(ok), ['https://example.com/x', 'docs/page.md', '#top']);
	assert.equal(ok.byTag('img').length, 2);
});

test('external links open safely', () => {
	const a = render('[x](https://example.com)').byTag('a')[0];
	assert.equal(a.attrs.target, '_blank');
	assert.equal(a.attrs.rel, 'noopener noreferrer');
	assert.equal(render('[x](page.html)').byTag('a')[0].attrs.target, undefined);
});

test('snake_case and stray markers are left alone; escapes work', () => {
	assert.equal(render('use snake_case_name here').byTag('em').length, 0);
	assert.equal(render('2 * 3 * 4').byTag('em').length, 0);
	assert.equal(render('\\*not em\\*').byTag('em').length, 0);
	assert.equal(render('\\*not em\\*').textContent, '*not em*');
});

test('unterminated constructs do not hang or throw', () => {
	for (const src of ['`open', '**open', '[open](', '[a](b', '![x](', '```\nnever closed', '| a |\n|---', '> ', '- ', '#']) {
		assert.doesNotThrow(() => render(src), src);
	}
	render('a'.repeat(20000) + '*'.repeat(2000));
});
