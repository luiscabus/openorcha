// Durable work log entries, one file per day.
//
// A day file holds the entries you have accepted — detected candidates you
// kept plus anything you typed yourself. Detection is re-run freely and never
// overwrites a day: a candidate you already dealt with stays dealt with, and
// one you edited keeps your edit.

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

function emptyDay(dayKey) {
  return { date: dayKey, entries: [], dismissed: [], updatedAt: null };
}

function readDay(dayKey) {
  try {
    const parsed = JSON.parse(fs.readFileSync(dayFile(dayKey), 'utf8'));
    return {
      date: parsed.date || dayKey,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed : [],
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
    notes: entry.notes || '',
    createdAt: entry.createdAt || new Date().toISOString(),
  };
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
  const merged = normalizeEntry({ ...current, ...patch, id: current.id, date: current.date }, dayKey);

  // An entry already in Jira that changes locally is drift, not a fresh row.
  // Flagging it is what lets the tab offer "update in Jira" instead of
  // silently disagreeing with the ticket.
  const wasPushed = current.push.state === 'pushed';
  // Only what Jira actually holds counts as drift — editing the private
  // summary must not mark a correctly-pushed row stale.
  const changed = merged.minutes !== current.minutes || merged.note !== current.note;
  if (wasPushed && changed && !patch.push) {
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
  totalMinutes,
  listDays,
  newId,
};
