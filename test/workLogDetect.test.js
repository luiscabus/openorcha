const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the store at a scratch directory before anything reads the config.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-worklog-'));
process.env.OPENORCHA_WORKLOG_DIR = TMP;

const detect = require('../lib/workLogDetect');
const store = require('../lib/workLogStore');

const cfg = {
  workTimezone: 'America/Chicago',
  dayMinutes: 420,
  roundToMinutes: 15,
  idleGapMinutes: 30,
  loneSignalMinutes: 15,
  ticketPattern: '[A-Z][A-Z0-9]{1,9}-\\d+',
};

function signal(at, ticket, text, source = 'git') {
  return { source, at, ticket, text, ref: 'ref', url: null, repo: 'soci' };
}

test.afterEach(() => {
  for (const file of fs.readdirSync(TMP)) fs.rmSync(path.join(TMP, file));
});

test('signals become one candidate per ticket per day', () => {
  const candidates = detect.buildCandidates([
    signal('2026-08-13T17:18:00Z', 'SO-90816', 'SO-90816 Enqueue the backfill'),
    signal('2026-08-13T17:45:00Z', 'SO-90816', 'SO-90816 Decode the credentials'),
    signal('2026-08-13T21:00:00Z', 'SO-93675', 'Review activity'),
  ], cfg);

  assert.equal(candidates.length, 2);
  const backfill = candidates.find(c => c.ticket === 'SO-90816');
  assert.equal(backfill.date, '2026-08-13');
  assert.equal(backfill.minutes, 30);
  assert.equal(backfill.startTime, '12:18');
});

test('the ticket prefix is stripped from the summary it already labels', () => {
  const [candidate] = detect.buildCandidates([
    signal('2026-08-13T17:18:00Z', 'SO-90816', 'SO-90816 Enqueue the 2-year backfill'),
  ], cfg);
  assert.equal(candidate.summary, 'Enqueue the 2-year backfill');
});

test('a day longer than the target keeps every minute it was worked', () => {
  // Three tickets worked side by side from 12:00 to 15:00, nine hours in all.
  const long = [];
  for (const ticket of ['SO-1', 'SO-2', 'SO-3']) {
    for (let minute = 0; minute <= 180; minute += 10) {
      long.push(signal(new Date(Date.parse('2026-08-13T17:00:00Z') + minute * 60000).toISOString(), ticket, `${ticket} work`));
    }
  }
  const day = detect.assembleDay({ dayKey: '2026-08-13', signals: long, cfg });

  assert.deepEqual(day.rows.map(r => r.minutes), [180, 180, 180]);
  assert.equal(day.totals.suggested, 540);
  assert.equal(day.totals.dayTarget, cfg.dayMinutes);
});

test('an unattributed signal still produces a line to fix by hand', () => {
  const [candidate] = detect.buildCandidates([signal('2026-08-13T17:18:00Z', null, 'poked at a 503')], cfg);
  assert.equal(candidate.ticket, null);
  assert.equal(candidate.candidateKey, '2026-08-13|__unattributed__');
});

test('a described block uses the model\'s words and keeps the mechanical ones', () => {
  const narration = { byKey: { '2026-08-13|SO-90816': {
    label: 'SO-90816', kind: 'coding', summary: 'Wired the 2-year backfill to enqueue on link.', note: 'Implementation.',
  } } };
  const day = detect.assembleDay({
    dayKey: '2026-08-13',
    signals: [signal('2026-08-13T17:18:00Z', 'SO-90816', 'SO-90816 Enqueue the backfill')],
    narration,
    cfg,
  });

  const row = day.rows[0];
  assert.equal(row.summary, 'Wired the 2-year backfill to enqueue on link.');
  assert.equal(row.attention, 'coding');
  assert.equal(row.note, 'Implementation.');
});

test('a day the model could not describe still renders, mechanically', () => {
  const day = detect.assembleDay({
    dayKey: '2026-08-13',
    signals: [signal('2026-08-13T17:18:00Z', 'SO-90816', 'SO-90816 Enqueue the backfill')],
    narration: null,
    cfg,
  });
  assert.equal(day.rows[0].summary, 'Enqueue the backfill');
  assert.equal(day.rows[0].attention, null);
});

