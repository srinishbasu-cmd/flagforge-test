/* Renders challenge.html?c=<slug> from data/challenges.json + the challenge's README.md.
   All text goes through textContent / text nodes; nothing from the data files is parsed as HTML. */
(function (root, factory) {
	if (typeof module === "object" && module.exports) { module.exports = factory; return; }
	const FF = (root.FF = root.FF || {});
	FF.createPage = factory;
	const doc = root.document;
	if (doc && doc.getElementById("app")) {
		FF.createPage({
			document: doc, location: root.location, navigator: root.navigator, fetch: root.fetch.bind(root),
			config: root.FLAGFORGE, md: FF.md, createController: FF.createController, sp: root.SilentProxy,
			setInterval: root.setInterval.bind(root), setTimeout: root.setTimeout.bind(root), addEventListener: root.addEventListener.bind(root),
		}).init();
	}
})(typeof window !== "undefined" ? window : globalThis, function createPage(env) {
	"use strict";
	const doc = env.document;
	const CFG = env.config;

	// ---------- tiny DOM helper ----------
	function h(tag, props, ...kids) {
		const el = doc.createElement(tag);
		for (const [k, v] of Object.entries(props || {})) {
			if (v === undefined || v === null || v === false) continue;
			if (k === "text") el.textContent = v;
			else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
			else el.setAttribute(k, v === true ? "" : String(v));
		}
		for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(typeof kid === "object" ? kid : doc.createTextNode(String(kid)));
		return el;
	}
	const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
	const $ = (id) => doc.getElementById(id);

	function detectOS() {
		const nav = env.navigator || {};
		const s = String((nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent || "").toLowerCase();
		if (s.includes("win")) return "windows";
		if (s.includes("mac") || s.includes("iphone") || s.includes("ipad")) return "macos";
		return "linux";
	}
	const OS_LABEL = { linux: "Linux", macos: "macOS", windows: "Windows" };

	function installCommands(os) {
		const f = CFG.launcher.fileNames[os];
		const id = CFG.extension.chromeId || "<extension-id>";
		if (os === "windows") return { firefox: `.\\${f} install`, chrome: `.\\${f} install --chrome-id ${id}` };
		const pre = os === "macos" ? `chmod +x ${f} && xattr -d com.apple.quarantine ${f} 2>/dev/null; ` : `chmod +x ${f} && `;
		return { firefox: `${pre}./${f} install`, chrome: `${pre}./${f} install --chrome-id ${id}` };
	}

	function copyButton(text) {
		const b = h("button", { type: "button", class: "btn small copy", text: "Copy" });
		b.addEventListener("click", async () => {
			try { await env.navigator.clipboard.writeText(text); b.textContent = "Copied"; } catch (_e) { b.textContent = "Press Ctrl+C"; }
			if (env.setTimeout) env.setTimeout(() => { b.textContent = "Copy"; }, 1500);
		});
		return b;
	}
	const codeBox = (text) => h("div", { class: "codebox" }, h("pre", {}, h("code", { text })), copyButton(text));

	const fmtLeft = (ms) => {
		const m = Math.max(0, Math.floor(ms / 60000));
		return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m left";
	};

	// ---------- static sections ----------
	function hero(ch, os) {
		const live = ch.status === "live";
		const dl = CFG.launcher.downloads[os];
		return h("header", { class: "hero" },
			h("p", { class: "eyebrow", text: [ch.tool, ch.codename].filter(Boolean).join(" · ") }),
			h("h1", { text: ch.title }),
			h("p", { class: "lead", text: ch.tagline }),
			h("div", { class: "badges" },
				h("span", { class: "badge danger", text: "Difficulty: " + ch.difficulty }),
				h("span", { class: "badge " + (live ? "accent" : "muted"), text: live ? "Live" : "Coming soon" }),
				(ch.facts || []).map((f) => h("span", { class: "badge", text: f.label + ": " + f.value }))),
			live ? h("div", { class: "actions" },
				h("a", { class: "btn primary", href: "#launch", text: "▶ Start lab" }),
				h("a", { class: "btn", href: dl, rel: "noopener", text: "⬇ Download launcher for " + OS_LABEL[os] }),
				h("a", { class: "btn", href: ch.repo, target: "_blank", rel: "noopener noreferrer", text: "GitHub" })) : null);
	}

	function aboutPanel(ch) {
		const list = (title, items) => items && items.length ? [h("h3", { text: title }), h("ul", { class: "plain" }, items.map((t) => h("li", { text: t })))] : [];
		return h("section", { class: "panel", id: "about" },
			h("h2", { text: "About this lab" }),
			(ch.description || []).map((p) => h("p", { text: p })),
			list("What you will practise", ch.learn),
			list("What you need", ch.requirements));
	}

	function readmePanel(ch) {
		const body = h("div", { class: "markdown", id: "readme-body" }, h("p", { class: "muted", text: "Loading README…" }));
		const panel = h("section", { class: "panel", id: "readme" }, h("h2", { text: "README" }), body);
		env.fetch(ch.readme)
			.then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
			.then((md) => {
				clear(body);
				env.md.renderInto(body, md, doc);
				for (const pre of (body.querySelectorAll ? body.querySelectorAll("pre") : [])) {
					const box = h("div", { class: "codebox" });
					pre.parentNode.replaceChild(box, pre);
					box.append(pre, copyButton(pre.textContent));
				}
			})
			.catch(() => { clear(body); body.append(h("p", { class: "muted", text: "The README could not be loaded." })); });
		return panel;
	}

	function initials(name) {
		return String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
	}

	function personCard(p) {
		const user = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(p.github || "") ? p.github : "";
		const photo = p.photo && /^[\w./-]+$/.test(p.photo) && !p.photo.includes("..") ? p.photo : "";
		const src = photo || (user ? `https://github.com/${user}.png?size=160` : "");
		const avatar = h("span", { class: "avatar", "aria-hidden": "true" });
		const fallback = () => { clear(avatar); avatar.append(doc.createTextNode(initials(p.name))); };
		if (src) {
			const img = h("img", { src, alt: "", width: 56, height: 56, loading: "lazy", referrerpolicy: "no-referrer" });
			img.addEventListener("error", fallback);
			avatar.append(img);
		} else fallback();
		const name = user
			? h("a", { href: `https://github.com/${user}`, target: "_blank", rel: "noopener noreferrer", text: p.name })
			: h("span", { text: p.name });
		return h("li", { class: "person" }, avatar, h("div", {}, h("div", { class: "person-name" }, name), p.role ? h("div", { class: "muted", text: p.role }) : null));
	}

	function contributorsPanel(ch) {
		const people = ch.contributors || [];
		return h("section", { class: "panel", id: "contributors" },
			h("h2", { text: "Contributors" }),
			people.length ? h("ul", { class: "people" }, people.map(personCard))
				: h("p", { class: "muted", text: "No contributors listed yet." }),
			h("p", { class: "muted small" }, "Want to help? ", h("a", { href: ch.repo, target: "_blank", rel: "noopener noreferrer", text: "Contribute on GitHub" }), "."));
	}

	function asidePanels(ch, os) {
		const cmds = installCommands(os);
		const osButtons = Object.keys(OS_LABEL).map((k) =>
			h("a", { class: "btn small" + (k === os ? " primary" : ""), href: CFG.launcher.downloads[k], rel: "noopener", text: OS_LABEL[k] }));
		return [
			h("section", { class: "panel", id: "get-launcher" },
				h("h2", { text: "Get the launcher" }),
				h("p", { class: "muted", text: "A small app that downloads the lab from GitHub and runs it with Docker on your own machine." }),
				h("div", { class: "row" }, osButtons),
				h("p", { class: "small muted", text: "After downloading, run the install command for " + OS_LABEL[os] + ":" }),
				codeBox(cmds.firefox),
				h("p", { class: "small muted", text: "Chrome, Edge or Brave need the extension ID:" }),
				codeBox(cmds.chrome),
				h("p", { class: "small muted" }, h("a", { href: CFG.launcher.releasesPage, target: "_blank", rel: "noopener noreferrer", text: "All releases and checksums on GitHub" }))),
			h("section", { class: "panel", id: "get-extension" },
				h("h2", { text: "Browser extension" }),
				h("p", { class: "muted", text: "Lets this page start and stop labs. It only works on this website." }),
				h("div", { class: "row" },
					h("a", { class: "btn small", href: CFG.extension.firefox, target: "_blank", rel: "noopener noreferrer", text: "Firefox" }),
					h("a", { class: "btn small", href: CFG.extension.chrome, target: "_blank", rel: "noopener noreferrer", text: "Chrome / Edge / Brave" }))),
		];
	}

	// ---------- launch panel (live challenges) ----------
	function check(status, title, detail, extra) {
		const sym = { ok: "✓", bad: "!", wait: "…", idle: "·" }[status] || "·";
		return h("li", { class: "check" },
			h("span", { class: "dot " + status, "aria-hidden": "true", text: sym }),
			h("div", {}, h("div", { class: "check-title", text: title }), detail ? h("div", { class: "hint", text: detail }) : null, extra || null));
	}

	function errorBox(err) {
		if (!err) return null;
		return h("div", { class: "alert err", role: "alert" },
			h("strong", { text: err.message }),
			err.hint ? h("div", { class: "hint", text: err.hint }) : null,
			err.problems && err.problems.length ? h("ul", { class: "plain" }, err.problems.map((p) => h("li", { text: p }))) : null,
			err.code ? h("div", { class: "hint code", text: "Error code: " + err.code }) : null);
	}

	function setupList(ctl, os) {
		const s = ctl.state.setup;
		const stat = (v) => (v === "ok" ? "ok" : v === "missing" || v === "bad" ? "bad" : v === "checking" ? "wait" : "idle");
		const items = [];
		items.push(check(stat(s.ext), "Browser extension",
			s.ext === "ok" ? "Detected" : s.ext === "checking" ? "Checking…" : s.reload ? "The extension was reloaded. Reload this page." : "Not detected. Install it from the sidebar, then press Check again."));
		items.push(check(stat(s.host), "Launcher app",
			s.host === "ok" ? "Connected" + (s.launcherVersion ? " (v" + s.launcherVersion + ")" : "") : s.host === "checking" ? "Checking…" : s.host === "missing" ? "Not found. Download it from the sidebar and run its install command." : "Waiting for the extension.",
			s.host === "missing" && s.error ? h("div", { class: "hint", text: (s.error.message || "") + " " + (s.error.hint || "") }) : null));
		items.push(check(stat(s.docker), "Docker",
			s.docker === "ok" ? "Ready" : s.docker === "checking" ? "Checking…" : s.docker === "bad" ? "Not ready." : "Waiting for the launcher.",
			s.docker === "bad" && s.error ? h("div", { class: "hint", text: (s.error.message || "") + " " + (s.error.hint || "") }) : null));
		return h("ol", { class: "checklist" }, items);
	}

	function missionRow(ctl, lab, index) {
		const L = ctl.state.labs[lab.id];
		const ready = ctl.ready();
		let controls;
		if (L.status === "starting") {
			const p = L.progress || {};
			const bar = h("div", { class: "progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": p.percent != null ? p.percent : null },
				h("i", { class: p.percent == null ? "indeterminate" : "" }));
			if (p.percent != null) bar.firstChild.style.width = p.percent + "%";
			controls = h("div", { class: "mission-state" }, bar, h("div", { class: "hint", text: p.message || "Starting…" }));
		} else if (L.status === "stopping") {
			controls = h("div", { class: "hint", text: "Stopping…" });
		} else if (L.status === "running") {
			controls = h("div", { class: "mission-state" },
				h("div", { class: "row" },
					(L.urls || []).map((u) => u.link
						? h("a", { class: "btn small primary", href: u.url, target: "_blank", rel: "noopener noreferrer", text: "Open " + u.name })
						: h("code", { text: u.url })),
					h("span", { class: "hint", "data-expires": L.expiresAt, text: fmtLeft(L.expiresAt - Date.now()) })),
				L.ready === false ? h("div", { class: "hint", text: "Some services are still warming up. Give it a minute." }) : null,
				h("div", { class: "row" },
					h("button", { type: "button", class: "btn small", text: "+1 hour", onclick: () => ctl.extend(lab.id, 1) }),
					h("button", { type: "button", class: "btn small danger", text: "Stop lab", onclick: () => ctl.stop(lab.id) })));
		} else {
			controls = h("button", { type: "button", class: "btn primary", text: "▶ Start lab", disabled: !ready, onclick: () => ctl.start(lab.id) });
		}
		const chip = L.status === "running" ? h("span", { class: "badge accent", text: "Running" }) : null;
		return h("li", { class: "mission" + (L.status === "running" ? " running" : "") },
			h("div", { class: "num", text: String(index + 1).padStart(2, "0") }),
			h("div", { class: "mission-main" },
				h("div", { class: "mission-title" }, lab.title, " ", chip),
				h("div", { class: "muted small", text: lab.summary }),
				h("div", { class: "muted small", text: [lab.flags ? lab.flags + " flags" : "", lab.time].filter(Boolean).join(" · ") }),
				errorBox(L.error)),
			controls);
	}

	function launchBody(ch, ctl, os) {
		const st = ctl.state;
		const out = [setupList(ctl, os),
			h("div", { class: "row" }, h("button", { type: "button", class: "btn small", text: "Check again", onclick: () => ctl.checkSetup() }))];
		if (st.notice) out.push(errorBox(st.notice));
		if (st.conflict) {
			const lab = ch.labs.find((l) => l.id === st.conflict.labId);
			out.push(h("div", { class: "alert info", role: "alert" },
				h("strong", { text: "Another lab is already running" + (st.conflict.running.length ? " (" + st.conflict.running.join(", ") + ")" : "") + "." }),
				h("div", { class: "hint", text: "Only one lab runs at a time. Stop it and start " + (lab ? lab.title : "this mission") + "?" }),
				h("div", { class: "row" },
					h("button", { type: "button", class: "btn small primary", text: "Stop it and start", onclick: () => ctl.start(st.conflict.labId, { replace: true }) }),
					h("button", { type: "button", class: "btn small", text: "Cancel", onclick: () => ctl.dismissConflict() }))));
		}
		if (st.others.length) out.push(h("p", { class: "hint", text: "Running from another challenge: " + st.others.join(", ") }));
		out.push(h("h3", { text: "Missions" }), h("ol", { class: "missions" }, ch.labs.map((lab, i) => missionRow(ctl, lab, i))));
		return out;
	}

	function launchPanel(ch, ctl, os) {
		const body = h("div", { id: "launch-body" });
		const panel = h("section", { class: "panel launch", id: "launch" }, h("h2", { text: "Launch the lab" }), body);
		const render = () => { clear(body); body.append(...launchBody(ch, ctl, os)); };
		ctl.onChange(render);
		render();
		return panel;
	}

	function comingSoonPanel() {
		return h("section", { class: "panel", id: "launch" }, h("h2", { text: "Launch the lab" }),
			h("p", { text: "This challenge is not ready yet. Check back soon." }));
	}

	// ---------- page assembly ----------
	function crumbs(ch, track) {
		return h("nav", { class: "crumbs", "aria-label": "Breadcrumb" },
			h("a", { href: "index.html", text: "Flag Forge" }), h("span", { "aria-hidden": "true", text: "/" }),
			track ? [h("a", { href: track.page, text: track.title }), h("span", { "aria-hidden": "true", text: "/" })] : null,
			h("span", { "aria-current": "page", text: ch.title }));
	}

	function renderChallenge(ch, data, ctlFactory) {
		const os = detectOS();
		const track = (data.tracks || []).find((t) => t.slug === ch.track);
		const live = ch.status === "live" && ch.labs.length > 0;
		let ctl = null;
		if (live) ctl = ctlFactory(ch.labs.map((l) => l.id));
		const main = h("div", { class: "main" },
			live ? launchPanel(ch, ctl, os) : comingSoonPanel(),
			aboutPanel(ch), readmePanel(ch), contributorsPanel(ch));
		const aside = h("aside", { class: "side" }, live ? asidePanels(ch, os) : null);
		const page = h("div", {}, crumbs(ch, track), hero(ch, os), h("div", { class: "layout" }, main, aside));
		return { page, ctl };
	}

	function showMessage(app, title, text) {
		clear(app);
		app.append(h("div", { class: "panel" }, h("h2", { text: title }), h("p", { text }), h("p", {}, h("a", { class: "btn", href: "index.html", text: "← Back to Flag Forge" }))));
	}

	async function init() {
		const app = $("app");
		let data;
		try {
			const r = await env.fetch("data/challenges.json");
			if (!r.ok) throw new Error("HTTP " + r.status);
			data = await r.json();
		} catch (_e) {
			showMessage(app, "Could not load the challenge data", "If you opened this file directly from disk, serve the folder with a local web server instead (for example: python3 -m http.server).");
			return null;
		}
		const slug = new URLSearchParams(env.location.search).get("c") || "";
		const ch = (data.challenges || []).find((c) => c.slug === slug);
		if (!ch) { showMessage(app, "Challenge not found", "That challenge does not exist."); return null; }
		doc.title = ch.title + " · " + CFG.siteName;

		const { page, ctl } = renderChallenge(ch, data, (ids) => env.createController(env.sp, ids));
		clear(app);
		app.append(page);

		if (ctl) {
			ctl.checkSetup();
			// countdown text
			if (env.setInterval) env.setInterval(() => {
				for (const el of doc.querySelectorAll("[data-expires]")) el.textContent = fmtLeft(Number(el.getAttribute("data-expires")) - Date.now());
			}, 1000);
			// returning from installing something: re-check automatically
			let last = 0;
			const recheck = () => {
				if (ctl.ready() || Date.now() - last < 2000) return;
				last = Date.now();
				ctl.checkSetup();
			};
			if (env.addEventListener) env.addEventListener("focus", recheck);
			doc.addEventListener("visibilitychange", () => { if (doc.visibilityState === "visible") recheck(); });
		}
		return { ch, ctl };
	}

	return { init, renderChallenge, detectOS, installCommands, fmtLeft, initials };
});
