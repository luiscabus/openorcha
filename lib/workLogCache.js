// Durable cache of a day's collected evidence.
//
// Reading a day costs about a minute: git log across every checkout, a gh
// search plus a call per pull request, and every Claude transcript parsed. In
// memory that survives until the next nodemon restart, which is no time at
// all, so circling back to last Tuesday paid the minute again.
//
// What makes this cacheable is that a finished day cannot gain new evidence.
// Once a day is over its commits, sessions and reviews are fixed, so a past
// day is sealed and kept until something actually invalidates it: a config
// change that would produce different signals, or an explicit rescan.
//
// The cache holds raw signals, not assembled rows. Assembly is cheap and
// depends on things that change — your entries, Jira, the rounding settings —
// so those stay live while the expensive half is reused.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const config = require('./workLogConfig');
const time = require('./workLogTime');
const sources = require('./workLogSources');
const narrate = require('./workLogNarrate');

const CACHE_DIR = path.join(config.WORKLOG_DIR, 'cache');

// Today is still being written, so it is re-read often.
const TODAY_TTL_MS = 2 * 60 * 1000;
// A read where a source failed is incomplete. Retry it soon rather than
// sealing a half-empty day for good.
const PARTIAL_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_DAYS = 400;

// Bump when a collector starts producing different signals for the same day.
// Config changes invalidate themselves through the fingerprint; a code change
// cannot, so without this a stale read would be kept forever on the strength
// of settings that never moved.
// 5: the sessions source stopped counting this tool's own claude runs as work.
// 6: the sessions source stopped counting stretches of a transcript nobody spoke in.
const COLLECTOR_VERSION = 6;

// Describing a day costs a model call. A week's worth run back to back takes
// minutes, and they do not depend on each other — so run a few at once, with a
// cap so a long span cannot spawn a process per day.
const NARRATE_CONCURRENCY = 4;

// Only the settings that change what gets collected. Rounding, the day target
// and the idle gap all affect assembly instead, so changing them must not
// throw away a minute of work per day. The idle gap also decides which
// unspoken stretches of a transcript are dropped, but a cached day keeping the
// gap it was read with only moves stretches nobody spoke in.
function fingerprint(cfg) {
  const relevant = {
    collector: COLLECTOR_VERSION,
    sources: cfg.sources,
    repos: config.activeRepos(cfg),
    authors: config.activeAuthors(cfg),
    ticketPattern: cfg.ticketPattern,
    projectKeys: cfg.projectKeys,
    resolvePrLinks: cfg.resolvePrLinks,
    narrate: cfg.narrate,
    narrateModel: cfg.narrateModel,
    attentionKinds: cfg.attentionKinds,
    githubPrLimit: cfg.githubPrLimit,
    // The day a signal is filed under is decided by this, so a change to it
    // reshuffles every cached day.
    workTimezone: cfg.workTimezone,
  };
  return crypto.createHash('sha1').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}

function cacheFile(dayKey) {
  return path.join(CACHE_DIR, `${dayKey}.json.gz`);
}

function ensureDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function readDay(dayKey) {
  try {
    const parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(cacheFile(dayKey))).toString('utf8'));
    if (!Array.isArray(parsed.signals)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDay(dayKey, entry) {
  ensureDir();
  const payload = {
    date: dayKey,
    fingerprint: entry.fingerprint,
    collectedAt: entry.collectedAt || new Date().toISOString(),
    errors: entry.errors || [],
    used: entry.used || [],
    signals: entry.signals || [],
    // What the model made of the day, keyed by candidate key. Sealed with the
    // evidence it describes, so a finished day is narrated exactly once.
    narration: entry.narration || null,
  };
  fs.writeFileSync(cacheFile(dayKey), zlib.gzipSync(JSON.stringify(payload), { level: 6 }));
  return payload;
}

// A cached day is usable when it was collected the same way, and either the
// day is finished or the read is recent enough.
function isFresh(entry, dayKey, cfg, nowKey = time.todayKey(cfg.workTimezone), now = Date.now()) {
  if (!entry) return false;
  if (entry.fingerprint !== fingerprint(cfg)) return false;

  const age = now - new Date(entry.collectedAt).getTime();
  if (!Number.isFinite(age) || age < 0) return false;

  if (entry.errors && entry.errors.length) return age < PARTIAL_TTL_MS;
  // Today and anything ahead of it are still moving.
  if (dayKey >= nowKey) return age < TODAY_TTL_MS;
  return true;
}

// A finished day read under different settings or an older collector. Its
// evidence is still what happened; what may differ is how much was picked up.
// Re-reading it costs the full minute — git, GitHub, every transcript and a
// model call — and a version bump or one settings tweak used to charge that
// for every past day at once. So it is served as is and marked, and only an
// explicit rescan reads it again.
function isOutdatedButUsable(entry, dayKey, cfg, nowKey = time.todayKey(cfg.workTimezone)) {
  if (!entry || dayKey >= nowKey) return false;
  if (entry.errors && entry.errors.length) return false;
  return entry.fingerprint !== fingerprint(cfg);
}

function listCached() {
  try {
    return fs.readdirSync(CACHE_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f))
      .map(f => f.replace(/\.json\.gz$/, ''))
      .sort();
  } catch {
    return [];
  }
}

function clearDays(dayKeys) {
  let removed = 0;
  for (const dayKey of dayKeys || []) {
    try {
      fs.rmSync(cacheFile(dayKey));
      removed++;
    } catch {
      // Nothing cached for that day.
    }
  }
  return removed;
}

function clearAll() {
  return clearDays(listCached());
}