test('work with no ticket gets a name so it is still a context', () => {
  const narration = { byKey: { '2026-08-13|__unattributed__': {
    label: 'local 503 debugging', kind: 'debugging', summary: 'Chased a 503 on the local site settings page.', note: 'Debugging.',
  } } };
  const day = detect.assembleDay({
    dayKey: '2026-08-13',
    signals: [signal('2026-08-13T17:18:00Z', null, 'why is local returning 503')],
    narration,
    cfg,
  });
  assert.equal(day.rows[0].ticket, null);
  assert.equal(day.rows[0].label, 'local 503 debugging');
});

test('the day totals say where the attention went', () => {
  const narration = { byKey: {
    '2026-08-13|SO-1': { label: 'SO-1', kind: 'coding', summary: 'Built it.', note: 'Implementation.' },
    '2026-08-13|SO-2': { label: 'SO-2', kind: 'peer-review', summary: 'Reviewed a teammate\'s PR.', note: 'Code review.' },
  } };
  store.addEntry('2026-08-13', { ticket: 'SO-1', minutes: 120, attention: 'coding', candidateKey: '2026-08-13|SO-1' });
  store.addEntry('2026-08-13', { ticket: 'SO-2', minutes: 60, attention: 'peer-review', candidateKey: '2026-08-13|SO-2' });

  const day = detect.assembleDay({ dayKey: '2026-08-13', signals: [], narration, cfg });
  assert.deepEqual(day.byAttention, {
    coding: { logged: 120, suggested: 0 },
    'peer-review': { logged: 60, suggested: 0 },
  });
});

test('the breakdown counts suggestions, but keeps them apart from claimed time', () => {
  // On a day you have not triaged yet the suggestions are the only picture of
  // it, so hiding them would leave the panel blank exactly when it is wanted.
  const narration = { byKey: { '2026-08-13|SO-1': {
    label: 'SO-1', kind: 'coding', summary: 'Built it.', note: 'Implementation.',
  } } };
  const day = detect.assembleDay({
    dayKey: '2026-08-13',
    signals: [signal('2026-08-13T17:18:00Z', 'SO-1', 'SO-1 work')],
    narration,
    cfg,
  });
  assert.deepEqual(day.byAttention, { coding: { logged: 0, suggested: 15 } });
  // And it still does not count towards the day's logged total.
  assert.equal(day.totals.logged, 0);
});

test('a kept entry replaces its candidate instead of duplicating it', () => {
  store.addEntry('2026-08-13', {
    ticket: 'SO-90816',
    minutes: 60,
    summary: 'my own words',
    candidateKey: '2026-08-13|SO-90816',
  });

  const day = detect.assembleDay({
    dayKey: '2026-08-13',
    signals: [signal('2026-08-13T17:18:00Z', 'SO-90816', 'SO-90816 Enqueue the backfill')],
    cfg,
  });

  assert.equal(day.rows.length, 1);
  assert.equal(day.rows[0].kind, 'entry');
  assert.equal(day.rows[0].minutes, 60);
  assert.equal(day.rows[0].summary, 'my own words');
  // The candidate's evidence is still attached, so the row can explain itself.
  assert.equal(day.rows[0].evidence.length, 1);
});

test('a dismissed candidate is not offered again', () => {
  store.dismissCandidate('2026-08-13', '2026-08-13|SO-90816');
  const day = detect.assembleDay({
    dayKey: '2026-08-13',
    signals: [signal('2026-08-13T17:18:00Z', 'SO-90816', 'SO-90816 Enqueue the backfill')],
    cfg,
  });
  assert.equal(day.rows.length, 0);
});

test('time that exists only in Jira is adopted so the day total is honest', () => {
  const day = detect.assembleDay({
    dayKey: '2026-08-13',
    signals: [],
    jiraWorklogs: [{ worklogId: '21283', ticket: 'SO-93675', started: '2026-08-13T11:00:00.000-0500', minutes: 75, comment: 'Code review.' }],
    cfg,
  });

  assert.equal(day.rows.length, 1);
  assert.equal(day.rows[0].kind, 'jira');
  assert.equal(day.rows[0].push.state, 'pushed');
  assert.equal(day.totals.logged, 75);
  assert.equal(day.totals.pushed, 75);
});

