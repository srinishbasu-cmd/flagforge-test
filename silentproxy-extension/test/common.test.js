'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'common.js'), 'utf8'), ctx);
const SP = ctx.SP;
const plain = (o) => JSON.parse(JSON.stringify(o));

test('accepts well-formed requests and keeps only whitelisted fields', () => {
  assert.deepEqual(plain(SP.validateRequest({ id: 'a1', action: 'ping' }).request), { id: 'a1', action: 'ping' });
  const v = SP.validateRequest({ id: 'a2', action: 'start', lab: 'mission-1-recon', replace: true, cmd: 'rm -rf /', url: 'http://evil' });
  assert.deepEqual(plain(v.request), { id: 'a2', action: 'start', lab: 'mission-1-recon', replace: true });
  assert.deepEqual(plain(SP.validateRequest({ id: 'a3', action: 'extend', lab: 'abc', hours: 2 }).request),
    { id: 'a3', action: 'extend', lab: 'abc', hours: 2 });
});

test('rejects malformed requests', () => {
  const bad = [
    null, 'x', [], {}, { id: 'a' }, { id: 'a', action: 'rm' }, { id: 'a', action: '__proto__' },
    { id: 'a', action: 'constructor' }, { id: '', action: 'ping' }, { id: 'x'.repeat(65), action: 'ping' },
    { id: 'a b', action: 'ping' }, { id: 5, action: 'ping' },
    { id: 'a', action: 'start' }, { id: 'a', action: 'start', lab: '../../etc' }, { id: 'a', action: 'start', lab: 'UPPER' },
    { id: 'a', action: 'start', lab: 'ok-lab', replace: 'yes' }, { id: 'a', action: 'stop', lab: 5 },
    { id: 'a', action: 'extend', lab: 'ok-lab', hours: 99 }, { id: 'a', action: 'extend', lab: 'ok-lab', hours: '2' },
    { id: 'a', action: 'extend', lab: 'ok-lab', hours: NaN }, { id: 'a', action: 'extend', lab: 'ok-lab', hours: 0 },
  ];
  for (const b of bad) assert.equal(SP.validateRequest(b).ok, false, JSON.stringify(b));
});

test('disconnect messages map to actionable errors (Chrome and Firefox wording)', () => {
  for (const m of ['Specified native messaging host not found.', 'No such native application com.x']) {
    assert.equal(SP.mapDisconnect(m, 'abc').code, 'HOST_NOT_INSTALLED');
  }
  assert.match(SP.mapDisconnect('Specified native messaging host not found.', 'abcdef').hint, /--chrome-id abcdef/);
  assert.equal(SP.mapDisconnect('Access to the specified native messaging host is forbidden.', 'abc').code, 'HOST_FORBIDDEN');
  assert.equal(SP.mapDisconnect('Native host has exited.', 'abc').code, 'HOST_CRASHED');
  assert.equal(SP.mapDisconnect('', 'abc').code, 'HOST_DISCONNECTED');
});
