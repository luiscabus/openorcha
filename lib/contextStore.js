// What was open, and when.
//
// The work log reconstructs attention. Commits, transcripts and PR activity are
// all still there tomorrow, so any past day can be read whenever you get round
// to it. Open state is not like that: Jira answers "what is assigned to me now"
// and keeps no memory of what it would have said last Tuesday, and a branch
// that was waiting on you in August looks like any other merged branch today.
//
// So it is recorded as it is observed. A context's history starts the first
// time this file sees it and is only as fine-grained as the observations behind
// it — which is why every observation is logged too, and a point-in-time query
// reports the nearest one. "Nothing changed between the 3rd and the 9th" and
// "nobody looked between the 3rd and the 9th" must never read the same.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONTEXTS_DIR = process.env.OPENORCHA_CONTEXTS_DIR
  || path.join(__dirname, '..', 'data', 'contexts');

const RECORDS_DIR = () => path.join(CONTEXTS_DIR, 'records');
const OBSERVATIONS_FILE = () => path.join(CONTEXTS_DIR, 'observations.json');

// open   — something says this is yours and unfinished
// done   — something says it is finished, in as many words
// gone   — it stopped being reported by everything that could see it. Usually
//          finished, but it is not the same claim and must not be written as one.
const STATES = ['open', 'done', 'gone'];

// Jira owns a ticket's workflow; nothing else knows what "In Review" means.
// The rest are ranked by how specific their wording is about what is wanted
// from you.
const PROVIDER_RANK = { jira: 0, github: 1, initiatives: 2, git: 3 };

const DEFAULT_KEEP_OBSERVATIONS = 2000;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// A ticket key is already a safe filename. A label ("local 503 debugging") is
// not, and two different labels must not collide into one file, so the slug
// carries a hash of the key it came from.
function slugFor(key) {
  const value = String(key || '').trim();
  if (/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(value)) return value;
  const base = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const hash = crypto.createHash('sha1').update(value).digest('hex').slice(0, 8);
  return `${base || 'context'}-${hash}`;
}

function recordFile(key) {
  return path.join(RECORDS_DIR(), `${slugFor(key)}.json`);
}

function normalizeTransition(entry) {
  return {
    at: entry.at || new Date().toISOString(),
    state: STATES.includes(entry.state) ? entry.state : 'open',
    // The provider's own word for where it stands — "In Review", "changes
    // requested". Free text on purpose: it is quoted, never matched on.
    status: (entry.status || '').trim() || null,
    by: Array.isArray(entry.by) ? [...new Set(entry.by)].sort() : [],
    detail: (entry.detail || '').trim() || null,
  };
}

function normalizeRecord(raw, key) {
  const transitions = (Array.isArray(raw?.transitions) ? raw.transitions : [])
    .map(normalizeTransition)
    .sort((a, b) => new Date(a.at) - new Date(b.at));

  return {
    key: String(raw?.key || key || '').trim(),
    kind: raw?.kind === 'label' ? 'label' : 'ticket',
    title: (raw?.title || '').trim() || null,
    // What the thing itself is, as opposed to what moved on it. The work log
    // writes the same field per day and throws it away; here it is the one
    // durable copy.
    context: (raw?.context || '').trim() || null,
    url: raw?.url || null,
    repo: raw?.repo || null,
    // When the provider says the work itself started, where it knows — a Jira
    // created date, a branch's first commit. Distinct from firstSeen, which is
    // only when this machine first looked.
    startedAt: raw?.startedAt || null,
    firstSeen: raw?.firstSeen || transitions[0]?.at || null,
    lastSeen: raw?.lastSeen || transitions[transitions.length - 1]?.at || null,
    transitions,
  };
}

function readRecord(key) {
  try {
    return normalizeRecord(JSON.parse(fs.readFileSync(recordFile(key), 'utf8')), key);
  } catch {
    return null;
  }
}

