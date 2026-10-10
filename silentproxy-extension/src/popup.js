(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const SP = globalThis.SP;
  const $ = (id) => document.getElementById(id);

  // ---- tiny helpers (textContent only: nothing from the launcher is ever parsed as HTML) ----
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };

  // ---- connection to the background ----
  let port = null;
  const pending = new Map();
  let seq = 0;
  function connect() {
    port = api.runtime.connect({ name: 'popup' });
    port.onMessage.addListener((m) => {
      const p = pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') { if (p.onProgress) p.onProgress(m); return; }
      pending.delete(m.id);
      p.resolve(m);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      for (const [id, p] of pending) p.resolve(SP.errorResult(id, 'EXT_DISCONNECTED', 'Extension background stopped.', 'Reopen this popup.'));
      pending.clear();
    });
  }
  function call(action, fields, onProgress) {
    if (!port) connect();
    const id = 'p' + (++seq);
    return new Promise((resolve) => {
      pending.set(id, { resolve, onProgress });
      port.postMessage(Object.assign({ id, action }, fields || {}));
    });
  }

  // ---- state ----
  let running = [];          // from status
  let labs = [];             // from list
  let tickTimer = null;
  let starting = 0;          // a start can take minutes; don't re-render the cards under it

  const fmt = (secs) => { const m = Math.max(0, Math.floor(secs / 60)); return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
  const openUrl = (url) => {
    try { const u = new URL(url); if (u.protocol === 'http:' || u.protocol === 'https:') api.tabs.create({ url: u.href }); } catch (_e) { /* ignore */ }
  };

  function showAlert(err, warn) {
    const box = $('alert');
    clear(box);
    box.hidden = !err;
    if (!err) return;
    box.append(h('div', { class: 'card alert' + (warn ? ' warn' : '') },
      h('h3', {}, err.message || 'Something went wrong'),
      err.hint ? h('div', { class: 'muted' }, err.hint) : null,
      err.code === 'HOST_NOT_INSTALLED' || err.code === 'HOST_FORBIDDEN'
        ? h('div', { class: 'row' }, 'Extension ID: ', h('code', {}, api.runtime.id)) : null));
  }

  function renderRunning() {
    const box = $('running-list');
    clear(box);
    $('running').hidden = running.length === 0;
    for (const lab of running) {
      const meta = labs.find((l) => l.id === lab.lab);
      const left = h('span', { class: 'muted', 'data-expires': Date.now() + lab.expires_in * 1000 }, 'time left ' + fmt(lab.expires_in));
      box.append(h('div', { class: 'card' },
        h('h3', {}, meta ? meta.title : lab.lab),
        h('div', { class: 'muted' }, lab.status, (lab.services || []).length ? ' · ' + lab.services.map((s) => s.service + ': ' + s.state).join(', ') : '', ' · ', left),
        h('div', { class: 'row' },
          (lab.urls || []).map((u) => h('a', { class: 'link', onclick: () => openUrl(u.url), title: u.url }, u.name)),
        ),
        h('div', { class: 'row' },
          h('button', { onclick: async (e) => { e.target.disabled = true; await call('extend', { lab: lab.lab, hours: 1 }); refresh(); } }, '+1 hour'),
          h('button', { class: 'primary', onclick: async (e) => { e.target.disabled = true; e.target.textContent = 'Stopping…'; const r = await call('stop', { lab: lab.lab }); if (!r.ok) showAlert(r.error); refresh(); } }, 'Stop lab'))));
    }
  }

  function renderLabs() {
    const box = $('labs-list');
    clear(box);
    $('labs').hidden = labs.length === 0;
    const runningIds = new Set(running.map((r) => r.lab));
    for (const lab of labs) {
      const prog = h('div', { class: 'progress', hidden: true });
      const btn = h('button', { class: 'primary', disabled: runningIds.has(lab.id) }, runningIds.has(lab.id) ? 'Running' : 'Start');
      btn.addEventListener('click', () => startLab(lab, btn, prog, false));
      box.append(h('div', { class: 'card' },
        h('h3', {}, lab.title), lab.summary ? h('div', { class: 'muted' }, lab.summary) : null,
        h('div', { class: 'row' }, btn, h('span', { class: 'muted' }, lab.installed ? 'downloaded' : Math.round(lab.size / 1e5) / 10 + ' MB download')), prog));
    }
  }

  async function startLab(lab, btn, prog, replace) {
    btn.disabled = true; btn.textContent = 'Starting…'; prog.hidden = false; showAlert(null);
    starting += 1;
    const r = await call('start', { lab: lab.id, replace }, (p) => { prog.textContent = p.message + (p.percent != null ? ' ' + p.percent + '%' : ''); });
    starting -= 1;
    if (!r.ok && r.error.code === 'OTHER_LAB_RUNNING' && !replace) {
      if (confirm('Another lab is running (' + (r.error.running || []).join(', ') + '). Stop it and start "' + lab.title + '"?')) {
        return startLab(lab, btn, prog, true);
      }
    } else if (!r.ok) {
      showAlert(r.error);
    }
    refresh();
  }

  async function refresh() {
    const [st, ls] = await Promise.all([call('status'), call('list')]);
    if (st.ok) running = st.data.labs; if (ls.ok) labs = ls.data.labs;
    if (!ls.ok && !$('alert').firstChild) showAlert(ls.error, true);
    renderRunning(); renderLabs();
  }

  function tick() {
    document.querySelectorAll('[data-expires]').forEach((el) => {
      el.textContent = 'time left ' + fmt((Number(el.dataset.expires) - Date.now()) / 1000);
    });
  }

  async function init() {
    const ping = await call('ping');
    const pill = $('host-pill');
    if (!ping.ok) {
      pill.textContent = 'launcher missing'; pill.className = 'pill bad';
      showAlert(ping.error);
      return;
    }
    pill.textContent = 'launcher v' + ping.data.version; pill.className = 'pill ok';
    $('footer').textContent = 'extension v' + api.runtime.getManifest().version;
    const doc = await call('doctor');
    if (doc.ok && !(doc.data.daemon_running && doc.data.compose_ok)) showAlert(doc.data.error, true);
    await refresh();
    tickTimer = setInterval(tick, 1000);
    setInterval(() => { if (!starting) refresh(); }, 15000);
  }
  init();
})();
