const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-delegation-test-'));
const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-elsewhere-'));
process.env.OPENORCHA_INITIATIVES_DIR = dir;
process.env.OPENORCHA_ASSIGNMENTS_DIR = path.join(dir, 'assignments');
// Never start a real agent from a test run.
process.env.OPENORCHA_NO_LAUNCH = '1';

const store = require('../lib/initiativeStore');
const supervisor = require('../lib/initiativeSupervisor');

test.after(() => {
  for (const d of [dir, elsewhere]) fs.rmSync(d, { recursive: true, force: true });
});

function run(over = {}) {
  const initiative = store.create({ name: 'SO-1 discovery', cwd: dir, notifyOnGate: false, ...over });
  initiative.status = 'running';
  return store.save(initiative);
}

function worker(initiative, over = {}) {
  const entry = store.addWorker(initiative, {
    name: 'Discovery', sessionName: 'init-discovery', agentId: 'claude', cwd: dir, ...over,
  });
  store.save(initiative);
  return entry;
}

// A run turns up work that belongs to another project. The agent that noticed it
// was briefed on something else entirely, and is the one thing that must not be
// asked to do it.

test('work in another project becomes a gate, not an instruction to the worker who found it', async () => {
  const initiative = run();
  const found = worker(initiative);

  await supervisor.delegateWork(store.get(initiative.id), found, {
    directory: elsewhere,
    task: 'fix the landmark scan in the tooling',
    reason: 'not this run’s repo',
  });

  const after = store.get(initiative.id);
  const gate = store.openGates(after)[0];
  assert.equal(gate.kind, 'delegate');
  assert.equal(gate.delegate.directory, elsewhere);
  assert.match(gate.delegate.task, /landmark scan/);
  assert.equal(gate.delegate.fromWorkerId, found.id);
  assert.equal(gate.defaultOption, 'Not now', 'left alone, nothing is started');
  assert.match(gate.context, /never briefed/);
  assert.equal((after.workers || []).filter(w => w.role === 'delegate').length, 0);
});

test('the same delegation twice does not open a second gate', async () => {
  const initiative = run();
  const found = worker(initiative);
  const ask = { directory: elsewhere, task: 'same thing', reason: 'x' };

  await supervisor.delegateWork(store.get(initiative.id), found, ask);
  await supervisor.delegateWork(store.get(initiative.id), found, ask);

  assert.equal(store.openGates(store.get(initiative.id)).length, 1);
});

test('a delegation that names nowhere to go asks rather than guessing', async () => {
  const initiative = run();
  const found = worker(initiative);

  await supervisor.delegateWork(store.get(initiative.id), found, { reason: 'something is wrong elsewhere' });

  const gate = store.openGates(store.get(initiative.id))[0];
  assert.equal(gate.kind, 'decision');
  assert.match(gate.question, /did not say where or what/);
});

test('a directory that does not exist is not somewhere to start an agent', async () => {
  const initiative = run();
  const found = worker(initiative);

  await supervisor.delegateWork(store.get(initiative.id), found, {
    directory: path.join(os.tmpdir(), 'openorcha-does-not-exist'),
    task: 'do a thing',
  });

  assert.equal(store.openGates(store.get(initiative.id))[0].kind, 'decision');
});

test('work inside the run’s own directory is still the run’s, and needs no permission', async () => {
  const initiative = run();
  const found = worker(initiative);

  await supervisor.delegateWork(store.get(initiative.id), found, {
    directory: path.join(dir, 'sub'),
    task: 'tidy the fixtures',
  });
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  await supervisor.delegateWork(store.get(initiative.id), found, {
    directory: path.join(dir, 'sub'),
    task: 'tidy the fixtures',
  });

  const after = store.get(initiative.id);
  assert.equal(store.openGates(after).some(g => g.kind === 'delegate'), false);
  assert.ok(
    (after.events || []).some(e => /Delegate launch suppressed/.test(e.detail || '')),
    'it went to launch rather than to a gate',
  );
});

test('declining the gate starts nothing and says so', () => {
  const initiative = run();
  const found = worker(initiative);
  const gate = store.openGate(initiative, {
    kind: 'delegate',
    question: 'start one?',
    options: ['Start an agent there', 'Not now'],
    delegate: { directory: elsewhere, task: 'a thing', fromWorkerId: found.id },
  });
  store.save(initiative);

  supervisor.applyGateAnswer(initiative, gate, 'Not now');

  assert.equal((initiative.workers || []).filter(w => w.role === 'delegate').length, 0);
  assert.ok((initiative.events || []).some(e => e.type === 'delegate-declined'));
  assert.equal(initiative.status, 'running');
});

// ─── Who a message reaches ───────────────────────────────────────────────────

test('a delegate takes no part in the stages it was never on', () => {
  const initiative = run();
  worker(initiative);
  store.addWorker(initiative, { name: 'Delegate: x', role: 'delegate', sessionName: 'deleg-x', cwd: elsewhere });
  store.save(initiative);

  const active = store.activeWorkers(store.get(initiative.id));
  assert.deepEqual(active.map(w => w.name), ['Discovery']);
  assert.deepEqual(store.delegates(store.get(initiative.id)).map(w => w.name), ['Delegate: x']);
});

// The shape of the original failure: a message with no named addressee finding
// its way to whichever agent happened to be first in the list.
test('with nobody named, only a stage worker can be found — never the orchestrator or a delegate', () => {
  const initiative = run();
  store.addWorker(initiative, { name: 'Orchestrator', role: 'orchestrator', sessionName: 'orch-1', cwd: dir });
  store.addWorker(initiative, { name: 'Delegate: x', role: 'delegate', sessionName: 'deleg-1', cwd: elsewhere });
  store.save(initiative);

  const snapshot = {
    agents: [
      { pid: 999001, session: 'orch-1', agentId: 'claude', cpu: 0 },
      { pid: 999002, session: 'deleg-1', agentId: 'claude', cpu: 0 },
    ],
    procs: {},
  };

  const saved = store.get(initiative.id);
  assert.equal(supervisor.findAgent(saved, snapshot), null, 'neither is an answer to "whoever is around"');

  const orchestrator = store.orchestrator(saved);
  assert.equal(
    supervisor.findAgent(saved, snapshot, { workerId: orchestrator.id })?.workerId,
    orchestrator.id,
    'but naming it still reaches it',
  );
});
