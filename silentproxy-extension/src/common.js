/* Shared by the background, content script and popup. No browser APIs in here. */
(function (root) {
  'use strict';

  const SP = {
    NS: 'silentproxy.v1',
    HOST_NAME: 'com.operationsilentproxy.launcher',
    LAB_ID: /^[a-z0-9][a-z0-9-]{1,47}$/,
    REQUEST_ID: /^[A-Za-z0-9_.:-]{1,64}$/,
    // action -> the only extra fields that may be forwarded to the launcher
    FIELDS: {
      ping: [], doctor: [], list: [], status: [], stop_all: [],
      start: ['lab', 'replace'], stop: ['lab'], extend: ['lab', 'hours'],
    },

    errorResult(id, code, message, hint, extra) {
      const error = Object.assign({ code, message }, hint ? { hint } : {}, extra || {});
      return { id: id == null ? null : id, type: 'result', ok: false, error };
    },

    /** Returns {ok:true, request} with only whitelisted, validated fields, or {ok:false, error}. */
    validateRequest(msg) {
      const bad = (m) => ({ ok: false, error: { code: 'BAD_REQUEST', message: m } });
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return bad('Request must be an object.');
      if (typeof msg.id !== 'string' || !SP.REQUEST_ID.test(msg.id)) return bad('Invalid request id.');
      const action = msg.action;
      if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(SP.FIELDS, action)) {
        return bad('Unknown action.');
      }
      const req = { id: msg.id, action };
      if (SP.FIELDS[action].includes('lab')) {
        if (typeof msg.lab !== 'string' || !SP.LAB_ID.test(msg.lab)) return bad('Invalid lab id.');
        req.lab = msg.lab;
      }
      if (action === 'start' && msg.replace !== undefined) {
        if (typeof msg.replace !== 'boolean') return bad('replace must be a boolean.');
        req.replace = msg.replace;
      }
      if (action === 'extend') {
        if (typeof msg.hours !== 'number' || !Number.isFinite(msg.hours) || msg.hours < 0.25 || msg.hours > 12) {
          return bad('hours must be a number between 0.25 and 12.');
        }
        req.hours = msg.hours;
      }
      return { ok: true, request: req };
    },

    /** Turn a native-messaging disconnect message into an error the UI can explain. */
    mapDisconnect(message, extensionId) {
      const m = String(message || '');
      if (/not found|no such native application|not registered/i.test(m)) {
        return {
          code: 'HOST_NOT_INSTALLED',
          message: 'The Silent Proxy launcher app is not installed.',
          hint: 'Download the launcher, then run: silentproxy install' +
            (extensionId ? ' --chrome-id ' + extensionId : '') + ' (Firefox needs no ID).',
        };
      }
      if (/forbidden|not allowed|access to the specified native messaging host/i.test(m)) {
        return {
          code: 'HOST_FORBIDDEN',
          message: 'The launcher does not trust this extension.',
          hint: 'Re-run: silentproxy install --chrome-id ' + (extensionId || '<extension id>'),
          extension_id: extensionId,
        };
      }
      if (/exited|terminated|crash/i.test(m)) {
        return { code: 'HOST_CRASHED', message: 'The launcher app stopped unexpectedly.',
                 hint: 'Check its log file (launcher.log in the SilentProxy data folder) and retry.' };
      }
      return { code: 'HOST_DISCONNECTED', message: 'Lost connection to the launcher app.' +
               (m ? ' (' + m + ')' : ''), hint: 'Retry. If it keeps happening, run: silentproxy doctor' };
    },
  };

  root.SP = SP;
})(typeof globalThis !== 'undefined' ? globalThis : self);
