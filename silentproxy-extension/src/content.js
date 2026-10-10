/* Content script: relays messages between the Silent Proxy website and the background.
   It only runs on the site's own origin (see manifest matches) and exposes nothing but postMessage. */
(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const SP = globalThis.SP;
  let port = null;
  const pending = new Set(); // client ids awaiting a final result

  function toPage(obj) {
    window.postMessage(Object.assign({ ns: SP.NS, dir: 'from-ext' }, obj), window.location.origin);
  }

  function connect() {
    port = api.runtime.connect({ name: 'page-bridge' });
    port.onMessage.addListener((m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'result') pending.delete(m.id);
      toPage(m);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      for (const id of pending) {
        toPage(SP.errorResult(id, 'EXT_DISCONNECTED', 'The extension was reloaded or stopped.',
          'Reload this page and try again.'));
      }
      pending.clear();
    });
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.ns !== SP.NS || d.dir !== 'to-ext') return;
    const v = SP.validateRequest(d.payload);
    if (!v.ok) {
      const id = d.payload && typeof d.payload.id === 'string' ? d.payload.id : null;
      toPage(SP.errorResult(id, v.error.code, v.error.message));
      return;
    }
    try {
      if (!port) connect();
      pending.add(v.request.id);
      port.postMessage(v.request);
    } catch (_e) {
      pending.delete(v.request.id);
      port = null;
      toPage(SP.errorResult(v.request.id, 'EXT_DISCONNECTED', 'The extension was reloaded or stopped.',
        'Reload this page and try again.'));
    }
  });
})();
