/* Background: the only component that talks to the native launcher. Pages never reach it directly. */
if (typeof importScripts === 'function') importScripts('common.js', 'config.js'); // Chrome service worker

(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const SP = globalThis.SP;
  const CONFIG = globalThis.SP_CONFIG;
  const POLL_ALARM = 'sp-poll';

  let native = null;
  let seq = 0;
  const inflight = new Map(); // native id -> {port, cid, action}

  const safe = (v) => { if (v && typeof v.catch === 'function') v.catch(() => {}); };

  function trustedSender(port) {
    const s = port.sender || {};
    if (s.id !== undefined && s.id !== api.runtime.id) return false;
    const url = s.url || '';
    if (url.startsWith(api.runtime.getURL(''))) return true; // our popup
    return CONFIG.allowedPrefixes.some((p) => url.startsWith(p));
  }

  function post(port, obj) {
    if (!port) return;
    try { port.postMessage(obj); } catch (_e) { /* client went away */ }
  }

  // ---- native connection ------------------------------------------------
  function ensureNative() {
    if (native) return native;
    const p = api.runtime.connectNative(SP.HOST_NAME);
    p.onMessage.addListener(onNativeMessage);
    p.onDisconnect.addListener(() => onNativeDisconnect(p));
    native = p;
    return p;
  }

  function onNativeDisconnect(p) {
    const msg = (p && p.error && p.error.message) ||
      (api.runtime.lastError && api.runtime.lastError.message) || '';
    if (native === p) native = null;
    const err = SP.mapDisconnect(msg, api.runtime.id);
    for (const [nid, job] of inflight) {
      post(job.port, SP.errorResult(job.cid, err.code, err.message, err.hint, { extension_id: err.extension_id }));
      inflight.delete(nid);
    }
    setBadge(0);
  }

  function onNativeMessage(m) {
    const job = m && inflight.get(m.id);
    if (!job) return;
    const out = Object.assign({}, m, { id: job.cid });
    if (m.type === 'result') {
      inflight.delete(m.id);
      if (m.ok && job.action === 'ping' && m.data) {
        out.data = Object.assign({}, m.data, { extension: { version: api.runtime.getManifest().version } });
      }
      if (m.ok) afterSuccess(job.action, m.data);
    }
    post(job.port, out);
  }

  function send(port, req) {
    const nid = 'e' + (++seq);
    inflight.set(nid, { port, cid: req.id, action: req.action });
    const wire = Object.assign({}, req, { id: nid });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        ensureNative().postMessage(wire);
        return;
      } catch (_e) {
        native = null; // stale port: reconnect once
      }
    }
    inflight.delete(nid);
    post(port, SP.errorResult(req.id, 'HOST_DISCONNECTED', 'Could not reach the launcher app.',
      'Retry. If it keeps happening, run: silentproxy doctor'));
  }

  // ---- badge / polling ---------------------------------------------------
  function setBadge(count) {
    if (!api.action) return;
    safe(api.action.setBadgeText({ text: count ? 'ON' : '' }));
    if (count) safe(api.action.setBadgeBackgroundColor({ color: '#f97316' }));
  }

  function afterSuccess(action, data) {
    if (action === 'status' && data) {
      const n = (data.labs || []).length;
      setBadge(n);
      if (!n && api.alarms) safe(api.alarms.clear(POLL_ALARM));
    } else if (action === 'start' && data) {
      setBadge(1);
      if (api.alarms) api.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
    } else if ((action === 'stop' || action === 'stop_all') && data) {
      send(null, { id: 'internal-status', action: 'status' }); // refresh badge
    }
  }

  if (api.alarms) {
    api.alarms.onAlarm.addListener((a) => {
      if (a.name === POLL_ALARM) send(null, { id: 'internal-poll', action: 'status' });
    });
  }

  // ---- clients (content-script bridge, popup) ------------------------------
  api.runtime.onConnect.addListener((port) => {
    if (!trustedSender(port)) {
      port.disconnect();
      return;
    }
    port.onMessage.addListener((msg) => {
      const v = SP.validateRequest(msg);
      if (!v.ok) {
        const id = msg && typeof msg.id === 'string' && SP.REQUEST_ID.test(msg.id) ? msg.id : null;
        post(port, SP.errorResult(id, v.error.code, v.error.message));
        return;
      }
      send(port, v.request);
    });
    port.onDisconnect.addListener(() => {
      // The launcher keeps working on in-flight requests; we just stop forwarding to a closed page.
      for (const job of inflight.values()) if (job.port === port) job.port = null;
    });
  });
})();
