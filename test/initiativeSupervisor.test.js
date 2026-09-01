const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-supervisor-test-'));
process.env.OPENORCHA_INITIATIVES_DIR = dir;

const store = require('../lib/initiativeStore');
const supervisor = require('../lib/initiativeSupervisor');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function blockedInitiative(gate, ageMs) {
  const initiative = store.create({ name: 'Auto decide', cwd: dir, notifyOnGate: false, autoDecideAfterMs: 1000 });
  initiative.status = 'running';
  const entry = store.openGate(initiative, gate);
  entry.createdAt = new Date(Date.now() - ageMs).toISOString();
  return store.save(initiative);
}

test('a stale gate with a safe default is decided without you', async () => {
  const initiative = blockedInitiative(
    { kind: 'decision', question: 'keep going?', options: ['Stop the run', 'Keep going'], defaultOption: 'Stop the run' },
    60000,
  );

  await supervisor.tickOne(store.get(initiative.id));

  const after = store.get(initiative.id);
  assert.equal(after.gates[0].answeredBy, 'auto');
  assert.equal(after.gates[0].answer, 'Stop the run');
  assert.equal(after.status, 'paused');
  assert.equal(after.stats.autoDecided, 1);
});

test('a fresh gate is left alone', async () => {
  const initiative = blockedInitiative(
    { kind: 'decision', question: 'keep going?', options: ['Stop the run'], defaultOption: 'Stop the run' },
    0,
  );

  await supervisor.tickOne(store.get(initiative.id));

  const after = store.get(initiative.id);
  assert.equal(after.gates[0].resolvedAt, null);
  assert.equal(store.openGates(after).length, 1);
});

test('a gate with no safe default always waits for you', async () => {
  const initiative = blockedInitiative(
    { kind: 'decision', question: 'which naming?', options: ['A', 'B'], defaultOption: null },
    3600000,
  );

  await supervisor.tickOne(store.get(initiative.id));

  assert.equal(store.get(initiative.id).gates[0].resolvedAt, null);
});

test('answering "skip" moves the run to the next stage', () => {
  const initiative = store.create({ name: 'Skip me', cwd: dir, notifyOnGate: false });
  initiative.status = 'blocked';
  const gate = store.openGate(initiative, { kind: 'nudge-limit', question: 'stuck', options: ['Skip this stage'] });
  store.resolveGate(initiative, gate.id, 'Skip this stage');
  supervisor.applyGateAnswer(initiative, gate, 'Skip this stage');

  assert.equal(initiative.stages[0].status, 'skipped');
  assert.equal(store.currentStage(initiative).id, 'branch');
  assert.equal(initiative.status, 'running');
});

test('a run with no live agent parks a relaunch gate instead of idling', async () => {
  const initiative = store.create({ name: 'Ghost run', cwd: dir, notifyOnGate: false });
  initiative.status = 'running';
  initiative.run = { sessionName: 'openorcha-test-no-such-session', startedAt: new Date().toISOString() };
  store.save(initiative);

  await supervisor.tickOne(store.get(initiative.id));

  const after = store.get(initiative.id);
  const gate = store.openGates(after)[0];
  assert.ok(gate, 'expected a gate');
  assert.equal(gate.kind, 'agent-exited');
  assert.equal(gate.defaultOption, 'Relaunch');
  assert.equal(after.status, 'blocked');
});

test('the digest reports what moved and what is still waiting', () => {
  const digest = supervisor.buildDigest(new Date(Date.now() - 3600000).toISOString());
  assert.ok(digest.items.length >= 1);
  assert.ok(Number.isFinite(digest.totals.openGates));
  const ghost = digest.items.find(i => i.name === 'Ghost run');
  assert.equal(ghost.openGates.length, 1);
});

test('quiet hours and terminal states keep the supervisor out of the way', async () => {
  const initiative = store.create({ name: 'Done already', cwd: dir, notifyOnGate: false });
  initiative.status = 'done';
  store.save(initiative);
  assert.equal(await supervisor.tickOne(store.get(initiative.id)), null);
});
