const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-worklog-cache-'));
process.env.OPENORCHA_WORKLOG_DIR = TMP;

const cache = require('../lib/workLogCache');

// Every source must be named explicitly: an absent key falls back to that
// source's own default, which would set real collection running mid-test.
const ALL_OFF = {
  git: false, sessions: false, github: false, jira: false, initiatives: false,
  reflog: false, calendar: false, slack: false, shell: false,
};

const cfg = {
  // Never let the suite spawn a real model.
  narrate: false,
  workTimezone: 'America/Chicago',
  sources: { ...ALL_OFF },
  repos: ['/tmp/does-not-matter'],
  gitAuthors: ['me@example.com'],
  ticketPattern: '\\b[A-Z]{2,10}-\\d+\\b',
  projectKeys: [],
  resolvePrLinks: true,
};

function seed(dayKey, { fingerprint = cache.fingerprint(cfg), collectedAt = new Date().toISOString(), errors = [], signals = [] } = {}) {
  return cache.writeDay(dayKey, { fingerprint, collectedAt, errors, signals, used: ['git'] });
}

test.afterEach(() => {
  fs.rmSync(cache.CACHE_DIR, { recursive: true, force: true });
});

test('a written day round-trips through gzip', () => {
  const signals = [{ source: 'git', at: '2026-08-13T17:00:00Z', ticket: 'SO-1', text: 'did a thing', ref: 'soci@abc' }];
  seed('2026-08-13', { signals });

  const read = cache.readDay('2026-08-13');
  assert.deepEqual(read.signals, signals);
  assert.equal(read.date, '2026-08-13');
});

test('a day never collected reads as nothing rather than throwing', () => {
  assert.equal(cache.readDay('1999-01-01'), null);
});

test('the cache survives a restart, because it is on disk', () => {
  seed('2026-08-13', { signals: [{ source: 'git', at: '2026-08-13T17:00:00Z' }] });
  delete require.cache[require.resolve('../lib/workLogCache')];
  const reloaded = require('../lib/workLogCache');
  assert.equal(reloaded.readDay('2026-08-13').signals.length, 1);
});

test('a finished day stays fresh no matter how old the read is', () => {
  const ancient = new Date('2026-08-14T00:00:00Z').toISOString();
  const entry = seed('2026-08-13', { collectedAt: ancient });
  const now = new Date('2026-12-25T00:00:00Z').getTime();
  assert.equal(cache.isFresh(entry, '2026-08-13', cfg, '2026-12-25', now), true);
});

test('today goes stale quickly, because it is still being written', () => {
  const now = Date.now();
  const entry = seed('2026-09-09', { collectedAt: new Date(now - 30 * 1000).toISOString() });
  assert.equal(cache.isFresh(entry, '2026-09-09', cfg, '2026-09-09', now), true);

  const older = seed('2026-09-09', { collectedAt: new Date(now - 10 * 60 * 1000).toISOString() });
  assert.equal(cache.isFresh(older, '2026-09-09', cfg, '2026-09-09', now), false);
});

test('a read where a source failed is retried instead of sealed', () => {
  const now = Date.now();
  const partial = seed('2026-08-13', {
    collectedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    errors: [{ source: 'github', error: 'gh exploded' }],
  });
  assert.equal(cache.isFresh(partial, '2026-08-13', cfg, '2026-09-09', now), false);

  const recentPartial = seed('2026-08-13', {
    collectedAt: new Date(now - 60 * 1000).toISOString(),
    errors: [{ source: 'github', error: 'gh exploded' }],
  });
  assert.equal(cache.isFresh(recentPartial, '2026-08-13', cfg, '2026-09-09', now), true);
});

test('a config change that alters collection invalidates the cache', () => {
  const entry = seed('2026-08-13');
  assert.equal(cache.isFresh(entry, '2026-08-13', cfg, '2026-09-09'), true);

  const different = { ...cfg, projectKeys: ['SO'] };
  assert.equal(cache.isFresh(entry, '2026-08-13', different, '2026-09-09'), false);
});

