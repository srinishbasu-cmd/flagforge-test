'use strict';
// Just enough DOM to run the site's renderer under Node.
class Text { constructor(d) { this.nodeType = 3; this.data = String(d); this.parentNode = null; } get textContent() { return this.data; } }
class El {
	constructor(tag) { this.nodeType = 1; this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.parentNode = null; this.style = {}; this._text = null; }
	append(...n) { for (const x of n) { x.parentNode = this; this.children.push(x); } }
	get firstChild() { return this.children[0] || null; }
	replaceChild(n, o) { const i = this.children.indexOf(o); this.children[i] = n; n.parentNode = this; o.parentNode = null; }
	removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; }
	setAttribute(k, v) { this.attrs[k] = String(v); }
	getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
	addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
	click() { for (const f of this.listeners.click || []) f({ target: this }); }
	fire(t, ev) { for (const f of this.listeners[t] || []) f(ev || {}); }
	set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = String(v); }
	get textContent() { return (this._text || '') + this.children.map((c) => c.textContent).join(''); }
	set disabled(v) { this.attrs.disabled = v; } get disabled() { return 'disabled' in this.attrs; }
	walk(fn) { fn(this); for (const c of this.children) if (c.nodeType === 1) c.walk(fn); }
	all(pred) { const out = []; this.walk((e) => { if (pred(e)) out.push(e); }); return out; }
	byTag(tag) { return this.all((e) => e.tag === tag); }
	byClass(cls) { return this.all((e) => (e.attrs.class || '').split(/\s+/).includes(cls)); }
	querySelectorAll(sel) { const m = /^\[([\w-]+)\]$/.exec(sel); return m ? this.all((e) => m[1] in e.attrs) : this.all((e) => e.tag === sel); }
}
function makeDoc(ids = ['app']) {
	const els = Object.fromEntries(ids.map((i) => [i, new El('main')]));
	const listeners = {};
	return {
		title: '', visibilityState: 'visible', els,
		createElement: (t) => new El(t), createTextNode: (t) => new Text(t),
		getElementById: (id) => els[id] || null,
		querySelectorAll: (sel) => { const out = []; for (const e of Object.values(els)) out.push(...e.querySelectorAll(sel)); return out; },
		addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
		fire: (t) => (listeners[t] || []).forEach((f) => f({})),
	};
}
module.exports = { El, Text, makeDoc };
