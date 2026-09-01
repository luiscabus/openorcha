const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-initiatives-test-'));
process.env.OPENORCHA_INITIATIVES_DIR = dir;

const store = require('../lib/initiativeStore');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function make(extra = {}) {
  return store.create({ name: 'Test initiative', goal: 'ship a thing', cwd: dir, ...extra });
}

test('create writes a normalized initiative with the default pipeline', () => {
  const initiative = make();
  assert.match(initiative.id, /^init-/);
  assert.equal(initiative.status, 'draft');
  assert.equal(initiative.profile, 'ship');
  assert.equal(initiative.stages.length, 6);
  assert.equal(initiative.stages[0].id, 'plan');
  assert.ok(fs.existsSync(path.join(dir, `${initiative.id}.json`)));
  assert.equal(initiative.events[0].type, 'created');
});

test('a verify command becomes the verify stage check', () => {
  const initiative = make({ verifyCommand: 'npm test' });
  const verify = initiative.stages.find(s => s.id === 'verify');
  assert.deepEqual(verify.check, { type: 'command', command: 'npm test' });
});

test('update leaves supervisor-owned state alone', () => {
  const initiative = make();
  store.openGate(initiative, { kind: 'decision', question: 'which way?' });
  store.save(initiative);

  const updated = store.update(initiative.id, { name: 'Renamed', gates: [], events: [], stats: null });
  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.gates.length, 1);
  assert.equal(updated.stats.gates, 1);
});

test('opening a gate blocks the run and resolving it unblocks', () => {
  const initiative = make();
  initiative.status = 'running';
  const gate = store.openGate(initiative, { kind: 'decision', question: 'push or not?', options: ['Push', 'Hold'] });
  assert.equal(initiative.status, 'blocked');
  assert.equal(store.openGates(initiative).length, 1);

  store.resolveGate(initiative, gate.id, 'Push');
  assert.equal(initiative.status, 'running');
  assert.equal(store.openGates(initiative).length, 0);
  assert.equal(initiative.gates[0].answeredBy, 'user');
});

test('auto-resolved gates are counted separately', () => {
  const initiative = make();
  initiative.status = 'running';
  const gate = store.openGate(initiative, { kind: 'agent-exited', question: 'relaunch?', defaultOption: 'Relaunch' });
  store.resolveGate(initiative, gate.id, 'Relaunch', 'auto');
  assert.equal(initiative.stats.autoDecided, 1);
});

test('advancing walks the pipeline and finishes on the last stage', () => {
  const initiative = make();
  initiative.status = 'running';
  for (let i = 0; i < 5; i++) {
    const next = store.advanceStage(initiative, 'check passed');
    assert.ok(next, `expected a stage after index ${i}`);
    assert.equal(next.status, 'active');
  }
  assert.equal(store.advanceStage(initiative, 'check passed'), null);
  assert.equal(initiative.status, 'done');
  assert.equal(initiative.stats.stagesCompleted, 6);
});

test('skipping a stage keeps the run moving', () => {
  const initiative = make();
  initiative.status = 'running';
  const next = store.skipStage(initiative, 'not needed');
  assert.equal(initiative.stages[0].status, 'skipped');
  assert.equal(next.id, 'branch');
});

test('the event log is capped', () => {
  const initiative = make();
  for (let i = 0; i < 450; i++) store.addEvent(initiative, 'nudge', `event ${i}`);
  const saved = store.save(initiative);
  assert.ok(saved.events.length <= 400);
  assert.match(saved.events[saved.events.length - 1].detail, /event 449/);
});

test('remove deletes the file and get returns null for unknown ids', () => {
  const initiative = make();
  assert.equal(store.remove(initiative.id), true);
  assert.equal(store.get(initiative.id), null);
  assert.equal(store.get('../../etc/passwd'), null);
});