test('independent days are described concurrently, in order', async () => {
  // A week narrated one day at a time takes minutes; the calls do not depend
  // on each other, so they overlap — but the results must still line up with
  // the days that produced them.
  let inFlight = 0;
  let peak = 0;
  const order = await cache.mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 4, async n => {
    peak = Math.max(peak, ++inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    return n * 10;
  });

  assert.deepEqual(order, [10, 20, 30, 40, 50, 60, 70]);
  assert.ok(peak > 1, 'calls should overlap');
  assert.ok(peak <= 4, `at most 4 in flight, saw ${peak}`);
});

test('a description is sealed with the evidence it describes', () => {
  const narration = { byKey: { '2026-08-13|SO-1': { label: 'SO-1', kind: 'coding', summary: 'Built it.', note: 'Implementation.' } } };
  cache.writeDay('2026-08-13', { fingerprint: cache.fingerprint(cfg), signals: [], narration });

  const read = cache.readDay('2026-08-13');
  assert.deepEqual(read.narration, narration);
});

test('turning descriptions on or off invalidates the cached day', () => {
  // Narration is part of the read, so the setting belongs in the fingerprint.
  const entry = seed('2026-08-13');
  assert.equal(cache.isFresh(entry, '2026-08-13', cfg, '2026-09-09'), true);
  assert.equal(cache.isFresh(entry, '2026-08-13', { ...cfg, narrate: true }, '2026-09-09'), false);
});

test('a new collector version invalidates every cached day', () => {
  const entry = seed('2026-08-13');
  assert.equal(cache.isFresh(entry, '2026-08-13', cfg, '2026-09-09'), true);
  // A collector that starts producing different signals must not be served
  // stale reads just because the settings did not move.
  assert.notEqual(cache.fingerprint(cfg), 'fingerprint-from-another-version');
  const older = { ...entry, fingerprint: 'fingerprint-from-another-version' };
  assert.equal(cache.isFresh(older, '2026-08-13', cfg, '2026-09-09'), false);
});

test('a config change that only affects assembly keeps the cache', () => {
  const entry = seed('2026-08-13');
  // Rounding, the day target and the idle gap are applied after collection, so
  // changing them must not cost a minute of re-reading per day.
  const tweaked = { ...cfg, roundToMinutes: 30, dayMinutes: 480, idleGapMinutes: 45 };
  assert.equal(cache.isFresh(entry, '2026-08-13', tweaked, '2026-09-09'), true);
});

test('clearing removes only the days asked for', () => {
  seed('2026-08-13');
  seed('2026-08-14');
  assert.equal(cache.clearDays(['2026-08-13']), 1);
  assert.deepEqual(cache.listCached(), ['2026-08-14']);
});

