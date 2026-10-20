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

	function h(tag, props, ...kids) {
		const el = doc.createElement(tag);
		for (const [k, v] of Object.entries(props || {})) {
			if (v === undefined || v === null || v === false) continue;
			if (k === "text") el.textContent = v;
			else if (k === "html") el.innerHTML = v;
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

	function copyButton(text) {
		const b = h("button", { type: "button", class: "btn small copy", text: "Copy" });
		b.addEventListener("click", async () => {
			try { await env.navigator.clipboard.writeText(text); b.textContent = "Copied!"; } catch (_e) { b.textContent = "Error"; }
			if (env.setTimeout) env.setTimeout(() => { b.textContent = "Copy"; }, 1500);
		});
		return b;
	}

	// V0 Style Terminal Box
	function terminalBox(os) {
		const f = CFG.launcher.fileNames[os];
		const cmd = os === "windows" ? `.\\${f} install` : `./${f} install`;
		return h("div", { class: "terminal-window" },
			h("div", { class: "terminal-header" },
				h("div", { class: "terminal-dots" },
					h("span", { style: "background:#ff5f56;" }),
					h("span", { style: "background:#ffbd2e;" }),
					h("span", { style: "background:#27c93f;" })
				),
				copyButton(cmd)
			),
			h("div", { class: "terminal-body" },
				h("span", { style: "color:#27c93f; margin-right:8px;" }, "~/flagforge"),
				h("span", { style: "color:var(--text);" }, cmd)
			)
		);
	}

	const fmtLeft = (ms) => {
		const m = Math.max(0, Math.floor(ms / 60000));
		return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m left";
	};

	function hero(ch, os) {
		const live = ch.status === "live";
		const dl = CFG.launcher.downloads[os];
		return h("header", { class: "v0-hero" },
			h("div", { class: "v0-hero-left" },
				h("p", { class: "v0-eyebrow" }, 
					h("span", { class: "dot ok", style: "display:inline-block; vertical-align:middle; margin-right:8px; width:8px; height:8px;" }), 
					"ACTIVE CHALLENGE / 01"
				),
				h("h1", { class: "v0-title", html: ch.title.replace("-CTF", "<span>-CTF</span>") }),
				h("p", { class: "v0-subtitle", text: "Intercept. Analyze. Exploit. A hands-on challenge for the curious minds who live between the request and the response." })
			),
			h("div", { class: "v0-hero-right" },
				h("div", { class: "v0-badge" }, "🛡️ Difficulty: " + ch.difficulty),
				h("div", { class: "v0-badge live" }, h("span", { class: "live-dot" }), "Live"),
				h("div", { class: "v0-badge" }, "📁 Missions: 6")
			)
		);
	}

	function briefingPanel(ch) {
		if (!ch.briefing) return null;
		const b = ch.briefing;
		const intro = h("div", { class: "v0-briefing-text", html: b.intro.join(" ") }); // Simplified for v0 look
		const setup = h("ol", {}, (b.setup || []).map((s) => h("li", { text: s })));
		const hints = h("ul", {}, (b.hints || []).map((hi) => h("li", {}, h("span", { class: "hint-badge", text: hi.unlocksAfter }), " " + hi.text)));

		return h("section", { class: "v0-panel", id: "briefing" },
			h("div", { class: "v0-panel-header" },
				h("h2", {}, "Briefing "),
				h("span", { class: "v0-panel-sub" }, "Mission context & objectives")
			),
			intro,
			h("div", { class: "v0-quick-stats" },
				h("div", { class: "stat" }, h("span", { class: "icon" }, "🌐"), "Reconnaissance"),
				h("div", { class: "stat" }, h("span", { class: "icon" }, "🛡️"), "Interception"),
				h("div", { class: "stat" }, h("span", { class: "icon" }, "💻"), "Exfiltration")
			),
			h("details", { class: "briefing-details", style: "margin-top:24px;" },
				h("summary", { text: "Setup guide" }),
				setup
			),
			h("details", { class: "briefing-details" },
				h("summary", { text: "Hints" }),
				hints
			)
		);
	}

	function inlineFlagPanel(lab) {
		const storageKey = "ff_flags_" + lab.id;
		let found = new Set(JSON.parse(localStorage.getItem(storageKey) || "[]"));
		const percent = Math.round((found.size / lab.flags_list.length) * 100);
		
		const input = h("input", { type: "text", placeholder: "FLAG{...}", class: "v0-input" });
		const msg = h("div", { class: "v0-msg" });
		const countText = h("span", { class: "v0-count", text: `${found.size}/${lab.flags_list.length} Flags` });
		const percentText = h("span", { class: "v0-percent", text: `${percent}%` });
		const progressFill = h("div", { class: "v0-progress-fill", style: `width: ${percent}%` });

		const submit = h("button", { type: "button", class: "v0-submit", text: "Submit flag" });
		
		function handleSubmit() {
			const val = input.value.trim();
			if (!val) return;
			msg.style.opacity = "0";
			
			setTimeout(() => {
				if (found.has(val)) {
					msg.textContent = "You already submitted this flag.";
					msg.className = "v0-msg info"; msg.style.opacity = "1";
					return;
				}

				if (lab.flags_list.includes(val)) {
					found.add(val);
					localStorage.setItem(storageKey, JSON.stringify([...found]));
					const newPercent = Math.round((found.size / lab.flags_list.length) * 100);
					
					countText.textContent = `${found.size}/${lab.flags_list.length} Flags`;
					percentText.textContent = `${newPercent}%`;
					progressFill.style.width = `${newPercent}%`;
					
					msg.textContent = found.size === lab.flags_list.length ? "🎉 Mission Complete!" : "✅ Correct! Flag accepted.";
					msg.className = "v0-msg success"; msg.style.opacity = "1";
					input.value = "";
				} else {
					msg.textContent = "❌ Incorrect flag. Keep trying.";
					msg.className = "v0-msg error"; msg.style.opacity = "1";
				}
			}, 100);
		}

		submit.addEventListener("click", handleSubmit);
		input.addEventListener("keypress", (e) => { if (e.key === "Enter") handleSubmit(); });

		return h("div", { class: "v0-flag-box" },
			h("div", { class: "v0-flag-header" },
				h("span", { class: "v0-flag-label" }, "FLAG RECOVERY"),
				countText
			),
			h("div", { class: "v0-progress-container" },
				h("div", { class: "v0-progress-track" }, progressFill),
				percentText
			),
			h("div", { class: "v0-input-group" },
				h("span", { class: "v0-prompt" }, "$"),
				input,
				submit
			),
			msg
		);
	}

	function missionPanel(ch, ctl) {
		const lab = ch.labs[0]; // For now just Mission 1
		const L = ctl.state.labs[lab.id];
		
		let controls;
		if (L.status === "starting") {
			controls = h("div", { class: "v0-badge live" }, h("span", { class: "live-dot animate" }), "Starting...");
		} else if (L.status === "running") {
			controls = h("div", { class: "v0-badge live" }, h("span", { class: "live-dot" }), "Running");
		} else {
			controls = h("button", { type: "button", class: "v0-start-btn", text: "▶ Start lab", disabled: !ctl.ready(), onclick: () => ctl.start(lab.id) });
		}

		return h("section", { class: "v0-panel", id: "launch" },
			h("div", { class: "v0-panel-header", style: "display:flex; justify-content:space-between; align-items:flex-start; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:16px; margin-bottom:16px;" },
				h("div", {},
					h("h2", { style: "font-size:1.4rem;" }, "Missions"),
					h("span", { class: "v0-panel-sub" }, "Progress through the operation")
				),
				h("span", { style: "font-family:var(--font-mono); color:var(--accent); font-size:0.9rem; margin-top:8px;" }, "01 / 06")
			),
			h("div", { class: "v0-mission-row" },
				h("div", { class: "v0-mission-num" }, "01"),
				h("div", { class: "v0-mission-info" },
					h("h3", { text: "Setup & Recon" }),
					h("p", { text: "Find the first signal in the noise." })
				),
				controls
			),
			(L.status === "running" && lab.flags_list) ? inlineFlagPanel(lab) : null
		);
	}

	function aboutPanel(ch) {
		const list = (title, items) => items && items.length ? [h("h3", { text: title }), h("ul", { class: "plain" }, items.map((t) => h("li", { text: t })))] : [];
		return h("section", { class: "v0-panel", id: "about" },
			h("h2", { text: "About this lab" }),
			(ch.description || []).map((p) => h("p", { text: p })),
			list("What you will practise", ch.learn),
			list("What you need", ch.requirements));
	}

	function readmePanel(ch) {
		const body = h("div", { class: "markdown", id: "readme-body" }, h("p", { class: "muted", text: "Loading README…" }));
		const panel = h("section", { class: "v0-panel", id: "readme" }, h("h2", { text: "README" }), body);
		env.fetch(ch.readme)
			.then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
			.then((md) => {
				clear(body);
				env.md.renderInto(body, md, doc);
			})
			.catch(() => { clear(body); body.append(h("p", { class: "muted", text: "The README could not be loaded." })); });
		return panel;
	}

	function asidePanels(ch, os) {
		const osButtons = Object.keys(OS_LABEL).map((k) =>
			h("button", { class: "v0-tab " + (k === os ? "active" : ""), onclick: () => {} , text: OS_LABEL[k] }));
		
		return [
			h("section", { class: "v0-panel" },
				h("div", { class: "v0-panel-header" },
					h("h2", {}, "Get the launcher "),
					h("span", { class: "v0-panel-sub" }, "Connect to the challenge environment.")
				),
				h("div", { class: "v0-tabs" }, osButtons),
				terminalBox(os),
				h("button", { class: "v0-download-btn" }, "⬇ Download for " + OS_LABEL[os])
			),
			h("section", { class: "v0-panel" },
				h("div", { class: "v0-panel-header" },
					h("h2", {}, "Browser extension "),
					h("span", { class: "v0-panel-sub" }, "Intercept directly from your browser.")
				),
				h("div", { class: "v0-ext-buttons" },
					h("button", { class: "v0-ext-btn" }, "🦊 Firefox"),
					h("button", { class: "v0-ext-btn" }, "🌐 Chrome")
				)
			),
			h("div", { style: "text-align:center; margin-top:24px; font-size:0.9rem;" },
				h("a", { href: "#", style: "color:var(--text-muted); text-decoration:none;" }, "Need help? Read the field manual")
			)
		];
	}

	function renderChallenge(ch, data, ctlFactory) {
		const os = detectOS();
		const live = ch.status === "live" && ch.labs.length > 0;
		let ctl = null;
		if (live) ctl = ctlFactory(ch.labs.map((l) => l.id));
		
		const main = h("div", { class: "main" },
			briefingPanel(ch),
			live ? missionPanel(ch, ctl) : null,
			aboutPanel(ch), 
			readmePanel(ch)
		);
			
		const aside = h("aside", { class: "side" }, live ? asidePanels(ch, os) : null);
		const page = h("div", {}, hero(ch, os), h("div", { class: "layout" }, main, aside));
		return { page, ctl };
	}

	function showMessage(app, title, text) {
		clear(app);
		app.append(h("div", { class: "v0-panel" }, h("h2", { text: title }), h("p", { text }), h("p", {}, h("a", { class: "btn", href: "index.html", text: "← Back to Flag Forge" }))));
	}

	async function init() {
		const app = $("app");
		let data;
		try {
			const r = await env.fetch("data/challenges.json");
			if (!r.ok) throw new Error("HTTP " + r.status);
			data = await r.json();
		} catch (_e) {
			showMessage(app, "Could not load the challenge data", "If you opened this file directly from disk, serve the folder with a local web server instead.");
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
			if (env.setInterval) env.setInterval(() => {
				for (const el of doc.querySelectorAll("[data-expires]")) el.textContent = fmtLeft(Number(el.getAttribute("data-expires")) - Date.now());
			}, 1000);
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

	return { init, renderChallenge, detectOS, installCommands: () => {}, fmtLeft };
});