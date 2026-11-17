// The board: what is open, and what it has actually cost.
//
// Two halves that are collected in opposite directions. Attention is
// reconstructed backwards out of evidence the work log already keeps; open
// state is recorded forwards, one observation at a time, because nothing can
// tell you later what was open last Tuesday. They meet on the ticket — the same
// key the work log files a day's time under — so one row can say both what a
// piece of work is waiting for and how much of the week it took.

const store = require('./contextStore');
const sources = require('./contextSources');
const workLog = require('./workLogStore');
const config = require('./workLogConfig');
const time = require('./workLogTime');

const DEFAULT_SPAN_DAYS = 30;

// Opening the board should keep the record alive without writing an
// indistinguishable observation every time you glance at it.
const DEFAULT_MIN_OBSERVE_MINUTES = 30;

function keyOf(entry) {
  const ticket = (entry.ticket || '').trim().toUpperCase();
  return ticket || (entry.label || '').trim() || null;
}

function daysBetween(fromDay, toDay) {
  const out = [];
  let day = fromDay;
  while (day <= toDay) {
    out.push(day);
    day = time.shiftDay(day, 1);
  }
  return out;
}

// ------------------------------------------------------------------ recording

function dueForObservation(cfg = config.read(), now = Date.now()) {
  const opts = sources.settings(cfg);
  const minutes = Number.isFinite(opts.observeEveryMinutes)
    ? opts.observeEveryMinutes
    : DEFAULT_MIN_OBSERVE_MINUTES;
  const last = store.lastObservation();
  if (!last) return true;
  return now - new Date(last.at).getTime() >= minutes * 60000;
}

// One look at the world, written down. Everything else on this page reads what
// this leaves behind, so the board is only ever as good as how often this runs.
async function record({ cfg = config.read(), force = false, only = null } = {}) {
  if (!force && !dueForObservation(cfg)) {
    return { observation: store.lastObservation(), changes: [], skipped: true };
  }
  const { commitments, providers, errors } = await sources.collectAll({ cfg, only });
  const result = store.observe({
    commitments,
    providers,
    errors,
    keep: sources.settings(cfg).keepObservations,
  });
  return { ...result, skipped: false };
}

// ------------------------------------------------------------------ attention

// Minutes per context per day, out of the days you have already kept. No
// detection, no cache, no network — the work log did this work once and the
// answer is sitting in data/worklog.
function attentionByKey(days) {
  const byKey = new Map();

  for (const day of days) {
    for (const entry of workLog.readDay(day).entries || []) {
      const key = keyOf(entry);
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, { days: new Map(), minutes: 0, byAttention: {}, title: null, context: null });
      const bucket = byKey.get(key);
      const minutes = Number(entry.minutes) || 0;
      const kind = entry.attention || 'other';

      const cell = bucket.days.get(day) || { minutes: 0, entries: 0, byAttention: {} };
      cell.minutes += minutes;
      cell.entries += 1;
      cell.byAttention[kind] = (cell.byAttention[kind] || 0) + minutes;
      bucket.days.set(day, cell);

      bucket.minutes += minutes;
      bucket.byAttention[kind] = (bucket.byAttention[kind] || 0) + minutes;
      bucket.title = bucket.title || entry.title || null;
      bucket.context = bucket.context || entry.context || null;
    }
  }

  return byKey;
}

// ---------------------------------------------------------------------- board

function endOfDay(day, tz) {
  return new Date(time.instantFor(time.shiftDay(day, 1), '00:00', tz).getTime() - 1).toISOString();
}

function dominant(byAttention) {
  let best = null;
  for (const [kind, minutes] of Object.entries(byAttention || {})) {
    if (!best || minutes > best.minutes) best = { kind, minutes };
  }
  return best?.kind || null;
}

function buildRow(key, record, attention, days, tz) {
  const cells = days.map(day => {
    const cell = attention?.days.get(day) || null;
    const at = store.stateAt(record || { transitions: [] }, endOfDay(day, tz));
    return {
      day,
      // Null means nothing had been recorded about this context yet on that
      // day — not that it was closed.
      state: at?.state || null,
      status: at?.status || null,
      minutes: cell?.minutes || 0,
      attention: cell ? dominant(cell.byAttention) : null,
      byAttention: cell?.byAttention || {},
    };
  });

  const touched = cells.filter(c => c.minutes > 0);
  const lastTouched = touched.length ? touched[touched.length - 1].day : null;
  const current = record?.transitions[record.transitions.length - 1] || null;

  return {
    key,
    kind: record?.kind || (/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(key) ? 'ticket' : 'label'),
    title: record?.title || attention?.title || null,
    context: record?.context || attention?.context || null,
    url: record?.url || null,
    repo: record?.repo || null,
    startedAt: record?.startedAt || null,
    firstSeen: record?.firstSeen || null,
    lastSeen: record?.lastSeen || null,
    current,
    // Recorded open state with no attention behind it. The rows where these two
    // disagree are the point of the whole view: open and cold is a thing you
    // have forgotten, not a thing you are doing.
    open: current?.state === 'open',
    cells,
    minutes: attention?.minutes || 0,
    byAttention: attention?.byAttention || {},
    daysWorked: touched.length,
    lastTouched,
    coldDays: current?.state === 'open' && lastTouched
      ? daysBetween(lastTouched, days[days.length - 1]).length - 1
      : null,
  };
}

