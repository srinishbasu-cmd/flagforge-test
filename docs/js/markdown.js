/* A small, safe Markdown renderer for challenge READMEs.
   Raw HTML is never interpreted; output is built from DOM nodes with textContent, and only https / relative
   URLs survive. Supports headings, paragraphs, lists (nested), fenced code, quotes, tables, hr, bold/italic/code/links/images. */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.FF = Object.assign(root.FF || {}, api);
})(typeof window !== "undefined" ? window : globalThis, function () {
	"use strict";

	function safeUrl(raw) {
		const url = String(raw || "").trim();
		if (!url || /[\u0000-\u0020\u007f]/.test(url)) return null;   // no whitespace/control chars (blocks "java\tscript:")
		if (url.startsWith("//")) return null;
		if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) return /^https:\/\//i.test(url) ? url : null;
		return url;                                                    // relative path or #anchor
	}

	function matchBracket(s, i) { // s[i] === "[" ; returns {text,url,end} for [text](url)
		let depth = 0, j = i;
		for (; j < s.length; j++) {
			if (s[j] === "\\") { j++; continue; }
			if (s[j] === "[") depth++;
			else if (s[j] === "]" && --depth === 0) break;
		}
		if (j >= s.length || s[j + 1] !== "(") return null;
		const close = s.indexOf(")", j + 2);
		if (close < 0) return null;
		const url = s.slice(j + 2, close).split(/\s+/)[0];
		return { text: s.slice(i + 1, j), url, end: close + 1 };
	}

	const isWordChar = (c) => !!c && /[A-Za-z0-9]/.test(c);

	function parseInline(s) {
		const out = [];
		let buf = "", i = 0;
		const flush = () => { if (buf) { out.push({ t: "text", v: buf }); buf = ""; } };
		while (i < s.length) {
			const ch = s[i];
			if (ch === "\\" && i + 1 < s.length) { buf += s[i + 1]; i += 2; continue; }
			if (ch === "`") {
				const j = s.indexOf("`", i + 1);
				if (j > i) { flush(); out.push({ t: "code", v: s.slice(i + 1, j) }); i = j + 1; continue; }
			}
			if (ch === "!" && s[i + 1] === "[") {
				const m = matchBracket(s, i + 1);
				const src = m && safeUrl(m.url);
				if (m && src) { flush(); out.push({ t: "img", src, alt: m.text }); i = m.end; continue; }
			}
			if (ch === "[") {
				const m = matchBracket(s, i);
				if (m) {
					flush();
					const href = safeUrl(m.url);
					if (href) out.push({ t: "link", href, c: parseInline(m.text) });
					else out.push(...parseInline(m.text));
					i = m.end;
					continue;
				}
			}
			if ((ch === "*" || ch === "_") && s[i + 1] === ch) {
				const j = s.indexOf(ch + ch, i + 2);
				if (j > i + 2) { flush(); out.push({ t: "strong", c: parseInline(s.slice(i + 2, j)) }); i = j + 2; continue; }
			}
			if (ch === "*" || ch === "_") {
				const j = s.indexOf(ch, i + 1);
				const okOpen = ch === "*" || !isWordChar(s[i - 1]);
				if (j > i + 1 && s[i + 1] !== " " && okOpen && (ch === "*" || !isWordChar(s[j + 1]))) {
					flush(); out.push({ t: "em", c: parseInline(s.slice(i + 1, j)) }); i = j + 1; continue;
				}
			}
			buf += ch; i++;
		}
		flush();
		return out;
	}

	const RE = {
		fence: /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/,
		heading: /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
		hr: /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,
		quote: /^\s{0,3}>\s?(.*)$/,
		ul: /^(\s*)[-*+]\s+(.*)$/,
		ol: /^(\s*)\d+[.)]\s+(.*)$/,
		tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
	};

	const splitRow = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
	const startsBlock = (l) => RE.fence.test(l) || RE.heading.test(l) || RE.hr.test(l) || RE.quote.test(l) || RE.ul.test(l) || RE.ol.test(l);

	function parseBlocks(lines) {
		const blocks = [];
		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			if (!line.trim()) { i++; continue; }

			let m = RE.fence.exec(line);
			if (m) {
				const fence = m[1], body = [];
				i++;
				while (i < lines.length && !(lines[i].trim().startsWith(fence[0].repeat(fence.length)) && lines[i].trim().replace(new RegExp("^" + (fence[0] === "`" ? "`" : "~") + "+"), "") === "")) body.push(lines[i++]);
				i++;
				blocks.push({ type: "code", lang: m[2] || "", text: body.join("\n") });
				continue;
			}
			if ((m = RE.heading.exec(line))) { blocks.push({ type: "heading", level: m[1].length, inline: parseInline(m[2]) }); i++; continue; }
			if (RE.hr.test(line)) { blocks.push({ type: "hr" }); i++; continue; }
			if (RE.quote.test(line)) {
				const q = [];
				while (i < lines.length && RE.quote.test(lines[i])) q.push(RE.quote.exec(lines[i++])[1]);
				blocks.push({ type: "quote", blocks: parseBlocks(q) });
				continue;
			}
			if (RE.ul.test(line) || RE.ol.test(line)) {
				const ordered = RE.ol.test(line);
				const re = ordered ? RE.ol : RE.ul;
				const baseIndent = re.exec(line)[1].length;
				const items = [];
				while (i < lines.length) {
					const mm = re.exec(lines[i]);
					if (!mm || mm[1].length !== baseIndent) break;
					const item = [mm[2]];
					i++;
					while (i < lines.length) {
						const l = lines[i];
						if (!l.trim()) { if (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !re.test(lines[i + 1])) { item.push(""); i++; continue; } break; }
						const indent = l.match(/^\s*/)[0].length;
						if (indent > baseIndent) { item.push(l.slice(Math.min(indent, baseIndent + 2))); i++; }
						else break;
					}
					items.push(parseBlocks(item));
				}
				blocks.push({ type: ordered ? "ol" : "ul", items });
				continue;
			}
			if (line.includes("|") && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]) && lines[i + 1].includes("-")) {
				const head = splitRow(line).map(parseInline), rows = [];
				i += 2;
				while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]).map(parseInline));
				blocks.push({ type: "table", head, rows });
				continue;
			}
			const para = [line.trim()];
			i++;
			while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++].trim());
			blocks.push({ type: "p", inline: parseInline(para.join(" ")) });
		}
		return blocks;
	}

	function parse(md) {
		return parseBlocks(String(md || "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"));
	}

	// ---- DOM building (textContent / setAttribute only) ----
	function buildInline(doc, nodes, parent) {
		for (const n of nodes) {
			let el;
			if (n.t === "text") { parent.append(doc.createTextNode(n.v)); continue; }
			if (n.t === "code") { el = doc.createElement("code"); el.textContent = n.v; }
			else if (n.t === "strong" || n.t === "em") { el = doc.createElement(n.t); buildInline(doc, n.c, el); }
			else if (n.t === "link") {
				el = doc.createElement("a");
				el.setAttribute("href", n.href);
				if (/^https:/i.test(n.href)) { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); }
				buildInline(doc, n.c, el);
			} else if (n.t === "img") {
				el = doc.createElement("img");
				el.setAttribute("src", n.src);
				el.setAttribute("alt", n.alt);
				el.setAttribute("loading", "lazy");
			}
			parent.append(el);
		}
	}

	function buildBlocks(doc, blocks, parent) {
		for (const b of blocks) {
			let el;
			switch (b.type) {
				case "heading":
					el = doc.createElement("h" + Math.min(6, b.level + 2)); // page already has h1/h2
					buildInline(doc, b.inline, el);
					break;
				case "p": el = doc.createElement("p"); buildInline(doc, b.inline, el); break;
				case "hr": el = doc.createElement("hr"); break;
				case "code": {
					el = doc.createElement("pre");
					const code = doc.createElement("code");
					code.textContent = b.text;
					if (b.lang) code.setAttribute("class", "lang-" + b.lang.replace(/[^\w-]/g, ""));
					el.append(code);
					break;
				}
				case "quote": el = doc.createElement("blockquote"); buildBlocks(doc, b.blocks, el); break;
				case "ul": case "ol":
					el = doc.createElement(b.type);
					for (const item of b.items) {
						const li = doc.createElement("li");
						if (item.length === 1 && item[0].type === "p") buildInline(doc, item[0].inline, li);
						else buildBlocks(doc, item, li);
						el.append(li);
					}
					break;
				case "table": {
					el = doc.createElement("table");
					const thead = doc.createElement("thead"), tr = doc.createElement("tr");
					for (const c of b.head) { const th = doc.createElement("th"); buildInline(doc, c, th); tr.append(th); }
					thead.append(tr); el.append(thead);
					const tbody = doc.createElement("tbody");
					for (const row of b.rows) {
						const r = doc.createElement("tr");
						for (const c of row) { const td = doc.createElement("td"); buildInline(doc, c, td); r.append(td); }
						tbody.append(r);
					}
					el.append(tbody);
					break;
				}
				default: continue;
			}
			parent.append(el);
		}
	}

	function renderInto(container, md, doc) {
		buildBlocks(doc || document, parse(md), container);
		return container;
	}

	return { md: { parse, renderInto, safeUrl } };
});
