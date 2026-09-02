const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const orch = require('../lib/initiativeOrchestrator');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-orch-test-'));
process.env.OPENORCHA_INITIATIVES_DIR = dir;
process.env.OPENORCHA_NO_LAUNCH = '1';
const store = require('../lib/initiativeStore');
const supervisor = require('../lib/initiativeSupervisor');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// ─── What it is told ─────────────────────────────────────────────────────────

test('the opening brief gives it the run and forbids it doing the work', () => {
  const initiative = store.normalize({
    name: 'SO-92393 PDFs', ticket: 'SO-92393', goal: 'validate the spec', cwd: dir,
    profile: 'standard', maxParallel: 3,
    acceptance: [{ text: 'review written', check: { type: 'file-exists', path: 'r.md' } }, { text: 'tickets exist', check: { type: 'human' } }],
  });
  const brief = orch.openingBrief(initiative, initiative.stages);

  assert.match(brief, /SO-92393/);
  assert.match(brief, /validate the spec/);
  assert.match(brief, /up to 3 worker agents/);
  assert.match(brief, /review written/);
  assert.match(brief, /needs the operator/, 'human criteria are flagged as the operator\'s');
  assert.match(brief, /do not run commands/i, 'it has no hands and is told so');
  assert.match(brief, /\{"action":"continue"/, 'and knows how to answer');
});

test('a stage with no check is described as needing judgement, not left blank', () => {
  const initiative = store.normalize({ name: 'x', cwd: dir, template: 'spec-to-tickets' });
  const brief = orch.openingBrief(initiative, initiative.stages);
  assert.match(brief, /no automatic check/);
});

test('a decision request carries the check state and the worker transcript', () => {
  const withCheck = orch.decisionRequest({
    work: { name: 'Verify', check: { type: 'command', command: 'npm test' } },
    workerName: 'Verify', checkDetail: 'npm test exited 1', transcript: 'WORKER: two tests fail', hasCheck: true,
  });
  assert.match(withCheck, /npm test exited 1/);
  assert.match(withCheck, /two tests fail/);

  const without = orch.decisionRequest({
    work: { name: 'Read the ground truth', check: null }, hasCheck: false, transcript: 'WORKER: done reading',
  });
  assert.match(without, /no automatic check/);
  assert.match(without, /judge from what the worker has done/);
});

// ─── What it says back ───────────────────────────────────────────────────────

test('a decision is read out of ordinary prose', () => {
  assert.deepEqual(orch.extractDecision('Sure thing.\n{"action":"advance","reason":"the review is written"}'),
    { action: 'advance', reason: 'the review is written' });
  assert.deepEqual(orch.extractDecision('```json\n{"action":"gate","question":"which host?","options":["a","b"]}\n```').action, 'gate');
});

test('a usable message with a mangled action is taken as continue', () => {
  const d = orch.extractDecision('{"action":"proceed","message":"quote the redirect handler"}');
  assert.equal(d.action, 'continue');
  assert.equal(d.message, 'quote the redirect handler');
});

test('prose with no decision in it is not invented into one', () => {
  assert.equal(orch.extractDecision('I think we should probably keep going.'), null);
  assert.equal(orch.extractDecision(''), null);
  assert.equal(orch.extractDecision('{not json at all'), null);
});

// ─── How the run treats it ───────────────────────────────────────────────────

test('the orchestrator is never given stage work', () => {
  const initiative = store.normalize({
    name: 'roles', cwd: dir,
    workers: [
      { id: 'o', name: 'Orchestrator', role: 'orchestrator', sessionName: 'o', status: 'working' },
      { id: 'w', name: 'Implement', sessionName: 'w', status: 'working' },
    ],
  });
  assert.deepEqual(store.activeWorkers(initiative).map(w => w.name), ['Implement']);
  assert.equal(store.orchestrator(initiative).name, 'Orchestrator');
});

test('an initiative that does not want one never gets one', async () => {
  const initiative = store.create({ name: 'No boss', cwd: dir, notifyOnGate: false });
  assert.equal(initiative.useOrchestrator, false);
  assert.equal(await supervisor.ensureOrchestrator(initiative, { agents: [], procs: {} }), false);
  assert.equal(store.orchestrator(initiative), null);
});

test('one that does is honest about being unable to launch under the guard', async () => {
  const initiative = store.create({ name: 'Wants a boss', cwd: dir, useOrchestrator: true, notifyOnGate: false });
  assert.equal(initiative.useOrchestrator, true);
  assert.equal(await supervisor.ensureOrchestrator(initiative, { agents: [], procs: {} }), false);

  const after = store.get(initiative.id);
  assert.ok(after.events.some(e => /Orchestrator launch suppressed/.test(e.detail)));
  assert.equal(store.orchestrator(after), null, 'and no phantom orchestrator is recorded');
});

test('asking an initiative with no orchestrator says so rather than hanging', async () => {
  const initiative = store.create({ name: 'Nobody home', cwd: dir, notifyOnGate: false });
  const result = await supervisor.askOrchestrator(initiative, { name: 'stage' }, [], '', 'worker');
  assert.equal(result.failure, 'no orchestrator running');
});

test('updates are short and say no reply is needed', () => {
  const note = orch.updateNote('stage-done', 'Read the ground truth finished; now on Challenge it');
  assert.match(note, /Stage finished/);
  assert.match(note, /No reply needed/);
  assert.ok(note.length < 500, 'an update should not cost a page of context');
});
