// Durable work log entries, one file per day.
//
// A day file holds the entries you have accepted — detected candidates you
// kept plus anything you typed yourself. Detection is re-run freely and never
// overwrites a day: a candidate you already dealt with stays dealt with, and
// one you edited keeps your edit.
//
// A day is read in layers, and no layer overwrites the one beneath it:
//
//   evidence   — the raw signals, sealed in workLogCache
//   suggested  — what the model made of them, sealed with the evidence
//   chosen     — the entries here. Each keeps `original`, the text it was
//                accepted with, so an edit is always a change *to* something
//   posted     — the EOD text you actually sent, kept beside the one this
//                tool generated rather than in place of it

const fs = require('fs');
const path = require('path');
const { WORKLOG_DIR } = require('./workLogConfig');

const PUSH_STATES = ['unpushed', 'pushed', 'stale', 'failed'];

function dayFile(dayKey) {
  return path.join(WORKLOG_DIR, `${dayKey}.json`);
}

function ensureDir() {
  fs.mkdirSync(WORKLOG_DIR, { recursive: true });
}

function newId() {
  return `wl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// The text fields a person rewrites. `original` snapshots exactly these.
const TEXT_FIELDS = ['label', 'title', 'status', 'context', 'eod', 'summary', 'note', 'attention'];

function emptyDay(dayKey) {
  return { date: dayKey, entries: [], dismissed: [], eod: null, eodHistory: [], updatedAt: null };
}

function readDay(dayKey) {
  try {
    const parsed = JSON.parse(fs.readFileSync(dayFile(dayKey), 'utf8'));
    return {
      date: parsed.date || dayKey,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed : [],
      eod: normalizeEod(parsed.eod),
      // Posts you cleared, so going back to the generated text loses nothing.
      eodHistory: Array.isArray(parsed.eodHistory) ? parsed.eodHistory : [],
      updatedAt: parsed.updatedAt || null,
    };
  } catch {
    return emptyDay(dayKey);
  }
}

function writeDay(day) {
  ensureDir();
  const next = { ...day, updatedAt: new Date().toISOString() };
  fs.writeFileSync(dayFile(next.date), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function normalizeEntry(entry, dayKey) {
  const minutes = Math.max(0, Math.round(Number(entry.minutes) || 0));
  return {
    id: entry.id || newId(),
    date: entry.date || dayKey,
    ticket: (entry.ticket || '').trim().toUpperCase() || null,
    // The context this time belongs to: the ticket, or a name for work that
    // has none.
    label: (entry.label || '').trim() || null,
    // The kind of attention it took, for the weekly rollup.
    attention: (entry.attention || '').trim() || null,
    // What Jira receives. Kept apart from `summary` on purpose: the summary is
    // a private record, the note goes on a ticket other people read.
    note: (entry.note || '').trim() || null,
    // What the ticket is, as opposed to what moved on it today. Persisted
    // rather than recomputed: the contexts board reads rows months later, by
    // which time the day cache that wrote this line has long been pruned.
    context: (entry.context || '').trim() || null,
    // The ticket's own name, where it stands, and the short clause the EOD
    // post prints under it.
    title: (entry.title || '').trim() || null,
    status: (entry.status || '').trim().toLowerCase() || null,
    eod: (entry.eod || '').trim() || null,
    minutes,
    summary: (entry.summary || '').trim(),
    startTime: entry.startTime || null,
    origin: entry.origin === 'manual' ? 'manual' : 'detected',
    // What the estimate was built from, so a row can always explain itself.
    sources: Array.isArray(entry.sources) ? entry.sources : [],
    // The candidate key detection would regenerate this row under. Lets a
    // re-scan recognise a row it already produced instead of duplicating it.
    candidateKey: entry.candidateKey || null,
    push: normalizePush(entry.push),
    // What this row said when it was first written: the suggestion as offered,
    // or what you typed. Never edited afterwards, so the suggestion survives
    // your rewrite of it and a later rescan that words the day differently.
    original: normalizeOriginal(entry.original, entry, minutes),
    notes: entry.notes || '',
    createdAt: entry.createdAt || new Date().toISOString(),
  };
}

function snapshot(entry, minutes) {
  const out = { minutes };
  for (const field of TEXT_FIELDS) {
    const value = field === 'status'
      ? (entry[field] || '').trim().toLowerCase()
      : (entry[field] || '').trim();
    out[field] = value || null;
  }
  return out;
}

function normalizeOriginal(original, entry, minutes) {
  if (original && typeof original === 'object') {
    return { ...snapshot(original, Math.max(0, Math.round(Number(original.minutes) || 0))), at: original.at || null };
  }
  return { ...snapshot(entry, minutes), at: entry.createdAt || new Date().toISOString() };
}

// Which fields you have changed since the row was first written.
function editedFields(entry) {
  const original = entry.original;
  if (!original) return [];
  const changed = TEXT_FIELDS.filter(field => (entry[field] || null) !== (original[field] || null));
  if (entry.minutes !== original.minutes) changed.push('minutes');
  return changed;
}

function normalizePush(push) {
  const base = { state: 'unpushed', worklogId: null, pushedAt: null, error: null, pushedMinutes: null };
  if (!push || typeof push !== 'object') return base;
  return {
    state: PUSH_STATES.includes(push.state) ? push.state : 'unpushed',
    worklogId: push.worklogId ? String(push.worklogId) : null,
    pushedAt: push.pushedAt || null,
    error: push.error || null,
    // What Jira was last known to hold, so drift can be spotted.
    pushedMinutes: Number.isFinite(push.pushedMinutes) ? push.pushedMinutes : null,
  };
}

function addEntry(dayKey, entry) {
  const day = readDay(dayKey);
  const normalized = normalizeEntry(entry, dayKey);
  day.entries.push(normalized);
  writeDay(day);
  return normalized;
}

function updateEntry(dayKey, entryId, patch) {
  const day = readDay(dayKey);
  const index = day.entries.findIndex(e => e.id === entryId);
  if (index === -1) return null;

  const current = day.entries[index];
  // `original` is not patchable: it is the record of what you were offered.
  const { original: _ignored, ...rest } = patch;
  const merged = normalizeEntry({ ...current, ...rest, id: current.id, date: current.date,
    // A row written before originals were kept gets one now, from its text
    // as it stood before this edit.
    original: current.original || normalizeOriginal(null, current, current.minutes),
  }, dayKey);

  // An entry already in Jira that changes locally is drift, not a fresh row.
  // Flagging it is what lets the tab offer "update in Jira" instead of
  // silently disagreeing with the ticket.
  const wasPushed = current.push.state === 'pushed';
  // Only what Jira actually holds counts as drift — editing the private
  // summary must not mark a correctly-pushed row stale.
  const changed = merged.minutes !== current.minutes || merged.note !== current.note;
  if (wasPushed && changed && !rest.push) {
    merged.push = { ...current.push, state: 'stale' };
  }

  day.entries[index] = merged;
  writeDay(day);
  return merged;
}

function removeEntry(dayKey, entryId) {
  const day = readDay(dayKey);
  const entry = day.entries.find(e => e.id === entryId);
  day.entries = day.entries.filter(e => e.id !== entryId);
  // Remember the dismissal so the next scan does not offer it straight back.
  if (entry?.candidateKey && !day.dismissed.includes(entry.candidateKey)) {
    day.dismissed.push(entry.candidateKey);
  }
  writeDay(day);
  return entry || null;
}

function dismissCandidate(dayKey, candidateKey) {
  const day = readDay(dayKey);
  if (!day.dismissed.includes(candidateKey)) day.dismissed.push(candidateKey);
  writeDay(day);
  return day;
}

function restoreCandidate(dayKey, candidateKey) {
  const day = readDay(dayKey);
  day.dismissed = day.dismissed.filter(k => k !== candidateKey);
  writeDay(day);
  return day;
}

// Puts a row's text back to what it was first written with. Time is left
// alone unless asked for: minutes are often corrected on purpose, and a revert
// that silently changed what Jira should hold would be a surprise.
function revertEntry(dayKey, entryId, { includeMinutes = false } = {}) {
  const day = readDay(dayKey);
  const current = day.entries.find(e => e.id === entryId);
  if (!current?.original) return null;
  const patch = {};
  for (const field of TEXT_FIELDS) patch[field] = current.original[field];
  if (includeMinutes) patch.minutes = current.original.minutes;
  return updateEntry(dayKey, entryId, patch);
}

// ------------------------------------------------------------ the posted EOD
//
// The message you actually sent. The generated one is recomputed on every
// view from the rows; this is yours and is only ever replaced by you. Each
// save keeps the previous text, and `drafted` records what the tool had
// generated at that moment, so the two can be compared later.

const EOD_HISTORY_LIMIT = 20;

function normalizeEod(eod) {
  if (!eod || typeof eod !== 'object' || typeof eod.text !== 'string') return null;
  return {
    text: eod.text,
    source: ['typed', 'slack'].includes(eod.source) ? eod.source : 'typed',
    savedAt: eod.savedAt || null,
    slackTs: eod.slackTs || null,
    drafted: typeof eod.drafted === 'string' ? eod.drafted : null,
    history: Array.isArray(eod.history) ? eod.history.slice(-EOD_HISTORY_LIMIT) : [],
  };
}

function setEod(dayKey, { text, source = 'typed', slackTs = null, drafted = null }) {
  const day = readDay(dayKey);
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!body) throw new Error('Nothing to save');
  if (day.eod && day.eod.text === body) return day.eod;

  const history = day.eod
    ? [...day.eod.history, { text: day.eod.text, source: day.eod.source, savedAt: day.eod.savedAt }]
    : [];
  day.eod = normalizeEod({
    text: body,
    source,
    slackTs: slackTs || day.eod?.slackTs || null,
    savedAt: new Date().toISOString(),
    drafted: drafted ?? day.eod?.drafted ?? null,
    history,
  });
  writeDay(day);
  return day.eod;
}

// Back to the generated message. The text you had is kept in history rather
// than thrown away — clearing is a change of mind, not a deletion.
function clearEod(dayKey) {
  const day = readDay(dayKey);
  if (!day.eod) return null;
  const { text, source, savedAt } = day.eod;
  day.eod = null;
  day.eodHistory = [...day.eodHistory, { text, source, savedAt }].slice(-EOD_HISTORY_LIMIT);
  writeDay(day);
  return null;
}

// Your recent posts, newest first, for the model to take your voice from.
function recentPosted(beforeDay, limit = 3) {
  const out = [];
  for (const dayKey of listDays()) {
    if (dayKey >= beforeDay) continue;
    const eod = readDay(dayKey).eod;
    if (eod?.text) out.push({ date: dayKey, text: eod.text });
    if (out.length >= limit) break;
  }
  return out;
}

function setPush(dayKey, entryId, push) {
  const day = readDay(dayKey);
  const index = day.entries.findIndex(e => e.id === entryId);
  if (index === -1) return null;
  day.entries[index].push = normalizePush({ ...day.entries[index].push, ...push });
  writeDay(day);
  return day.entries[index];
}

function totalMinutes(day) {
  return (day.entries || []).reduce((sum, e) => sum + (Number(e.minutes) || 0), 0);
}

function listDays() {
  try {
    return fs.readdirSync(WORKLOG_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace(/\.json$/, ''))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

module.exports = {
  PUSH_STATES,
  TEXT_FIELDS,
  dayFile,
  emptyDay,
  readDay,
  writeDay,
  normalizeEntry,
  addEntry,
  updateEntry,
  removeEntry,
  dismissCandidate,
  restoreCandidate,
  setPush,
  revertEntry,
  editedFields,
  setEod,
  clearEod,
  recentPosted,
  totalMinutes,
  listDays,
  newId,
};
