const test = require('node:test');
const assert = require('node:assert/strict');

const orch = require('../lib/initiativeOrchestrator');

// A conversation and the supervisor's plumbing travel down the same pipe. If
// they cannot be told apart, the chat shows status updates as if you had said
// them, and your own words as if the machine had.

test("an operator's message is marked as theirs", () => {
  const marked = orch.operatorMessage('what did this run accomplish?');
  assert.match(marked, /^\[OpenOrcha · operator\]/);
  assert.equal(orch.classifyTurn('user', marked), 'you');
  assert.equal(orch.stripMarkers(marked), 'what did this run accomplish?');
});

test("the supervisor's own forms are recognised as plumbing", () => {
  const forms = [
    orch.updateNote('stage-done', 'Plan finished; now on Branch'),
    orch.updateNote('gate-opened', 'Which host should serve it?'),
    orch.decisionRequest({ work: { name: 'Verify' }, hasCheck: true, transcript: '' }),
    orch.openingBrief({ name: 'x', cwd: '/tmp', profile: 'ship', maxParallel: 1 }, [{ name: 'Plan', instruction: 'plan it' }]),
  ];
  for (const form of forms) {
    assert.equal(orch.classifyTurn('user', form), 'system', form.slice(0, 60));
  }
});

test('a message that merely starts with the prefix is still a person talking', () => {
  // Sent before the operator marker existed, and read as plumbing until the
  // classifier started matching the supervisor's actual shapes.
  const historical = "[OpenOrcha] we don't want to gate through env var DIRECTORY_CHILD_COUNT_ENABLED";
  assert.equal(orch.classifyTurn('user', historical), 'you');
  assert.equal(orch.classifyTurn('user', 'settle the three open items'), 'you');
});

test('a stage briefing meant for a worker is plumbing, not conversation', () => {
  assert.equal(orch.classifyTurn('user', '[OpenOrcha · SO-1 thing] Implement. Do the work.'), 'system');
});

test('a JSON decision is an answer to the supervisor, prose is an answer to you', () => {
  assert.equal(orch.classifyTurn('assistant', '{"action":"advance","reason":"the review is written"}'), 'system');
  assert.equal(orch.classifyTurn('assistant', '```json\n{"action":"gate","question":"which?"}\n```'), 'system');
  assert.equal(orch.classifyTurn('assistant', 'The biggest open risk is the total_count aggregation.'), 'orchestrator');
});

test('an empty turn is not shown as conversation', () => {
  assert.equal(orch.classifyTurn('assistant', ''), 'system');
  assert.equal(orch.classifyTurn('user', '   '), 'system');
});
