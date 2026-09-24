// Turning evidence into a day you can read.
//
// Signals are scattered instants. A day is a handful of lines, one per ticket,
// because that is the grain Jira logs time at. Everything here is an estimate
// offered for editing — a row always carries the signals it came from so you
// can see why it says what it says.

const time = require('./workLogTime');
const config = require('./workLogConfig');
const store = require('./workLogStore');
const sources = require('./workLogSources');

const UNATTRIBUTED = '__unattributed__';

// A busy day produces hundreds of signals per row, and every one of them was
// being serialised into the response for a panel that shows a few dozen. The
// full set still drives the estimate; only what travels is capped.
const DEFAULT_EVIDENCE_LIMIT = 60;

function candidateKey(dayKey, ticket) {
  return `${dayKey}|${ticket || UNATTRIBUTED}`;
}

// The most descriptive thing we know, kept short. Commit subjects say what
// changed; a session prompt says what was being attempted; the rest is noise
// by comparison.
function summarize(signals) {
  const rank = { git: 0, github: 1, sessions: 2, initiatives: 3, jira: 4, reflog: 5, shell: 6 };
  const seen = new Set();
  const phrases = [];

  for (const signal of [...signals].sort((a, b) => (rank[a.source] ?? 9) - (rank[b.source] ?? 9))) {
    let text = String(signal.text || '').trim();
    // The ticket prefix is already the row's ticket; repeating it wastes the line.
    text = text.replace(/^[A-Z][A-Z0-9]{1,9}-\d+[:\s]+/, '').trim();
    if (!text) continue;
    const key = text.toLowerCase().slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    phrases.push(text.length > 90 ? `${text.slice(0, 87)}…` : text);
    if (phrases.length === 3) break;
  }

  return phrases.join('; ');
}

function countBySource(signals) {
  const counts = {};
  for (const signal of signals) counts[signal.source] = (counts[signal.source] || 0) + 1;
  return counts;
}

// Group a window's signals into one candidate per ticket per day.
function buildCandidates(signals, cfg) {
  const tz = cfg.workTimezone;
  const byDayTicket = new Map();

  for (const signal of signals) {
    const day = time.dayKey(signal.at, tz);
    const key = `${day}|${signal.ticket || UNATTRIBUTED}`;
    if (!byDayTicket.has(key)) {
      byDayTicket.set(key, { day, ticket: signal.ticket || null, signals: [] });
    }
    byDayTicket.get(key).signals.push(signal);
  }

  const candidates = [];
  for (const group of byDayTicket.values()) {
    const { minutes, blocks } = time.clusterMinutes(group.signals.map(s => s.at), {
      idleGapMinutes: cfg.idleGapMinutes,
      loneSignalMinutes: cfg.loneSignalMinutes,
    });

    const first = group.signals.reduce((a, b) => (new Date(a.at) < new Date(b.at) ? a : b));

    candidates.push({
      candidateKey: candidateKey(group.day, group.ticket),
      date: group.day,
      ticket: group.ticket,
      rawMinutes: minutes,
      minutes: time.roundMinutes(minutes, cfg.roundToMinutes),
      startTime: time.wallClock(first.at, tz),
      summary: summarize(group.signals),
      blocks,
      sourceCounts: countBySource(group.signals),
      signals: group.signals
        .sort((a, b) => new Date(a.at) - new Date(b.at))
        .map(s => ({
          source: s.source,
          at: s.at,
          wall: time.wallClock(s.at, tz),
          text: s.text,
          ref: s.ref,
          url: s.url,
          repo: s.repo,
        })),
    });
  }

  return candidates;
}

// Clustering counts wall-clock presence, so a day spent switching between
// tickets can add up past a working day. Scaling keeps the shape of the day
// while bringing the total back to something you would actually claim.
function scaleToDay(candidates, cfg) {
  const byDay = new Map();
  for (const candidate of candidates) {
    if (!byDay.has(candidate.date)) byDay.set(candidate.date, []);
    byDay.get(candidate.date).push(candidate);
  }

  for (const dayCandidates of byDay.values()) {
    const total = dayCandidates.reduce((sum, c) => sum + c.minutes, 0);
    const cap = cfg.dayMinutes;
    if (!cap || total <= cap) continue;

    const factor = cap / total;
    for (const candidate of dayCandidates) {
      candidate.scaledFrom = candidate.minutes;
      candidate.minutes = time.roundMinutes(candidate.minutes * factor, cfg.roundToMinutes);
    }
  }
  return candidates;
}

