// Time handling for the work log.
//
// Three clocks disagree on this machine: the OS runs one offset, the calendar
// another, and Jira judges a worklog's day by the account's own timezone. Work
// logged at 22:00 in one zone is the previous day in another, so every signal
// is collected as an absolute instant and only ever bucketed into a day
// through one configured work timezone.

// Node's Intl knows each zone's offset on a given date, including DST, which
// is the only reason we can stamp Jira correctly without a tz database.
function offsetMinutes(instant, timeZone) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return 0;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(date);

  const name = parts.find(p => p.type === 'timeZoneName')?.value || '';
  const match = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;

  const sign = match[1] === '-' ? -1 : 1;
  const hours = parseInt(match[2], 10) || 0;
  const minutes = parseInt(match[3] || '0', 10) || 0;
  return sign * (hours * 60 + minutes);
}

// "+HHMM" / "-HHMM", the shape Jira's `started` field wants.
function offsetStamp(instant, timeZone) {
  const total = offsetMinutes(instant, timeZone);
  const sign = total < 0 ? '-' : '+';
  const abs = Math.abs(total);
  return sign + String(Math.floor(abs / 60)).padStart(2, '0') + String(abs % 60).padStart(2, '0');
}

// The wall-clock fields an instant shows in a zone.
function wallParts(instant, timeZone) {
  const date = instant instanceof Date ? instant : new Date(instant);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = type => parts.find(p => p.type === type)?.value || '00';
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // Intl renders midnight as "24" in some locales; normalise it.
    hour: get('hour') === '24' ? '00' : get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

// Which day a signal belongs to, decided in the work timezone.
function dayKey(instant, timeZone) {
  const p = wallParts(instant, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

function wallClock(instant, timeZone) {
  const p = wallParts(instant, timeZone);
  return `${p.hour}:${p.minute}`;
}

// A Jira `started` value: local wall time in the work zone plus that zone's
// offset, e.g. 2026-08-13T11:00:00.000-0500.
function jiraStarted(instant, timeZone) {
  const p = wallParts(instant, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000${offsetStamp(instant, timeZone)}`;
}

// The instant a wall-clock time in the work zone corresponds to. Used to turn
// "09:00 on 2026-08-13" into something we can stamp and compare.
function instantFor(dayKeyValue, hhmm, timeZone) {
  const [y, m, d] = String(dayKeyValue).split('-').map(Number);
  const [hh, mm] = String(hhmm || '09:00').split(':').map(Number);
  // Guess UTC, then correct by the offset that guess lands on. One correction
  // is enough except across a DST boundary, so we settle it twice.
  let guess = Date.UTC(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0);
  for (let i = 0; i < 2; i++) {
    const off = offsetMinutes(new Date(guess), timeZone);
    const corrected = Date.UTC(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0) - off * 60000;
    if (corrected === guess) break;
    guess = corrected;
  }
  return new Date(guess);
}

// The UTC window covering a run of days in the work zone, so collectors can
// ask each source for exactly the range the view needs.
function dayRange(fromDayKey, toDayKey, timeZone) {
  const start = instantFor(fromDayKey, '00:00', timeZone);
  const endDay = instantFor(toDayKey, '00:00', timeZone);
  const end = new Date(endDay.getTime() + 24 * 60 * 60 * 1000);
  return { from: start, to: end };
}

function shiftDay(dayKeyValue, days) {
  const [y, m, d] = String(dayKeyValue).split('-').map(Number);
  const base = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

// Monday-first, matching how the week reads in standup.
function weekStart(dayKeyValue) {
  const [y, m, d] = String(dayKeyValue).split('-').map(Number);
  const base = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  const dow = base.getUTCDay();
  return shiftDay(dayKeyValue, dow === 0 ? -6 : 1 - dow);
}

function todayKey(timeZone) {
  return dayKey(new Date(), timeZone);
}

// Signals arrive as scattered instants. A run of them with no long silence is
// one sitting of work, and its span is the honest estimate of its duration —
// far better than counting commits. A lone signal gets a nominal minimum,
// because a commit at 14:02 with nothing around it still cost something.
function clusterMinutes(instants, { idleGapMinutes = 30, loneSignalMinutes = 15 } = {}) {
  const times = instants
    .map(i => (i instanceof Date ? i.getTime() : new Date(i).getTime()))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!times.length) return { minutes: 0, blocks: [] };

  const gapMs = idleGapMinutes * 60000;
  const blocks = [];
  let start = times[0];
  let prev = times[0];

  for (let i = 1; i < times.length; i++) {
    if (times[i] - prev > gapMs) {
      blocks.push({ start, end: prev });
      start = times[i];
    }
    prev = times[i];
  }
  blocks.push({ start, end: prev });

  const minutes = blocks.reduce((total, block) => {
    const span = Math.round((block.end - block.start) / 60000);
    return total + Math.max(span, loneSignalMinutes);
  }, 0);

  return {
    minutes,
    blocks: blocks.map(b => ({ start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString() })),
  };
}

function roundMinutes(minutes, step = 15) {
  if (!step || step < 1) return Math.max(0, Math.round(minutes));
  return Math.max(step, Math.round(minutes / step) * step);
}

// Jira renders 1d as the site's workday, not 24h, so we always send minutes
// and let it do the formatting.
function formatDuration(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

// When a row's work began, for Jira. Jira files a worklog under the date its
// start falls on in your Jira profile's timezone, which need not be the work
// zone: work just after midnight in São Paulo is still the evening before in
// Chicago, so a row for the 2nd showed up in Jira on the 1st. Where the zones
// disagree on the date, the start moves only as far as that day's edge in the
// Jira zone.
function startedForDay(dayKeyValue, hhmm, workZone, jiraZone) {
  const instant = instantFor(dayKeyValue, hhmm, workZone);
  if (!jiraZone) return instant;
  const jiraDay = dayKey(instant, jiraZone);
  if (jiraDay < dayKeyValue) return instantFor(dayKeyValue, '00:00', jiraZone);
  if (jiraDay > dayKeyValue) return instantFor(dayKeyValue, '23:59', jiraZone);
  return instant;
}

module.exports = {
  offsetMinutes,
  offsetStamp,
  wallParts,
  wallClock,
  dayKey,
  jiraStarted,
  instantFor,
  startedForDay,
  dayRange,
  shiftDay,
  weekStart,
  todayKey,
  clusterMinutes,
  roundMinutes,
  formatDuration,
};
