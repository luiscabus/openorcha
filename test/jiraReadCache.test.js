const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.OPENORCHA_WORKLOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-jira-cache-'));

const cache = require('../lib/jiraReadCache');

test.beforeEach(() => cache.clear());

function counter(values) {
  let calls = 0;
  const loader = async () => values[Math.min(calls++, values.length - 1)];
  return { loader, calls: () => calls };
}

test('a fresh copy is served without asking Jira', async () => {
  const { loader, calls } = counter(['a']);
  assert.equal(await cache.read('k', { ttlMs: 60000, loader }), 'a');
  assert.equal(await cache.read('k', { ttlMs: 60000, loader }), 'a');
  assert.equal(calls(), 1);
});

test('a stale copy is served at once and refreshed for next time', async () => {
  const { loader, calls } = counter(['old', 'new']);
  await cache.read('k', { ttlMs: 1000, loader });
  // Read again as if five seconds had passed: past the TTL, so stale.
  assert.equal(await cache.read('k', { ttlMs: 1000, loader, now: Date.now() + 5000 }), 'old');
  await new Promise(r => setImmediate(r));
  assert.equal(calls(), 2);
  assert.equal(await cache.read('k', { ttlMs: 60000, loader }), 'new');
});

test('refresh waits on Jira', async () => {
  const { loader } = counter(['a', 'b']);
  await cache.read('k', { ttlMs: 60000, loader });
  assert.equal(await cache.read('k', { ttlMs: 60000, loader, refresh: true }), 'b');
});

test('a failed read is not cached', async () => {
  let fail = true;
  const loader = async () => { if (fail) throw new Error('down'); return 'ok'; };
  await assert.rejects(cache.read('k', { ttlMs: 60000, loader }));
  fail = false;
  assert.equal(await cache.read('k', { ttlMs: 60000, loader }), 'ok');
});

test('logging time drops every worklog span covering that day', async () => {
  const loader = async () => [];
  await cache.read('worklogs:2026-09-14:2026-09-20', { ttlMs: 60000, loader });
  await cache.read('worklogs:2026-09-17:2026-09-17', { ttlMs: 60000, loader });
  await cache.read('worklogs:2026-09-21:2026-09-21', { ttlMs: 60000, loader });
  await cache.read('issue:SO-1', { ttlMs: 60000, loader });
  assert.equal(cache.invalidateWorklogDay('2026-09-17'), 2);
});
