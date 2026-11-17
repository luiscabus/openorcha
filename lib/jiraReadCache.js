// Durable cache of what the work log reads from Jira.
//
// The day cache made evidence free to re-read, but every view still asked Jira
// for your worklogs and every ticket's title and status — a search plus a call
// per ticket, a couple of seconds even for a finished day. That is remote
// state, so unlike evidence it cannot be sealed; but it moves slowly, and a
// view does not need it to the second.
//
// So reads are served stale-while-revalidate: a copy younger than its TTL is
// used as is; an older one is still used, and refreshed in the background for
// the next view. Only a key never read before waits on Jira. The one change
// that must show at once — time you just logged — invalidates its day
// explicitly, and Rescan bypasses the cache entirely.

const fs = require('fs');
const path = require('path');

const { WORKLOG_DIR } = require('./workLogConfig');

const FILE = path.join(WORKLOG_DIR, 'cache', 'jira.json');

// Past a week, a copy is too old to show even while refreshing.
const MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;

let entries = null;
let writeTimer = null;
const inFlight = new Map();

function load() {
  if (entries) return entries;
  try {
    entries = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
  } catch {
    entries = {};
  }
  return entries;
}

// Batched: a view can settle a dozen keys at once.
function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(entries));
    } catch {
      // A cache that cannot be written only costs the next view a fetch.
    }
  }, 200);
  writeTimer.unref?.();
}

function fetchInto(key, loader) {
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = Promise.resolve()
    .then(loader)
    .then(value => {
      load()[key] = { value, at: Date.now() };
      persist();
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/**
 * The cached value for `key`, fetching only when there is nothing usable.
 * `refresh` forces a wait on Jira; a stale hit returns at once and refreshes
 * behind the caller. Background failures are swallowed — the stale copy stands.
 */
async function read(key, { ttlMs, loader, refresh = false, now = Date.now() }) {
  const hit = load()[key];
  const age = hit ? now - hit.at : Infinity;

  if (!refresh && hit && age < ttlMs) return hit.value;
  if (!refresh && hit && age < MAX_STALE_MS) {
    fetchInto(key, loader).catch(() => {});
    return hit.value;
  }
  return fetchInto(key, loader);
}

function invalidate(predicate) {
  const all = load();
  let removed = 0;
  for (const key of Object.keys(all)) {
    if (predicate(key)) {
      delete all[key];
      removed++;
    }
  }
  if (removed) persist();
  return removed;
}

// Worklog reads are keyed by span, so a day is dropped from every span
// that covers it — the day view and its week alike.
function invalidateWorklogDay(dayKey) {
  return invalidate(key => {
    const match = key.match(/^worklogs:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/);
    return match && match[1] <= dayKey && dayKey <= match[2];
  });
}

function clear() {
  entries = {};
  persist();
}

module.exports = { FILE, MAX_STALE_MS, read, invalidate, invalidateWorklogDay, clear };