// The model's description of a block replaces the mechanical one. Everything
// stays optional: without narration a row keeps its glued-together summary and
// simply has no attention kind, which is worse to read but never broken.
function applyNarration(candidates, narration) {
  const byKey = narration?.byKey || {};

  return candidates.map(candidate => {
    const described = byKey[candidate.candidateKey];
    if (!described) {
      return { ...candidate, label: candidate.ticket, kind: null, note: null, title: null, status: null, context: null, eod: null };
    }
    return {
      ...candidate,
      label: described.label || candidate.ticket,
      kind: described.kind || null,
      // The ticket's own name and where it stands, for the EOD post.
      title: described.title || null,
      status: described.status || null,
      // What the ticket is about, which does not change day to day. The post
      // reads better when the standing subject and today's movement are
      // separate lines rather than one run-on clause.
      context: described.context || null,
      // A short clause for the post — shorter than the summary, less vague
      // than the Jira note.
      eod: described.eod || null,
      summary: described.summary || candidate.summary,
      // What Jira gets. Deliberately not the summary — a shared ticket wants
      // the shape of the work, not the detail of it.
      note: described.note || null,
      // Keep the mechanical text so a row can show what it was derived from.
      rawSummary: candidate.summary,
    };
  });
}

function matchesJira(entry, worklog) {
  return entry.push?.worklogId && String(entry.push.worklogId) === String(worklog.worklogId);
}

// One merged list. A row is one of three things: something you saved, a
// candidate detection is offering, or time that already exists in Jira and
// has no local counterpart.
function mergeRows({ dayKey, stored, candidates, jiraWorklogs, cfg, ticketDetails = {}, evidenceLimit = DEFAULT_EVIDENCE_LIMIT }) {
  // Jira is authoritative for a ticket's title and status; the model only
  // infers them from commits and PR titles, which gets close but not right.
  const titled = row => ({
    ...row,
    title: ticketDetails[row.ticket]?.title || row.title || null,
    status: (ticketDetails[row.ticket]?.status || row.status || '').toLowerCase() || null,
    context: ticketDetails[row.ticket]?.context || row.context || null,
  });
  const trim = signals => (evidenceLimit === null ? signals : signals.slice(0, evidenceLimit));
  const rows = [];
  const claimedWorklogIds = new Set();
  const usedCandidateKeys = new Set();

  const candidateByKey = new Map(candidates.map(c => [c.candidateKey, c]));

  for (const entry of stored.entries) {
    const candidate = entry.candidateKey ? candidateByKey.get(entry.candidateKey) : null;
    if (candidate) usedCandidateKeys.add(candidate.candidateKey);

    const worklog = jiraWorklogs.find(w => matchesJira(entry, w));
    if (worklog) claimedWorklogIds.add(worklog.worklogId);

    // Jira is the source of truth. If it disagrees with what we stored, the
    // row is stale and the tab offers to reconcile rather than pretending.
    let push = entry.push;
    if (entry.push?.worklogId && !worklog) {
      push = { ...entry.push, state: 'failed', error: 'Worklog no longer exists in Jira' };
    } else if (worklog && worklog.minutes !== entry.minutes) {
      push = { ...entry.push, state: 'stale', pushedMinutes: worklog.minutes };
    } else if (worklog) {
      push = { ...entry.push, state: 'pushed', pushedMinutes: worklog.minutes };
    }

    rows.push(titled({
      ...entry,
      kind: 'entry',
      label: entry.label || (candidate && candidate.label) || entry.ticket,
      title: entry.title || (candidate && candidate.title) || null,
      status: entry.status || (candidate && candidate.status) || null,
      context: entry.context || (candidate && candidate.context) || null,
      eod: entry.eod || (candidate && candidate.eod) || null,
      attention: entry.attention || (candidate && candidate.kind) || null,
      note: entry.note || (candidate && candidate.note) || null,
      push,
      evidence: trim(candidate ? candidate.signals : (entry.sources || [])),
      evidenceTotal: (candidate ? candidate.signals : (entry.sources || [])).length,
      sourceCounts: candidate ? candidate.sourceCounts : {},
      jira: worklog || null,
      // What you changed from the text the row was first written with.
      edited: store.editedFields(entry),
    }));
  }

  for (const candidate of candidates) {
    if (usedCandidateKeys.has(candidate.candidateKey)) continue;
    if (stored.dismissed.includes(candidate.candidateKey)) continue;

    // This ticket already carries time for the day. The detection may still
    // be real extra work, but adding it blind would double-log, so the row
    // says so instead of quietly inviting the mistake.
    const alreadyInJira = jiraWorklogs
      .filter(w => w.ticket && candidate.ticket && w.ticket === candidate.ticket)
      .reduce((sum, w) => sum + w.minutes, 0);

    rows.push({
      coveredByJiraMinutes: alreadyInJira || null,
      kind: 'candidate',
      id: candidate.candidateKey,
      candidateKey: candidate.candidateKey,
      date: candidate.date,
      ticket: candidate.ticket,
      label: candidate.label || candidate.ticket,
      attention: candidate.kind || null,
      note: candidate.note || null,
      title: candidate.title || null,
      status: candidate.status || null,
      context: candidate.context || null,
      eod: candidate.eod || null,
      minutes: candidate.minutes,
      scaledFrom: candidate.scaledFrom || null,
      rawMinutes: candidate.rawMinutes,
      startTime: candidate.startTime,
      summary: candidate.summary,
      origin: 'detected',
      push: { state: 'unpushed', worklogId: null, pushedAt: null, error: null, pushedMinutes: null },
      evidence: trim(candidate.signals),
      evidenceTotal: candidate.signals.length,
      sourceCounts: candidate.sourceCounts,
      jira: null,
    });
  }

  // Time in Jira that this log never produced — logged by hand, or from
  // another machine. Showing it is what makes the day total trustworthy.
  for (const worklog of jiraWorklogs) {
    if (claimedWorklogIds.has(worklog.worklogId)) continue;
    rows.push({
      kind: 'jira',
      id: `jira-${worklog.worklogId}`,
      candidateKey: null,
      date: dayKey,
      ticket: worklog.ticket,
      label: worklog.ticket,
      attention: null,
      note: worklog.comment || null,
      minutes: worklog.minutes,
      startTime: worklog.started ? worklog.started.slice(11, 16) : null,
      summary: worklog.comment || worklog.ticketSummary || '',
      origin: 'jira',
      push: {
        state: 'pushed',
        worklogId: worklog.worklogId,
        pushedAt: worklog.started,
        error: null,
        pushedMinutes: worklog.minutes,
      },
      evidence: [],
      evidenceTotal: 0,
      sourceCounts: {},
      jira: worklog,
    });
  }

  const order = { jira: 0, entry: 1, candidate: 2 };
  rows.sort((a, b) => {
    const byTime = String(a.startTime || '99:99').localeCompare(String(b.startTime || '99:99'));
    if (byTime !== 0) return byTime;
    return (order[a.kind] ?? 9) - (order[b.kind] ?? 9);
  });

  return rows;
}

