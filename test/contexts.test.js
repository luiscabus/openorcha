const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONTEXTS = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-board-contexts-'));
const WORKLOG = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-board-worklog-'));
process.env.OPENORCHA_CONTEXTS_DIR = CONTEXTS;
process.env.OPENORCHA_WORKLOG_DIR = WORKLOG;

const contexts = require('../lib/contexts');
const store = require('../lib/contextStore');
const workLog = require('../lib/workLogStore');

const CFG = { workTimezone: 'UTC', contexts: {} };

test.afterEach(() => {
  for (const dir of [CONTEXTS, WORKLOG]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
});

// One observation is a complete snapshot of the world, so anything open at
// that moment has to be in the same call — a key left out of it is a key that
// stopped being reported.
function open(keys, at, over = {}) {
  store.observe({
    commitments: [].concat(keys).map(key => ({
      provider: 'jira', key, kind: 'ticket', state: 'open', status: 'In Progress', ...over,
    })),
    providers: ['jira'],
    at,
  });
}

function worked(day, ticket, minutes, attention = 'coding') {
  workLog.addEntry(day, { ticket, minutes, attention, summary: 'did a thing' });
}

function row(board, key) {
  return board.rows.find(r => r.key === key);
}

// The two halves are collected in opposite directions and meet on the ticket:
// attention rebuilt out of the work log, open state recorded as it was seen.

test('a row carries both what a context is waiting for and what it has cost', () => {
  open('SO-1', '2026-09-08T09:00:00.000Z');
  worked('2026-09-08', 'SO-1', 90);
  worked('2026-09-09', 'SO-1', 60, 'reviewing');

  const board = contexts.board({ from: '2026-09-07', to: '2026-09-10', cfg: CFG });
  const found = row(board, 'SO-1');

  assert.equal(found.open, true);
  assert.equal(found.current.status, 'In Progress');
  assert.equal(found.minutes, 150);
  assert.equal(found.daysWorked, 2);
  assert.equal(found.lastTouched, '2026-09-09');
  assert.deepEqual(found.cells.map(c => c.minutes), [0, 90, 60, 0]);
  assert.deepEqual(found.byAttention, { coding: 90, reviewing: 60 });
});

test('a day before the context was first seen has no state, rather than a closed one', () => {
  open('SO-1', '2026-09-08T09:00:00.000Z');

  const board = contexts.board({ from: '2026-09-06', to: '2026-09-09', cfg: CFG });
  assert.deepEqual(row(board, 'SO-1').cells.map(c => c.state), [null, null, 'open', 'open']);
});

test('state carries forward through days nobody looked at, and the board says which those were', () => {
  open('SO-1', '2026-09-08T09:00:00.000Z');

  const board = contexts.board({ from: '2026-09-08', to: '2026-09-11', cfg: CFG });
  assert.deepEqual(row(board, 'SO-1').cells.map(c => c.state), ['open', 'open', 'open', 'open']);
  assert.deepEqual(board.observed, { '2026-09-08': 1 }, 'only one of those four days was actually observed');
});

// The whole point of putting the two halves on one line: where they disagree.
test('open and untouched outranks open and cold, which outranks what you are actually doing', () => {
  open(['SO-FORGOTTEN', 'SO-COLD', 'SO-LIVE'], '2026-09-01T09:00:00.000Z');
  worked('2026-09-02', 'SO-COLD', 30);
  worked('2026-09-10', 'SO-LIVE', 240);

  const board = contexts.board({ from: '2026-09-01', to: '2026-09-10', cfg: CFG });
  assert.deepEqual(board.rows.map(r => r.key), ['SO-FORGOTTEN', 'SO-COLD', 'SO-LIVE']);
  assert.equal(row(board, 'SO-COLD').coldDays, 8);
  assert.equal(row(board, 'SO-LIVE').coldDays, 0);
  assert.equal(row(board, 'SO-FORGOTTEN').coldDays, null, 'never touched at all');
});

test('work with no open state still gets a row — it predates the record, or nothing can see it', () => {
  worked('2026-09-08', 'SO-OLD', 45);

  const board = contexts.board({ from: '2026-09-07', to: '2026-09-09', cfg: CFG });
  const found = row(board, 'SO-OLD');
  assert.equal(found.open, false);
  assert.equal(found.current, null);
  assert.equal(found.minutes, 45);
});

test('ticketless work keeps its name as the key, the way the work log names it', () => {
  workLog.addEntry('2026-09-08', { label: 'local 503 debugging', minutes: 75, attention: 'debugging' });

  const board = contexts.board({ from: '2026-09-08', to: '2026-09-08', cfg: CFG });
  const found = row(board, 'local 503 debugging');
  assert.equal(found.kind, 'label');
  assert.equal(found.minutes, 75);
});

test('the totals count what is open and what has gone cold, not just hours', () => {
  open(['SO-1', 'SO-2'], '2026-09-01T09:00:00.000Z');
  worked('2026-09-10', 'SO-2', 120);

  const board = contexts.board({ from: '2026-09-01', to: '2026-09-10', cfg: CFG });
  assert.equal(board.totals.open, 2);
  assert.equal(board.totals.cold, 1, 'SO-2 was worked on today; SO-1 never was');
  assert.equal(board.totals.minutes, 120);
});

// ----------------------------------------------------------- going back

test('asking what was open on a day answers as of that day, with how near the nearest look was', () => {
  open('SO-1', '2026-09-01T09:00:00.000Z');
  store.observe({ commitments: [], providers: ['jira'], at: '2026-09-05T09:00:00.000Z' });

  const third = contexts.openOn('2026-09-03', { cfg: CFG });
  assert.deepEqual(third.contexts.map(c => c.key), ['SO-1']);
  assert.equal(third.coverage.covered, true);

  const sixth = contexts.openOn('2026-09-06', { cfg: CFG });
  assert.deepEqual(sixth.contexts, [], 'it had stopped being reported by then');
});

test('a day before anything was ever recorded returns nothing and admits it', () => {
  open('SO-1', '2026-09-10T09:00:00.000Z');

  const answer = contexts.openOn('2026-09-01', { cfg: CFG });
  assert.deepEqual(answer.contexts, []);
  assert.equal(answer.coverage.covered, false, 'not "nothing was open" — nobody looked');
  assert.ok(answer.coverage.minutesAfter > 0);
});

test('one context can be read whole: every state it was in, and every day it took', () => {
  open('SO-1', '2026-09-08T09:00:00.000Z', { title: 'Count the children' });
  open('SO-1', '2026-09-09T09:00:00.000Z', { status: 'In Review', title: 'Count the children' });
  worked('2026-09-08', 'SO-1', 90);

  const found = contexts.history('SO-1', { cfg: CFG });
  assert.deepEqual(found.record.transitions.map(t => t.status), ['In Progress', 'In Review']);
  assert.equal(found.attention.minutes, 90);
  assert.deepEqual(found.attention.days.map(d => d.day), ['2026-09-08']);
  assert.equal(contexts.history('SO-NOTHING', { cfg: CFG }), null);
});

test('a key is the ticket where there is one, so both halves file under the same name', () => {
  assert.equal(contexts.keyOf({ ticket: 'so-1', label: 'whatever' }), 'SO-1');
  assert.equal(contexts.keyOf({ ticket: null, label: 'local 503 debugging' }), 'local 503 debugging');
  assert.equal(contexts.keyOf({}), null);
});

test('a look is skipped when the last one is recent, and forced when it is asked for', async () => {
  const recent = { ...CFG, contexts: { observeEveryMinutes: 60, sources: {} } };
  assert.equal(contexts.dueForObservation(recent), true, 'nothing recorded yet');

  store.observe({ commitments: [], providers: ['jira'], at: new Date().toISOString() });
  assert.equal(contexts.dueForObservation(recent), false);

  const skipped = await contexts.record({ cfg: recent });
  assert.equal(skipped.skipped, true);
});