// Open and untouched first, then open and cold, then whatever you have actually
// been doing. Sorting by date would bury the one row this view exists to show.
function rank(row) {
  if (row.open && !row.daysWorked) return [0, -(row.coldDays ?? 999)];
  if (row.open) return [1, -(row.coldDays ?? 0)];
  return [2, -row.minutes];
}

function board({ from, to, cfg = config.read() } = {}) {
  const tz = cfg.workTimezone;
  const toDay = to || time.todayKey(tz);
  const fromDay = from || time.shiftDay(toDay, -(DEFAULT_SPAN_DAYS - 1));
  const days = daysBetween(fromDay, toDay);

  const records = store.listRecords();
  const attention = attentionByKey(days);

  // Both halves contribute rows. A context recorded but never worked on is the
  // backlog; one worked on but never recorded is work that predates the record,
  // or that no provider can see.
  const keys = new Set([...records.map(r => r.key), ...attention.keys()]);
  const byKey = new Map(records.map(r => [r.key, r]));

  const rows = [...keys]
    .map(key => buildRow(key, byKey.get(key) || null, attention.get(key) || null, days, tz))
    .sort((a, b) => {
      const [ag, av] = rank(a);
      const [bg, bv] = rank(b);
      return ag - bg || av - bv || (b.minutes - a.minutes) || a.key.localeCompare(b.key);
    });

  // Which days were actually looked at. A day with no observation shows state
  // carried forward from an earlier one, and should not be drawn as though it
  // were seen.
  const observations = store.readObservations();
  const observed = {};
  for (const observation of observations) {
    const day = time.dayKey(observation.at, tz);
    if (day < fromDay || day > toDay) continue;
    observed[day] = (observed[day] || 0) + 1;
  }

  return {
    from: fromDay,
    to: toDay,
    days,
    rows,
    observed,
    lastObservation: observations[observations.length - 1] || null,
    totals: {
      open: rows.filter(r => r.open).length,
      cold: rows.filter(r => r.open && (r.coldDays === null || r.coldDays >= 3)).length,
      minutes: rows.reduce((sum, r) => sum + r.minutes, 0),
    },
  };
}

// What was open on one day, with how close the nearest look was — because an
// answer drawn from an observation four days later is a different kind of
// answer, and the caller is entitled to know which one it got.
function openOn(day, { cfg = config.read() } = {}) {
  const tz = cfg.workTimezone;
  const instant = endOfDay(day, tz);
  const records = store.listRecords();

  return {
    day,
    at: instant,
    coverage: store.nearestObservation(instant),
    contexts: store.openAt(instant, records).map(record => ({
      key: record.key,
      kind: record.kind,
      title: record.title,
      context: record.context,
      url: record.url,
      status: record.current?.status || null,
      detail: record.current?.detail || null,
      by: record.current?.by || [],
      since: record.current?.at || null,
    })),
  };
}

// The whole history of one context: every state it has been in, and every day
// that went into it.
function history(key, { cfg = config.read() } = {}) {
  const record = store.readRecord(key);
  const days = workLog.listDays().sort();
  const attention = attentionByKey(days).get(key) || null;

  if (!record && !attention) return null;

  return {
    key,
    record,
    attention: attention
      ? {
          minutes: attention.minutes,
          byAttention: attention.byAttention,
          days: [...attention.days.entries()]
            .map(([day, cell]) => ({ day, ...cell }))
            .sort((a, b) => a.day.localeCompare(b.day)),
        }
      : null,
  };
}

// ------------------------------------------------------------------- recorder

let timer = null;

// History only exists if something keeps looking. Opening the tab records a
// look, but a week you never opened it would otherwise be a blank stretch in
// the one thing here that cannot be rebuilt afterwards.
function startRecording({ cfg = config.read() } = {}) {
  if (timer) return timer;
  const minutes = Number.isFinite(sources.settings(cfg).observeEveryMinutes)
    ? sources.settings(cfg).observeEveryMinutes
    : DEFAULT_MIN_OBSERVE_MINUTES;

  const tick = () => {
    record({ cfg: config.read() }).catch(() => {
      // A failed look is already written to the observation log by way of the
      // provider errors; it must never take the server down with it.
    });
  };

  tick();
  timer = setInterval(tick, Math.max(5, minutes) * 60000);
  timer.unref?.();
  return timer;
}

function stopRecording() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  DEFAULT_SPAN_DAYS,
  keyOf,
  daysBetween,
  dueForObservation,
  record,
  attentionByKey,
  board,
  openOn,
  history,
  startRecording,
  stopRecording,
};
