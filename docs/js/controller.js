/* Lab controller: all the logic of "is my setup ready / start / stop / extend", with no DOM.
   It talks to the Silent Proxy extension through window.SilentProxy (see silentproxy-client.js). */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.FF = Object.assign(root.FF || {}, api);
})(typeof window !== "undefined" ? window : globalThis, function () {
	"use strict";

	const errObj = (e) => ({
		code: (e && e.code) || "UNKNOWN",
		message: (e && e.message) || "Something went wrong.",
		hint: e && e.hint,
		problems: e && e.details && e.details.problems,
		port: e && e.details && e.details.port,
	});

	/** Only loopback http(s) URLs become clickable; anything else is shown as text. */
	function normalizeUrls(urls) {
		return (Array.isArray(urls) ? urls : []).map((u) => {
			let link = false;
			try {
				const p = new URL(u.url);
				link = (p.protocol === "http:" || p.protocol === "https:") && (p.hostname === "127.0.0.1" || p.hostname === "localhost");
			} catch (_e) { /* not a URL */ }
			return { name: String(u.name || u.url), url: String(u.url), link };
		});
	}

	function createController(sp, labIds, opts) {
		opts = opts || {};
		const now = opts.now || Date.now;
		const setIv = opts.setInterval || ((f, ms) => setInterval(f, ms));
		const clearIv = opts.clearInterval || ((t) => clearInterval(t));
		const pollMs = opts.pollMs || 20000;

		const state = {
			setup: { ext: "checking", host: "checking", docker: "checking", error: null },
			labs: {},
			conflict: null,   // {labId, running:[ids]} when the launcher says another lab is running
			others: [],       // running labs that belong to a different challenge
			notice: null,
		};
		for (const id of labIds) state.labs[id] = { status: "idle" };

		const listeners = [];
		const emit = () => listeners.forEach((f) => f(state));
		let timer = null;

		const ready = () => state.setup.ext === "ok" && state.setup.host === "ok" && state.setup.docker === "ok";
		const busy = (L) => L.status === "starting" || L.status === "stopping";

		async function checkSetup() {
			state.setup = { ext: "checking", host: "checking", docker: "checking", error: null };
			state.notice = null;
			emit();
			const d = await sp.detect();
			if (!d.extension) {
				state.setup = { ext: "missing", host: "unknown", docker: "unknown", reload: !!d.reload, error: null };
				emit();
				return state;
			}
			if (!d.host) {
				state.setup = { ext: "ok", host: "missing", docker: "unknown", error: d.error || null };
				emit();
				return state;
			}
			state.setup = { ext: "ok", host: "ok", docker: "checking", error: null, launcherVersion: d.version };
			emit();
			try {
				const doc = await sp.doctor();
				const ok = !!(doc.daemon_running && doc.compose_ok);
				state.setup.docker = ok ? "ok" : "bad";
				state.setup.error = ok ? null : (doc.error || { code: "DOCKER_FAILED", message: "Docker is not ready." });
			} catch (e) {
				state.setup.docker = "bad";
				state.setup.error = errObj(e);
			}
			emit();
			await refreshStatus();
			return state;
		}

		async function refreshStatus() {
			let st;
			try { st = await sp.status(); } catch (e) { state.notice = errObj(e); emit(); return; }
			const running = {};
			for (const l of st.labs || []) running[l.lab] = l;
			for (const id of Object.keys(state.labs)) {
				const L = state.labs[id];
				if (busy(L)) continue;
				const r = running[id];
				const prev = L.status;
				if (r) {
					L.status = "running";
					L.urls = normalizeUrls(r.urls);
					L.expiresAt = now() + (r.expires_in || 0) * 1000;
					L.services = r.services || [];
					if (prev !== "running") L.error = null; // keep e.g. a failed-stop message visible
				} else if (L.status === "running") {
					L.status = "idle"; L.urls = []; L.expiresAt = null;
				}
			}
			state.others = Object.keys(running).filter((id) => !(id in state.labs));
			managePolling();
			emit();
		}

		function managePolling() {
			const active = Object.values(state.labs).some((L) => L.status === "running" || busy(L));
			if (active && !timer) timer = setIv(refreshStatus, pollMs);
			if (!active && timer) { clearIv(timer); timer = null; }
		}

		async function start(id, o) {
			const L = state.labs[id];
			if (!L || busy(L)) return;
			if (!ready()) {
				L.error = { code: "SETUP_INCOMPLETE", message: "Finish the setup steps above first." };
				emit();
				return;
			}
			state.conflict = null;
			L.status = "starting"; L.error = null; L.progress = { stage: "registry", message: "Starting…" };
			managePolling();
			emit();
			try {
				const res = await sp.start(id, {
					replace: !!(o && o.replace),
					onProgress: (p) => { L.progress = { stage: p.stage, message: p.message, percent: p.percent }; emit(); },
				});
				L.status = "running";
				L.urls = normalizeUrls(res.urls);
				L.expiresAt = now() + (res.expires_in || 0) * 1000;
				L.ready = res.ready !== false;
				L.progress = null;
			} catch (e) {
				L.status = "idle"; L.progress = null;
				if (e && e.code === "OTHER_LAB_RUNNING") state.conflict = { labId: id, running: (e.details && e.details.running) || [] };
				else L.error = errObj(e);
			}
			emit();
			await refreshStatus();
		}

		async function stop(id) {
			const L = state.labs[id];
			if (!L || busy(L)) return;
			L.status = "stopping"; L.error = null; emit();
			try {
				await sp.stop(id);
				L.status = "idle"; L.urls = []; L.expiresAt = null;
			} catch (e) {
				L.status = "running"; L.error = errObj(e);
			}
			emit();
			await refreshStatus();
		}

		async function extend(id, hours) {
			const L = state.labs[id];
			if (!L || L.status !== "running") return;
			try {
				const r = await sp.extend(id, hours || 1);
				L.expiresAt = now() + r.expires_in * 1000;
				L.error = null;
			} catch (e) { L.error = errObj(e); }
			emit();
		}

		return {
			state, ready, checkSetup, refreshStatus, start, stop, extend,
			dismissConflict() { state.conflict = null; emit(); },
			onChange(f) { listeners.push(f); },
			destroy() { if (timer) { clearIv(timer); timer = null; } },
		};
	}

	return { createController, normalizeUrls };
});
