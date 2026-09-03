const test = require('node:test');
const assert = require('node:assert/strict');

const timeline = require('../lib/initiativeTimeline');

function run(extra = {}) {
  return {
    name: 'A run',
    events: [
      { ts: '2026-09-03T10:00:00Z', type: 'started', detail: 'Supervisor took over' },
      { ts: '2026-09-03T10:01:00Z', type: 'auto-approved', detail: 'npm test' },
      { ts: '2026-09-03T10:01:30Z', type: 'auto-approved', detail: 'git status' },
      { ts: '2026-09-03T10:02:00Z', type: 'auto-approved', detail: 'git diff' },
      { ts: '2026-09-03T10:03:00Z', type: 'stage-done', detail: 'Plan complete', stageName: 'Plan' },
      { ts: '2026-09-03T10:04:00Z', type: 'gate-opened', detail: 'decision: which host?' },
      { ts: '2026-09-03T10:09:00Z', type: 'error', detail: 'Could not launch' },
    ],
    gates: [{
      id: 'g1', kind: 'decision', question: 'Which host should serve it?', options: ['A', 'B'],
      createdAt: '2026-09-03T10:04:00Z', resolvedAt: null, answer: null, reason: 'product call',
    }],
    ...extra,
  };
}

const turns = [
  { side: 'system', text: 'You are the orchestrator…', timestamp: '2026-09-03T10:00:30Z' },
  { side: 'you', text: 'how is it going?', timestamp: '2026-09-03T10:05:00Z', who: 'Orchestrator' },
  { side: 'orchestrator', text: 'Two stages done, waiting on you for the host.', timestamp: '2026-09-03T10:06:00Z', who: 'Orchestrator' },
];

test('the story is one chronological stream of the things that matter', () => {
  const entries = timeline.build(run(), turns);
  const order = entries.map(e => `${e.kind}${e.type ? `:${e.type}` : ''}`);

  assert.deepEqual(order, [
    'event:started',
    'event:stage-done',
    'gate',
    'you',
    'agent',
    'event:error',
  ]);
  assert.ok(!order.includes('event:auto-approved'), 'approving prompts is mechanical, not narrative');
});

test('the mechanical events are there when asked for, folded', () => {
  const all = timeline.build(run(), [], { detail: 'all' });
  const approved = all.find(e => e.type === 'auto-approved');
  assert.ok(approved, 'detail mode shows them');
  assert.equal(approved.count, 3, 'three approvals in a row is one thing that happened');
  assert.equal(approved.text, 'git diff', 'and it shows the most recent');
});

test('a gate arrives as an answerable card, not as two events', () => {
  const entries = timeline.build(run(), []);
  const gates = entries.filter(e => e.kind === 'gate');
  assert.equal(gates.length, 1);
  assert.equal(gates[0].open, true);
  assert.deepEqual(gates[0].options, ['A', 'B']);
  assert.ok(!entries.some(e => e.type === 'gate-opened'), 'the event would say it twice');
});

test('an answered gate shows what was decided', () => {
  const answered = run({
    gates: [{
      id: 'g1', kind: 'decision', question: 'Which host?', options: ['A'],
      createdAt: '2026-09-03T10:04:00Z', resolvedAt: '2026-09-03T10:07:00Z', answer: 'A', answeredBy: 'auto',
    }],
  });
  const gate = timeline.build(answered, []).find(e => e.kind === 'gate');
  assert.equal(gate.open, false);
  assert.equal(gate.answer, 'A');
  assert.equal(gate.answeredBy, 'auto');
});

test('supervisor traffic in the transcript is left out of the story', () => {
  const story = timeline.build(run(), turns);
  assert.ok(!story.some(e => e.kind === 'plumbing'), 'the events already say it');

  const all = timeline.build(run(), turns, { detail: 'all' });
  assert.ok(all.some(e => e.kind === 'plumbing'), 'but it is there when asked for');
  assert.ok(all.length > story.length);
});

test('detail mode adds the mechanical events without reordering anything', () => {
  const story = timeline.build(run(), []);
  const all = timeline.build(run(), [], { detail: 'all' });
  const times = xs => xs.map(e => Date.parse(e.at));
  for (const list of [story, all]) {
    const t = times(list);
    assert.deepEqual(t, [...t].sort((a, b) => a - b), 'chronological in both modes');
  }
});

test('errors and warnings never fold into a quiet run of events', () => {
  const noisy = run({
    events: [
      { ts: '2026-09-03T10:00:00Z', type: 'error', detail: 'first failure' },
      { ts: '2026-09-03T10:00:10Z', type: 'error', detail: 'second failure' },
    ],
    gates: [],
  });
  const errors = timeline.build(noisy, []).filter(e => e.type === 'error');
  assert.equal(errors.length, 2, 'two failures are two things to look at');
});

test('the operator\'s own messages come from the conversation, not the event log', () => {
  const withEvent = run({
    events: [{ ts: '2026-09-03T10:05:00Z', type: 'user-message', detail: '→ Orchestrator: how is it going?' }],
    gates: [],
  });
  const entries = timeline.build(withEvent, turns);
  assert.equal(entries.filter(e => e.kind === 'you').length, 1, 'said once, shown once');
});