// The whole day, assembled. `jiraWorklogs` is passed in rather than fetched
// so this stays pure and testable, and so a Jira outage degrades to a local
// view instead of an error page.
function assembleDay({
  dayKey,
  signals,
  jiraWorklogs = [],
  cfg = config.read(),
  evidenceLimit = DEFAULT_EVIDENCE_LIMIT,
  narration = null,
  ticketDetails = {},
}) {
  const stored = store.readDay(dayKey);
  const candidates = applyNarration(
    scaleToDay(buildCandidates(signals, cfg).filter(c => c.date === dayKey), cfg),
    narration,
  );
  const rows = mergeRows({ dayKey, stored, candidates, jiraWorklogs, cfg, ticketDetails, evidenceLimit });

  const counted = rows.filter(r => r.kind !== 'candidate');

  // Where the day's attention went, split by how settled it is. Suggestions
  // are included because on a day you have not triaged yet they *are* the
  // day — but they are kept apart from time you have actually claimed.
  const byAttention = {};
  for (const row of rows) {
    const key = row.attention || 'unclassified';
    if (!byAttention[key]) byAttention[key] = { logged: 0, suggested: 0 };
    byAttention[key][row.kind === 'candidate' ? 'suggested' : 'logged'] += row.minutes || 0;
  }

  return {
    date: dayKey,
    rows,
    byAttention,
    totals: {
      // What you have committed to for the day.
      logged: counted.reduce((sum, r) => sum + (r.minutes || 0), 0),
      // What is in Jira right now.
      pushed: rows.filter(r => r.push?.state === 'pushed').reduce((sum, r) => sum + (r.minutes || 0), 0),
      // What detection is still offering.
      suggested: rows.filter(r => r.kind === 'candidate').reduce((sum, r) => sum + (r.minutes || 0), 0),
      dayTarget: cfg.dayMinutes,
    },
    dismissedCount: stored.dismissed.length,
  };
}

module.exports = {
  UNATTRIBUTED,
  DEFAULT_EVIDENCE_LIMIT,
  applyNarration,
  candidateKey,
  summarize,
  buildCandidates,
  scaleToDay,
  mergeRows,
  assembleDay,
};
