const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-contexts-'));
process.env.OPENORCHA_CONTEXTS_DIR = TMP;

const store = require('../lib/contextStore');

test.afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

function commitment(over = {}) {
  return {
    provider: 'jira',
    key: 'SO-1',
    kind: 'ticket',
    title: 'Count the children',
    context: 'pages need a child count at every level',
    state: 'open',
    status: 'In Progress',
    detail: 'Assigned to you',
    ...over,
  };
}

// Open state is the one thing here that cannot be rebuilt afterwards, so what
// is written down is the whole of the history.

test('a context is recorded the first time anything reports it', () => {
  store.observe({ commitments: [commitment()], providers: ['jira'], at: '2026-09-01T10:00:00.000Z' });

  const record = store.readRecord('SO-1');
  assert.equal(record.title, 'Count the children');
  assert.equal(record.context, 'pages need a child count at every level');
  assert.equal(record.transitions.length, 1);
  assert.equal(record.transitions[0].state, 'open');
  assert.equal(record.transitions[0].status, 'In Progress');
});

test('an unchanged look adds no line, so the three moments that mattered stay visible', () => {
  for (const at of ['2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z', '2026-09-01T12:00:00.000Z']) {
    store.observe({ commitments: [commitment()], providers: ['jira'], at });
  }
  assert.equal(store.readRecord('SO-1').transitions.length, 1);

  store.observe({
    commitments: [commitment({ status: 'In Review' })],
    providers: ['jira'],
    at: '2026-09-02T10:00:00.000Z',
  });
  const record = store.readRecord('SO-1');
  assert.equal(record.transitions.length, 2);
  assert.equal(record.transitions[1].status, 'In Review');
});

test('detail moves on its own without manufacturing a transition', () => {
  store.observe({ commitments: [commitment()], providers: ['jira'], at: '2026-09-01T10:00:00.000Z' });
  store.observe({
    commitments: [commitment({ detail: 'Assigned to you · 3 commits ahead' })],
    providers: ['jira'],
    at: '2026-09-01T11:00:00.000Z',
  });

  const record = store.readRecord('SO-1');
  assert.equal(record.transitions.length, 1);
  assert.equal(record.transitions[0].detail, 'Assigned to you · 3 commits ahead', 'but the latest wording is kept');
});

test('a context that stops being reported is gone, which is not the same claim as done', () => {
  store.observe({ commitments: [commitment()], providers: ['jira'], at: '2026-09-01T10:00:00.000Z' });
  store.observe({ commitments: [], providers: ['jira'], at: '2026-09-02T10:00:00.000Z' });

  const transitions = store.readRecord('SO-1').transitions;
  assert.equal(transitions.length, 2);
  assert.equal(transitions[1].state, 'gone');
});

test('a provider saying so outright is recorded as done', () => {
  store.observe({ commitments: [commitment()], providers: ['jira'], at: '2026-09-01T10:00:00.000Z' });
  store.observe({
    commitments: [commitment({ state: 'done', status: 'Closed' })],
    providers: ['jira'],
    at: '2026-09-02T10:00:00.000Z',
  });

  const last = store.readRecord('SO-1').transitions.at(-1);
  assert.equal(last.state, 'done');
  assert.equal(last.status, 'Closed');
});

// The failure that would quietly destroy the record: a provider that cannot
// answer reports nothing, which looks exactly like reporting that nothing is
// open. Closing a day's whole backlog because Jira was down is unrecoverable.
test('a provider that did not answer cannot close the contexts only it can see', () => {
  store.observe({ commitments: [commitment()], providers: ['jira'], at: '2026-09-01T10:00:00.000Z' });
  const { observation } = store.observe({
    commitments: [],
    providers: ['github'],
    errors: [{ provider: 'jira', error: 'connect ETIMEDOUT' }],
    at: '2026-09-02T10:00:00.000Z',
  });

  assert.equal(store.readRecord('SO-1').transitions.length, 1, 'still open, still unresolved');
  assert.deepEqual(observation.unverified, ['SO-1']);
  assert.equal(observation.errors[0].provider, 'jira');
});

test('two providers on one key fold into one state, keeping the authoritative wording', () => {
  store.observe({
    commitments: [
      commitment(),
      commitment({ provider: 'github', status: 'PR open', detail: 'soci#37108 — waiting on your review', title: null, context: null }),
    ],
    providers: ['jira', 'github'],
    at: '2026-09-01T10:00:00.000Z',
  });

  const current = store.readRecord('SO-1').transitions[0];
  assert.equal(current.status, 'In Progress', 'Jira owns the workflow word');
  assert.deepEqual(current.by, ['github', 'jira']);
  assert.match(current.detail, /waiting on your review/);
});

test('a later blank read never erases a title or a subject we already have', () => {
  store.observe({ commitments: [commitment()], providers: ['jira'], at: '2026-09-01T10:00:00.000Z' });
  store.observe({
    commitments: [commitment({ provider: 'git', title: null, context: null, status: 'unpushed commits' })],
    providers: ['git'],
    at: '2026-09-02T10:00:00.000Z',
  });

  const record = store.readRecord('SO-1');
  assert.equal(record.title, 'Count the children');
  assert.equal(record.context, 'pages need a child count at every level');
});

// ------------------------------------------------------------- going back

test('a context has no state before anything had seen it, which is not closed', () => {
  store.observe({ commitments: [commitment()], providers: ['jira'], at: '2026-09-10T10:00:00.000Z' });
  const record = store.readRecord('SO-1');

  assert.equal(store.stateAt(record, '2026-09-01T00:00:00.000Z'), null);
  assert.equal(store.wasOpenAt(record, '2026-09-01T00:00:00.000Z'), false);
  assert.equal(store.wasOpenAt(record, '2026-09-11T00:00:00.000Z'), true);
});

test('what was open on a past day is the state as it stood then, not as it stands now', () => {
  store.observe({ commitments: [commitment()], providers: ['jira'], at: '2026-09-01T10:00:00.000Z' });
  store.observe({
    commitments: [commitment({ key: 'SO-2' })],
    providers: ['jira'],
    at: '2026-09-05T10:00:00.000Z',
  });

  assert.deepEqual(store.openAt('2026-09-03T23:59:59.000Z').map(r => r.key), ['SO-1']);
  assert.deepEqual(store.openAt('2026-09-06T23:59:59.000Z').map(r => r.key), ['SO-2'], 'SO-1 went unreported and closed');
});

test('a question about a day nobody looked at says so rather than answering confidently', () => {
  store.observe({ commitments: [commitment()], providers: ['jira'], at: '2026-09-10T10:00:00.000Z' });

  const early = store.nearestObservation('2026-09-01T00:00:00.000Z');
  assert.equal(early.covered, false);
  assert.equal(early.before, null);
  assert.ok(early.minutesAfter > 0, 'and how long until someone did look');

  const later = store.nearestObservation('2026-09-11T00:00:00.000Z');
  assert.equal(later.covered, true);
  assert.ok(later.minutesBefore > 0);
});

test('a label key survives the trip through a filename without colliding', () => {
  const first = 'local 503 debugging';
  const second = 'local 503 debugging!';
  assert.notEqual(store.slugFor(first), store.slugFor(second));
  assert.equal(store.slugFor('SO-1234'), 'SO-1234');

  store.observe({
    commitments: [commitment({ key: first, kind: 'label', title: first })],
    providers: ['git'],
    at: '2026-09-01T10:00:00.000Z',
  });
  assert.equal(store.readRecord(first).key, first);
});
