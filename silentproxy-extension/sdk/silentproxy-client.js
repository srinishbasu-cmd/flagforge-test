/* silentproxy-client.js - include this in the website to talk to the Silent Proxy extension.

   const st = await SilentProxy.detect();          // {extension, host, ...}
   const labs = await SilentProxy.list();
   const res = await SilentProxy.start('mission-1-recon', { onProgress: p => console.log(p.stage, p.message) });
   await SilentProxy.stop('mission-1-recon');

   Every call resolves with the launcher's `data` or rejects with a SilentProxyError (code, message, hint). */
(function (root) {
  'use strict';
  const NS = 'silentproxy.v1';
  const pending = new Map();
  let seq = 0;

  class SilentProxyError extends Error {
    constructor(err) {
      super(err && err.message ? err.message : 'Unknown error');
      this.name = 'SilentProxyError';
      this.code = (err && err.code) || 'UNKNOWN';
      this.hint = err && err.hint;
      this.details = err;
    }
  }

  root.addEventListener('message', (ev) => {
    if (ev.source !== root || ev.origin !== root.location.origin) return;
    const m = ev.data;
    if (!m || m.ns !== NS || m.dir !== 'from-ext') return;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') {
      if (p.onProgress) { try { p.onProgress(m); } catch (_e) { /* caller bug */ } }
    } else if (m.type === 'result') {
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.data); else p.reject(new SilentProxyError(m.error));
    }
  });

  function request(action, fields, opts) {
    opts = opts || {};
    const id = 'w' + Date.now().toString(36) + '-' + (++seq);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, onProgress: opts.onProgress };
      if (opts.timeoutMs) {
        entry.timer = setTimeout(() => {
          pending.delete(id);
          reject(new SilentProxyError({ code: 'EXT_NOT_RESPONDING', message: 'The extension did not respond.' }));
        }, opts.timeoutMs);
      }
      pending.set(id, entry);
      root.postMessage({ ns: NS, dir: 'to-ext', payload: Object.assign({ id, action }, fields) }, root.location.origin);
    });
  }

  root.SilentProxy = {
    SilentProxyError,
    request,
    /** Is the extension there, and is the launcher app installed? Never rejects. */
    async detect() {
      try {
        const data = await request('ping', {}, { timeoutMs: 2000 });
        return { extension: true, host: true, version: data.version, extensionVersion: data.extension && data.extension.version };
      } catch (e) {
        if (e.code === 'EXT_NOT_RESPONDING') return { extension: false, host: false };
        if (e.code === 'EXT_DISCONNECTED') return { extension: false, host: false, reload: true };
        return { extension: true, host: false, error: { code: e.code, message: e.message, hint: e.hint } };
      }
    },
    doctor: () => request('doctor', {}, { timeoutMs: 30000 }),
    list: () => request('list', {}, { timeoutMs: 30000 }),
    status: () => request('status', {}, { timeoutMs: 30000 }),
    /** Start a lab. Can take minutes the first time (download + image pulls), so there is no timeout. */
    start: (lab, o) => request('start', { lab, replace: !!(o && o.replace) }, { onProgress: o && o.onProgress }),
    stop: (lab) => request('stop', { lab }, { timeoutMs: 180000 }),
    stopAll: () => request('stop_all', {}, { timeoutMs: 180000 }),
    extend: (lab, hours) => request('extend', { lab, hours }, { timeoutMs: 30000 }),
  };
})(window);