test('an entry Jira disagrees with is marked drifted, not silently accepted', () => {
  store.addEntry('2026-08-13', {
    ticket: 'SO-93675',
    minutes: 90,
    summary: 'Code review.',
    push: { state: 'pushed', worklogId: '21283', pushedMinutes: 75 },
  });

  const day = detect.assembleDay({
    dayKey: '2026-08-13',
    signals: [],
    jiraWorklogs: [{ worklogId: '21283', ticket: 'SO-93675', started: '2026-08-13T11:00:00.000-0500', minutes: 75, comment: 'Code review.' }],
    cfg,
  });

  assert.equal(day.rows[0].push.state, 'stale');
  assert.equal(day.rows[0].push.pushedMinutes, 75);
});

test('an entry whose worklog vanished from Jira is flagged, not left claiming success', () => {
  store.addEntry('2026-08-13', {
    ticket: 'SO-93675',
    minutes: 75,
    push: { state: 'pushed', worklogId: 'gone' },
  });

  const day = detect.assembleDay({ dayKey: '2026-08-13', signals: [], jiraWorklogs: [], cfg });
  assert.equal(day.rows[0].push.state, 'failed');
  assert.match(day.rows[0].push.error, /Not in Jira on this day/);
});

test('a candidate for a ticket that already has Jira time warns about double-logging', () => {
  const day = detect.assembleDay({
    dayKey: '2026-08-13',
    signals: [signal('2026-08-13T17:18:00Z', 'SO-93675', 'SO-93675 more review')],
    jiraWorklogs: [{ worklogId: '21283', ticket: 'SO-93675', started: '2026-08-13T11:00:00.000-0500', minutes: 75, comment: 'Code review.' }],
    cfg,
  });

  const candidate = day.rows.find(r => r.kind === 'candidate');
  assert.equal(candidate.coveredByJiraMinutes, 75);
});

test('candidates are suggestions and do not count towards the logged total', () => {
  const day = detect.assembleDay({
    dayKey: '2026-08-13',
    signals: [signal('2026-08-13T17:18:00Z', 'SO-90816', 'SO-90816 work')],
    cfg,
  });
  assert.equal(day.totals.logged, 0);
  assert.equal(day.totals.suggested, 15);
});

test('signals outside the requested day never leak into it', () => {
  const day = detect.assembleDay({
    dayKey: '2026-08-13',
    signals: [
      signal('2026-08-13T17:18:00Z', 'SO-1', 'today'),
      signal('2026-08-14T17:18:00Z', 'SO-2', 'tomorrow'),
    ],
    cfg,
  });
  assert.equal(day.rows.length, 1);
  assert.equal(day.rows[0].ticket, 'SO-1');
});

const JIRA_DETAILS = {
  'SO-90816': { title: 'GA4 BYO: fetch + backfill for managed-SA rows', status: 'In Review', context: 'backfill managed-SA rows' },
};

test('a suggestion carries the ticket title and status from Jira', () => {
  const day = detect.assembleDay({
    dayKey: '2026-08-13',
    signals: [signal('2026-08-13T17:18:00Z', 'SO-90816', 'SO-90816 Enqueue the backfill')],
    cfg,
    ticketDetails: JIRA_DETAILS,
  });
  const row = day.rows.find(r => r.kind === 'candidate');
  assert.equal(row.title, 'GA4 BYO: fetch + backfill for managed-SA rows');
  assert.equal(row.status, 'in review');
});

test('time found only in Jira carries the ticket title too', () => {
  const day = detect.assembleDay({
    dayKey: '2026-08-13',
    signals: [],
    cfg,
    ticketDetails: JIRA_DETAILS,
    jiraWorklogs: [{ worklogId: '1', ticket: 'SO-90816', minutes: 60, started: '2026-08-13T09:00:00.000-0500', startedDate: '2026-08-13', comment: '' }],
  });
  assert.equal(day.rows[0].kind, 'jira');
  assert.equal(day.rows[0].title, 'GA4 BYO: fetch + backfill for managed-SA rows');
});

test('a field you rewrote on a kept line wins over Jira', () => {
  const entry = store.addEntry('2026-08-13', { ticket: 'SO-90816', minutes: 60, context: 'as suggested' });
  store.updateEntry('2026-08-13', entry.id, { context: 'my own words' });

  const day = detect.assembleDay({ dayKey: '2026-08-13', signals: [], cfg, ticketDetails: JIRA_DETAILS });
  const row = day.rows.find(r => r.kind === 'entry');
  assert.equal(row.context, 'my own words');
  // What you did not touch still follows Jira.
  assert.equal(row.title, 'GA4 BYO: fetch + backfill for managed-SA rows');
});