// Old days are the point of this cache, so pruning is a backstop against
// unbounded growth rather than an expiry policy. At roughly 5KB a day it takes
// years to matter.
function prune(maxDays = DEFAULT_MAX_DAYS) {
  const cached = listCached();
  if (cached.length <= maxDays) return 0;
  return clearDays(cached.slice(0, cached.length - maxDays));
}

function stats() {
  const cached = listCached();
  let bytes = 0;
  for (const dayKey of cached) {
    try { bytes += fs.statSync(cacheFile(dayKey)).size; } catch { /* raced with a prune */ }
  }
  return { days: cached.length, bytes, oldest: cached[0] || null, newest: cached[cached.length - 1] || null };
}

// Turns one day's raw signals into the model's description of them. Required
// lazily: workLogDetect reads the store, and requiring it at module load would
// make this module's own dependents circular.
async function narrateSignals(dayKey, signals, cfg) {
  if (cfg.narrate === false || !signals.length) return null;
  const detect = require('./workLogDetect');

  const candidates = detect
    .buildCandidates(signals, cfg)
    .filter(candidate => candidate.date === dayKey);
  if (!candidates.length) return null;

  const result = await narrate.narrateDay({ dayKey, candidates, cfg });
  return {
    byKey: result.byKey,
    model: result.model || null,
    error: result.error || null,
    skipped: result.skipped || null,
  };
}

// Runs `fn` over items with a bounded number in flight, preserving order.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

// Signals for a set of days, collected only where the cache cannot answer.
//
// Missing days are fetched as one span rather than one call each: the GitHub
// source alone costs a search plus a call per pull request, and doing that
// seven times to fill a week would be absurd. Every day the span covers is
// then written, including the empty ones, so a quiet day is not re-read
// forever.
//
// `reuse` is for re-assembling a view after an edit: whatever read is cached
// is the one on screen, so it is used as is — even today's, which would
// otherwise cost the full minute again every couple of minutes. Only a day
// with no read at all is collected.
async function collectDays({ dayKeys, cfg = config.read(), refresh = false, reuse = false, now = Date.now() }) {
  const fp = fingerprint(cfg);
  const nowKey = time.todayKey(cfg.workTimezone);
  const wanted = [...new Set(dayKeys)].sort();

  const byDay = new Map();
  const cachedDays = [];
  const outdatedDays = [];
  const staleDays = [];

  for (const dayKey of wanted) {
    const entry = refresh ? null : readDay(dayKey);
    if (isFresh(entry, dayKey, cfg, nowKey, now)) {
      byDay.set(dayKey, entry);
      cachedDays.push(dayKey);
    } else if (reuse && entry) {
      byDay.set(dayKey, entry);
      cachedDays.push(dayKey);
      if (entry.fingerprint !== fp) outdatedDays.push(dayKey);
    } else if (!refresh && cfg.rereadOutdatedDays !== true && isOutdatedButUsable(entry, dayKey, cfg, nowKey)) {
      byDay.set(dayKey, entry);
      cachedDays.push(dayKey);
      outdatedDays.push(dayKey);
    } else {
      staleDays.push(dayKey);
    }
  }

  let errors = [];
  let used = [];

  if (staleDays.length) {
    const { from, to } = time.dayRange(staleDays[0], staleDays[staleDays.length - 1], cfg.workTimezone);
    const collected = await sources.collectAll({ from, to, cfg });
    errors = collected.errors;
    used = collected.used;

    const grouped = new Map();
    for (const signal of collected.signals) {
      const dayKey = time.dayKey(signal.at, cfg.workTimezone);
      if (!grouped.has(dayKey)) grouped.set(dayKey, []);
      grouped.get(dayKey).push(signal);
    }

    // Everything the span touched, so days that happened to be quiet are
    // recorded as read rather than left looking uncollected.
    const spanDays = new Set(staleDays);
    for (const dayKey of grouped.keys()) spanDays.add(dayKey);

    const collectedAt = new Date(now).toISOString();
    const dayList = [...spanDays];

    // Narration is part of reading a day, so it is sealed alongside the
    // evidence rather than re-run every time the day is opened.
    const narrations = await mapWithConcurrency(
      dayList,
      NARRATE_CONCURRENCY,
      dayKey => narrateSignals(dayKey, grouped.get(dayKey) || [], cfg),
    );

    dayList.forEach((dayKey, index) => {
      const entry = writeDay(dayKey, {
        fingerprint: fp,
        collectedAt,
        errors,
        used,
        signals: grouped.get(dayKey) || [],
        narration: narrations[index],
      });
      if (wanted.includes(dayKey)) byDay.set(dayKey, entry);
    });

    prune(cfg.cacheMaxDays || DEFAULT_MAX_DAYS);
  }

  return {
    byDay,
    meta: {
      fromCache: cachedDays,
      // Served from cache although read with older settings; Rescan updates.
      outdated: outdatedDays,
      collected: staleDays,
      errors,
      used: used.length ? used : [...new Set(cachedDays.flatMap(d => byDay.get(d)?.used || []))],
      narrationErrors: wanted
        .map(d => byDay.get(d)?.narration?.error)
        .filter(Boolean),
      // The oldest read backing this view, so the UI can say how stale it is.
      collectedAt: wanted
        .map(d => byDay.get(d)?.collectedAt)
        .filter(Boolean)
        .sort()[0] || null,
    },
  };
}

module.exports = {
  CACHE_DIR,
  COLLECTOR_VERSION,
  NARRATE_CONCURRENCY,
  mapWithConcurrency,
  TODAY_TTL_MS,
  PARTIAL_TTL_MS,
  DEFAULT_MAX_DAYS,
  fingerprint,
  cacheFile,
  readDay,
  writeDay,
  isFresh,
  isOutdatedButUsable,
  listCached,
  clearDays,
  clearAll,
  prune,
  stats,
  collectDays,
};