function writeRecord(record) {
  ensureDir(RECORDS_DIR());
  const next = normalizeRecord(record);
  fs.writeFileSync(recordFile(next.key), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function listRecords() {
  let files = [];
  try {
    files = fs.readdirSync(RECORDS_DIR()).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const records = [];
  for (const file of files) {
    try {
      records.push(normalizeRecord(JSON.parse(fs.readFileSync(path.join(RECORDS_DIR(), file), 'utf8'))));
    } catch {
      // A record we cannot parse is one context missing from the board, not a
      // reason to lose the other forty.
    }
  }
  return records.sort((a, b) => a.key.localeCompare(b.key));
}

function forget(key) {
  try {
    fs.unlinkSync(recordFile(key));
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- point in time

// Where a context stood at a given instant, which is the last thing anything
// said about it at or before then. Null means it had not been seen yet — the
// honest answer, and not the same as closed.
function stateAt(record, instant) {
  const at = new Date(instant).getTime();
  let found = null;
  for (const transition of record?.transitions || []) {
    if (new Date(transition.at).getTime() > at) break;
    found = transition;
  }
  return found;
}

function wasOpenAt(record, instant) {
  return stateAt(record, instant)?.state === 'open';
}

function openAt(instant, records = listRecords()) {
  return records
    .map(record => ({ record, at: stateAt(record, instant) }))
    .filter(entry => entry.at?.state === 'open')
    .map(entry => ({ ...entry.record, current: entry.at }));
}

// --------------------------------------------------------------- observations

function readObservations() {
  try {
    const parsed = JSON.parse(fs.readFileSync(OBSERVATIONS_FILE(), 'utf8'));
    return Array.isArray(parsed?.observations) ? parsed.observations : [];
  } catch {
    return [];
  }
}

function writeObservations(observations, keep = DEFAULT_KEEP_OBSERVATIONS) {
  ensureDir(CONTEXTS_DIR);
  const trimmed = observations.slice(-Math.max(1, keep));
  fs.writeFileSync(OBSERVATIONS_FILE(), JSON.stringify({ observations: trimmed }, null, 2), 'utf8');
  return trimmed;
}

function lastObservation() {
  const all = readObservations();
  return all[all.length - 1] || null;
}

// How much to trust a point-in-time answer. A question about a Tuesday whose
// nearest look was the following Friday gets an answer, and the distance to it.
function nearestObservation(instant) {
  const at = new Date(instant).getTime();
  const all = readObservations();
  let before = null;
  let after = null;

  for (const observation of all) {
    const when = new Date(observation.at).getTime();
    if (when <= at) before = observation;
    else { after = observation; break; }
  }

  const gap = ms => (ms === null ? null : Math.round(ms / 60000));
  return {
    before,
    after,
    minutesBefore: gap(before ? at - new Date(before.at).getTime() : null),
    minutesAfter: gap(after ? new Date(after.at).getTime() - at : null),
    // Nothing was ever recorded at or before this instant, so any list of what
    // was open then is a guess dressed as a record.
    covered: !!before,
  };
}

// ------------------------------------------------------------------ observing

// One key can be reported by several providers at once — Jira says "In Review",
// GitHub says the PR is waiting on you. They fold into one state, keeping the
// most authoritative wording and every provider's reason.
function fold(commitments) {
  const ranked = [...commitments].sort(
    (a, b) => (PROVIDER_RANK[a.provider] ?? 9) - (PROVIDER_RANK[b.provider] ?? 9),
  );
  const open = ranked.filter(c => c.state !== 'done');

  return normalizeTransition({
    state: open.length ? 'open' : 'done',
    status: (open.length ? open : ranked).find(c => c.status)?.status || null,
    by: ranked.map(c => c.provider),
    detail: ranked.map(c => c.detail).filter(Boolean).join(' · ').slice(0, 240),
  });
}

// Only a real change earns a line. Detail moves constantly — a review count, a
// commit ahead — and a transition per poll would bury the three moments a month
// that actually mattered.
function differs(previous, next) {
  if (!previous) return true;
  return previous.state !== next.state
    || previous.status !== next.status
    || previous.by.join(',') !== next.by.join(',');
}

function upsert(key, commitments, at) {
  const first = commitments[0] || {};
  const existing = readRecord(key);
  const folded = { ...fold(commitments), at };
  const record = normalizeRecord({
    ...(existing || {}),
    key,
    kind: first.kind || existing?.kind || 'ticket',
    // Providers learn titles and subjects late; never let a blank read erase
    // one we already have.
    title: first.title || existing?.title || null,
    context: first.context || existing?.context || null,
    url: first.url || existing?.url || null,
    repo: first.repo || existing?.repo || null,
    startedAt: existing?.startedAt || first.openedAt || null,
    firstSeen: existing?.firstSeen || at,
    lastSeen: at,
  }, key);

  const previous = record.transitions[record.transitions.length - 1] || null;
  const changed = differs(previous, folded);
  if (changed) record.transitions.push(folded);
  else record.transitions[record.transitions.length - 1] = { ...previous, detail: folded.detail };

  writeRecord(record);
  return { record, changed, from: previous, to: folded };
}

// A context that stops being reported has usually finished — but a provider
// that failed reports nothing either, and marking a day's whole backlog closed
// because Jira was down would corrupt the only copy of this history there is.
// So absence only counts when every provider that used to see it answered.
function closeMissing(seenKeys, providers, at) {
  const reported = new Set(providers || []);
  const changes = [];
  const unverified = [];

  for (const record of listRecords()) {
    if (seenKeys.has(record.key)) continue;
    const previous = record.transitions[record.transitions.length - 1];
    if (!previous || previous.state !== 'open') continue;

    const watchers = previous.by.length ? previous.by : ['jira'];
    if (!watchers.every(provider => reported.has(provider))) {
      unverified.push(record.key);
      continue;
    }

    record.transitions.push(normalizeTransition({
      at,
      state: 'gone',
      by: previous.by,
      detail: `No longer reported by ${watchers.join(', ')}`,
    }));
    writeRecord(record);
    changes.push({ key: record.key, from: previous, to: record.transitions[record.transitions.length - 1] });
  }

  return { changes, unverified };
}

// Records one look at the world. `providers` is who actually answered, which is
// what makes absence readable; `errors` is who could not, kept on the
// observation so a thin patch of history can explain itself later.
function observe({ commitments = [], providers = [], errors = [], at = new Date().toISOString(), keep } = {}) {
  ensureDir(RECORDS_DIR());

  const byKey = new Map();
  for (const commitment of commitments) {
    const key = String(commitment.key || '').trim();
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(commitment);
  }

  const changes = [];
  for (const [key, group] of byKey) {
    const result = upsert(key, group, at);
    if (result.changed) changes.push({ key, from: result.from, to: result.to });
  }

  const closed = closeMissing(new Set(byKey.keys()), providers, at);
  changes.push(...closed.changes);

  const observation = {
    at,
    providers: [...providers].sort(),
    errors: errors.map(e => ({ provider: e.provider || e.source || null, error: e.error || String(e) })),
    seen: byKey.size,
    changed: changes.length,
    // Open contexts this run could not confirm either way, because the only
    // provider that watches them did not answer.
    unverified: closed.unverified,
  };
  writeObservations([...readObservations(), observation], keep);

  return { observation, changes };
}

module.exports = {
  CONTEXTS_DIR,
  STATES,
  slugFor,
  recordFile,
  normalizeRecord,
  readRecord,
  writeRecord,
  listRecords,
  forget,
  stateAt,
  wasOpenAt,
  openAt,
  fold,
  observe,
  readObservations,
  writeObservations,
  lastObservation,
  nearestObservation,
};