test('pruning keeps the newest days and drops the excess', () => {
  for (const day of ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']) seed(day);
  assert.equal(cache.prune(2), 2);
  assert.deepEqual(cache.listCached(), ['2026-08-13', '2026-08-14']);
});

test('stats report what is being kept', () => {
  seed('2026-08-13', { signals: [{ source: 'git', at: '2026-08-13T17:00:00Z' }] });
  seed('2026-08-14');
  const info = cache.stats();
  assert.equal(info.days, 2);
  assert.equal(info.oldest, '2026-08-13');
  assert.equal(info.newest, '2026-08-14');
  assert.ok(info.bytes > 0);
});

test('collectDays serves cached days without collecting anything', async () => {
  seed('2026-08-13', { signals: [{ source: 'git', at: '2026-08-13T17:00:00Z', ticket: 'SO-1' }] });

  const result = await cache.collectDays({ dayKeys: ['2026-08-13'], cfg, now: Date.now() });
  assert.deepEqual(result.meta.fromCache, ['2026-08-13']);
  assert.deepEqual(result.meta.collected, []);
  assert.equal(result.byDay.get('2026-08-13').signals.length, 1);
});

test('refresh ignores a perfectly good cache entry when you insist', async () => {
  seed('2026-08-13', { signals: [{ source: 'git', at: '2026-08-13T17:00:00Z' }] });
  // Every source is off, so collection yields nothing and the entry is rewritten empty.
  const quiet = { ...cfg, sources: { ...ALL_OFF } };
  const result = await cache.collectDays({ dayKeys: ['2026-08-13'], cfg: quiet, refresh: true });
  assert.deepEqual(result.meta.collected, ['2026-08-13']);
  assert.equal(result.byDay.get('2026-08-13').signals.length, 0);
});

test('reuse keeps today\'s read even once it has gone stale', async () => {
  const quiet = { ...cfg, sources: { ...ALL_OFF } };
  const today = require('../lib/workLogTime').todayKey(quiet.workTimezone);
  const stale = new Date(Date.now() - cache.TODAY_TTL_MS * 5).toISOString();
  seed(today, { fingerprint: cache.fingerprint(quiet), collectedAt: stale, signals: [{ source: 'git', at: new Date().toISOString() }] });

  const result = await cache.collectDays({ dayKeys: [today], cfg: quiet, reuse: true });
  assert.deepEqual(result.meta.collected, []);
  assert.deepEqual(result.meta.fromCache, [today]);
  assert.equal(result.byDay.get(today).signals.length, 1);
});

test('reuse still collects a day that was never read', async () => {
  const quiet = { ...cfg, sources: { ...ALL_OFF } };
  const result = await cache.collectDays({ dayKeys: ['2026-08-13'], cfg: quiet, reuse: true });
  assert.deepEqual(result.meta.collected, ['2026-08-13']);
});

test('a quiet day is recorded as read so it is not collected forever', async () => {
  const quiet = { ...cfg, sources: { ...ALL_OFF } };
  await cache.collectDays({ dayKeys: ['2026-08-13'], cfg: quiet });
  assert.deepEqual(cache.listCached(), ['2026-08-13']);

  const second = await cache.collectDays({ dayKeys: ['2026-08-13'], cfg: quiet });
  assert.deepEqual(second.meta.collected, []);
  assert.deepEqual(second.meta.fromCache, ['2026-08-13']);
});

test('a partly cached week collects only the days it is missing', async () => {
  const quiet = { ...cfg, sources: { ...ALL_OFF } };
  const week = ['2026-08-10', '2026-08-11', '2026-08-12'];
  seed('2026-08-11', { fingerprint: cache.fingerprint(quiet) });

  const result = await cache.collectDays({ dayKeys: week, cfg: quiet });
  assert.deepEqual(result.meta.fromCache, ['2026-08-11']);
  assert.deepEqual(result.meta.collected, ['2026-08-10', '2026-08-12']);
  // Every requested day still comes back.
  assert.equal(result.byDay.size, 3);
});

test('a finished day read with older settings is served, not re-read', async () => {
  const quiet = { ...cfg, sources: { ...ALL_OFF } };
  seed('2026-08-11', { fingerprint: 'fingerprint-from-another-version' });

  const result = await cache.collectDays({ dayKeys: ['2026-08-11'], cfg: quiet });
  assert.deepEqual(result.meta.collected, []);
  assert.deepEqual(result.meta.outdated, ['2026-08-11']);
});

test('rescan still re-reads an outdated day', async () => {
  const quiet = { ...cfg, sources: { ...ALL_OFF } };
  seed('2026-08-11', { fingerprint: 'fingerprint-from-another-version' });

  const result = await cache.collectDays({ dayKeys: ['2026-08-11'], cfg: quiet, refresh: true });
  assert.deepEqual(result.meta.collected, ['2026-08-11']);
});

test('an outdated read with a failed source is not kept', () => {
  const entry = seed('2026-08-11', { fingerprint: 'old', errors: [{ source: 'github', error: 'x' }] });
  assert.equal(cache.isOutdatedButUsable(entry, '2026-08-11', cfg, '2026-09-09'), false);
});
