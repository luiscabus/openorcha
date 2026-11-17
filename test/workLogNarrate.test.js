const test = require('node:test');
const assert = require('node:assert/strict');

const narrate = require('../lib/workLogNarrate');

const cfg = { workTimezone: 'America/Chicago' };

function candidate(overrides = {}) {
  return {
    candidateKey: '2026-08-31|SO-96061',
    date: '2026-08-31',
    ticket: 'SO-96061',
    minutes: 60,
    startTime: '12:45',
    summary: 'mechanical text',
    sourceCounts: { git: 3, sessions: 12 },
    signals: [
      { source: 'git', wall: '12:45', text: 'Cover the provisioning hooks with unit tests' },
      { source: 'sessions', wall: '12:46', text: 'Implement Jira ticket SO-96061 in the monolith' },
    ],
    ...overrides,
  };
}

test('the reply is read whether or not it arrives in a code fence', () => {
  assert.deepEqual(narrate.extractJson('{"blocks":[]}'), { blocks: [] });
  assert.deepEqual(narrate.extractJson('```json\n{"blocks":[]}\n```'), { blocks: [] });
  assert.deepEqual(narrate.extractJson('here you go:\n{"blocks":[]}\nhope that helps'), { blocks: [] });
});

test('a reply that is not JSON yields nothing rather than throwing', () => {
  assert.equal(narrate.extractJson('I could not do that'), null);
  assert.equal(narrate.extractJson(''), null);
});

test('repeated session text is collapsed before it reaches the model', () => {
  // A day carries one signal per message timestamp, all sharing the session's
  // first prompt. Sending hundreds of copies would be pure waste.
  const repeated = Array.from({ length: 200 }, (_, i) => ({
    source: 'sessions',
    wall: '12:45',
    text: 'check the review comments on the two PRs',
    ref: `sess/${i}`,
  }));

  const compacted = narrate.compactCandidate(candidate({ signals: repeated }), 'America/Chicago');
  const evidenceLines = compacted.split('\n').filter(l => l.includes('[sessions'));
  assert.equal(evidenceLines.length, 1);
});

test('evidence is capped so one busy block cannot dominate the prompt', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({
    source: 'git', wall: '12:45', text: `distinct commit subject number ${i}`,
  }));
  const compacted = narrate.compactCandidate(candidate({ signals: many }), 'America/Chicago');
  assert.ok(compacted.split('\n').filter(l => l.includes('[git')).length <= 18);
});

test('a block with no ticket asks for a name instead of accepting a blank', () => {
  const compacted = narrate.compactCandidate(candidate({ ticket: null }), 'America/Chicago');
  assert.match(compacted, /needs a short effort name/);
});

test('the prompt asks for both audiences and lists the allowed kinds', () => {
  const prompt = narrate.buildPrompt('2026-08-31', [candidate()], cfg);
  assert.match(prompt, /summary —/);
  assert.match(prompt, /note {4}—/);
  assert.match(prompt, /Jira worklog comment/);
  for (const kind of narrate.DEFAULT_KINDS) {
    assert.ok(prompt.includes(kind), `prompt should offer the "${kind}" kind`);
  }
});

test('the prompt tells the model not to read every session as prompting', () => {
  // Nearly all this work is agent-driven, so without this the classifier
  // labels the whole week "prompting" and the breakdown says nothing.
  const prompt = narrate.buildPrompt('2026-08-31', [candidate()], cfg);
  assert.match(prompt, /not evidence of "prompting"/);
  assert.match(prompt, /"coding" even when an agent typed it/);
});

test('the kinds are configurable, because the list is not closed', () => {
  assert.deepEqual(narrate.kinds({ attentionKinds: ['making', 'checking'] }), ['making', 'checking']);
  assert.deepEqual(narrate.kinds({ attentionKinds: [] }), narrate.DEFAULT_KINDS);
  assert.deepEqual(narrate.kinds({}), narrate.DEFAULT_KINDS);
});

test('narration is skipped without calling out when it is switched off', async () => {
  const result = await narrate.narrateDay({
    dayKey: '2026-08-31',
    candidates: [candidate()],
    cfg: { ...cfg, narrate: false },
  });
  assert.deepEqual(result.byKey, {});
  assert.equal(result.skipped, 'disabled');
  assert.equal(result.error, null);
});

test('a day with nothing in it never reaches the model', async () => {
  const result = await narrate.narrateDay({ dayKey: '2026-08-31', candidates: [], cfg });
  assert.equal(result.skipped, 'empty');
});

test('your own earlier posts go into the prompt as the style to match', () => {
  const prompt = narrate.buildPrompt('2026-09-22', [], { workTimezone: 'UTC' }, [
    { date: '2026-09-21', text: '```\n2026-09-21\n\n- SO-1 Thing (live)\n  - shipped it\n```' },
  ]);
  assert.match(prompt, /- SO-1 Thing \(live\)/);
  assert.match(prompt, /never from these posts/);
  assert.doesNotMatch(prompt.split('Blocks:')[0], /```/);
});

test('without earlier posts the prompt carries no style section', () => {
  const prompt = narrate.buildPrompt('2026-09-22', [], { workTimezone: 'UTC' });
  assert.doesNotMatch(prompt, /How this person actually writes/);
});
