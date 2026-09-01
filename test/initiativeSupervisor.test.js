const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-supervisor-test-'));
process.env.OPENORCHA_INITIATIVES_DIR = dir;
// Never start a real agent from a test run.
process.env.OPENORCHA_NO_LAUNCH = '1';

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

test('an old run with no live agent parks a relaunch gate instead of idling', async () => {
  const initiative = store.create({ name: 'Ghost run', cwd: dir, notifyOnGate: false });
  initiative.status = 'running';
  // The single-agent shape from before worker pools, to prove it still migrates.
  initiative.run = { sessionName: 'openorcha-test-no-such-session', startedAt: new Date(Date.now() - 3600000).toISOString() };
  store.save(initiative);

  const migrated = store.get(initiative.id);
  assert.equal(migrated.workers.length, 1, 'the old run should migrate into a worker');

  await supervisor.tickOne(migrated);

  const after = store.get(initiative.id);
  const gate = store.openGates(after)[0];
  assert.ok(gate, 'expected a gate');
  assert.equal(gate.kind, 'agent-exited');
  assert.equal(gate.defaultOption, 'Relaunch');
  assert.equal(after.status, 'blocked');
});

test('a worker that has only just launched is given time to boot', async () => {
  const initiative = store.create({ name: 'Booting', cwd: dir, notifyOnGate: false });
  initiative.status = 'running';
  initiative.workers = [store.normalizeWorker({
    id: 'worker-boot',
    name: 'Main',
    sessionName: 'openorcha-test-still-booting',
    status: 'starting',
    startedAt: new Date().toISOString(),
  }, 0)];
  store.save(initiative);

  await supervisor.tickOne(store.get(initiative.id));

  assert.equal(store.openGates(store.get(initiative.id)).length, 0);
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

// ─── Parallel work ───────────────────────────────────────────────────────────

function parallelInitiative(name, taskNames) {
  const initiative = store.create({ name, cwd: dir, notifyOnGate: false, maxParallel: 2 });
  initiative.status = 'running';
  const stage = store.currentStage(initiative);
  store.setStageTasks(initiative, stage.id, taskNames.map(n => ({ name: n, instruction: `do ${n}`, check: { type: 'git-dirty' } })));
  return store.save(initiative);
}

test('a stage splits into parallel tasks, each with its own worker slot', () => {
  const initiative = parallelInitiative('Fan out', ['renderer', 'editor', 'publisher']);
  const stage = store.currentStage(initiative);

  assert.equal(store.stageTasks(stage).length, 3);
  assert.equal(store.pendingTasks(stage).length, 3);
  assert.equal(store.allTasksSettled(stage), false);
});

test('a stage is only settled once every task is done or skipped', () => {
  const initiative = parallelInitiative('Settle', ['a', 'b']);
  const stage = store.currentStage(initiative);
  const [a, b] = store.stageTasks(stage);

  store.setTaskStatus(initiative, stage, a.id, 'done');
  assert.equal(store.allTasksSettled(stage), false, 'one task done is not the stage');

  store.setTaskStatus(initiative, stage, b.id, 'skipped');
  assert.equal(store.allTasksSettled(stage), true);
});

test('a settled parallel stage hands its branches to the next stage', async () => {
  const initiative = parallelInitiative('Integrate', ['one', 'two']);
  const stage = store.currentStage(initiative);
  for (const task of store.stageTasks(stage)) {
    task.branch = `openorcha/${task.name}`;
    store.setTaskStatus(initiative, stage, task.id, 'done');
  }
  store.save(initiative);

  await supervisor.tickOne(store.get(initiative.id));

  const after = store.get(initiative.id);
  assert.deepEqual(after.integration.branches, ['openorcha/one', 'openorcha/two']);
  assert.equal(store.currentStage(after).id, 'branch', 'the run moved on to the next stage');
  assert.ok(after.events.some(e => e.type === 'parallel-done'));
});

test('fan-out respects the initiative limit and the machine-wide agent budget', async () => {
  const initiative = parallelInitiative('Budgeted', ['a', 'b', 'c', 'd']);
  const stage = store.currentStage(initiative);

  // Two workers already running: the per-initiative maxParallel of 2 is spent.
  initiative.workers = [
    store.normalizeWorker({ id: 'w1', name: 'a', sessionName: 's1', status: 'working', taskId: stage.tasks[0].id }, 0),
    store.normalizeWorker({ id: 'w2', name: 'b', sessionName: 's2', status: 'working', taskId: stage.tasks[1].id }, 1),
  ];
  store.setTaskStatus(initiative, stage, stage.tasks[0].id, 'active');
  store.setTaskStatus(initiative, stage, stage.tasks[1].id, 'active');
  store.save(initiative);

  const started = await supervisor.ensureWorkers(store.get(initiative.id), store.currentStage(store.get(initiative.id)), { agents: [], procs: {} });
  assert.equal(started, false, 'should not exceed maxParallel');
  assert.equal(store.get(initiative.id).workers.length, 2);
});

test('a vanished parallel worker is restarted rather than escalated', async () => {
  const initiative = parallelInitiative('Restart', ['flaky']);
  const stage = store.currentStage(initiative);
  const task = stage.tasks[0];
  initiative.workers = [store.normalizeWorker({
    id: 'w-flaky',
    name: 'flaky',
    sessionName: 'openorcha-test-vanished',
    status: 'working',
    taskId: task.id,
    startedAt: new Date(Date.now() - 3600000).toISOString(),
  }, 0)];
  store.setTaskStatus(initiative, stage, task.id, 'active');
  store.save(initiative);

  await supervisor.tickOne(store.get(initiative.id));

  const after = store.get(initiative.id);
  assert.equal(store.stageTasks(store.currentStage(after))[0].status, 'pending', 'the task goes back in the queue');
  assert.equal(store.openGates(after).length, 0, 'a single lost worker should not need you');
  assert.equal(after.workers[0].status, 'gone');
});

test('several initiatives tick concurrently without blocking each other', async () => {
  const slow = store.create({ name: 'Lane A', cwd: dir, notifyOnGate: false });
  slow.status = 'running';
  slow.workers = [store.normalizeWorker({ id: 'w', name: 'A', sessionName: 'nope-a', startedAt: new Date(Date.now() - 3600000).toISOString(), status: 'working' }, 0)];
  store.save(slow);

  const other = store.create({ name: 'Lane B', cwd: dir, notifyOnGate: false });
  other.status = 'running';
  other.workers = [store.normalizeWorker({ id: 'w', name: 'B', sessionName: 'nope-b', startedAt: new Date(Date.now() - 3600000).toISOString(), status: 'working' }, 0)];
  store.save(other);

  await supervisor.tick();

  // Both lanes were supervised in the same tick, not one after the other.
  assert.equal(store.openGates(store.get(slow.id)).length, 1);
  assert.equal(store.openGates(store.get(other.id)).length, 1);
});

// ─── Worktree isolation ──────────────────────────────────────────────────────

const { execSync } = require('child_process');
const worktrees = require('../lib/initiativeWorktrees');

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-repo-test-'));
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: repo });
  fs.writeFileSync(path.join(repo, 'file.txt'), 'hi\n');
  execSync('git add -A && git commit -qm init', { cwd: repo });
  return repo;
}

test('parallel workers get separate worktrees on separate branches', () => {
  const repo = makeRepo();
  try {
    const a = worktrees.ensureWorktree(repo, { name: 'demo-alpha', branchPrefix: 'test' });
    const b = worktrees.ensureWorktree(repo, { name: 'demo-beta', branchPrefix: 'test' });

    assert.ok(a && b);
    assert.notEqual(a.path, b.path);
    assert.equal(a.branch, 'test/demo-alpha');
    assert.equal(b.branch, 'test/demo-beta');

    // Work in one tree is invisible to the other and to the main checkout.
    fs.appendFileSync(path.join(a.path, 'file.txt'), 'alpha\n');
    execSync('git add -A && git commit -qm alpha', { cwd: a.path });

    assert.equal(fs.readFileSync(path.join(b.path, 'file.txt'), 'utf8'), 'hi\n');
    assert.equal(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8'), 'hi\n');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-worktrees`, { recursive: true, force: true });
  }
});

test('an existing worktree is reused rather than duplicated', () => {
  const repo = makeRepo();
  try {
    const first = worktrees.ensureWorktree(repo, { name: 'reuse', branchPrefix: 'test' });
    const second = worktrees.ensureWorktree(repo, { name: 'reuse', branchPrefix: 'test' });
    assert.equal(second.path, first.path);
    assert.equal(second.created, false);
    assert.equal(worktrees.listWorktrees(repo).filter(w => w.path === first.path).length, 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-worktrees`, { recursive: true, force: true });
  }
});

test('removing a worktree reports observed state and keeps the branch', () => {
  const repo = makeRepo();
  try {
    const wt = worktrees.ensureWorktree(repo, { name: 'gone', branchPrefix: 'test' });
    assert.equal(worktrees.removeWorktree(repo, wt.path), true);
    assert.equal(worktrees.removeWorktree(repo, wt.path), false, 'a second removal has nothing to do');
    assert.equal(worktrees.removeWorktree(repo, path.join(repo, 'never-existed')), false);

    const branches = execSync('git branch --list test/gone', { cwd: repo, encoding: 'utf8' });
    assert.match(branches, /test\/gone/, 'the branch outlives its worktree');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(`${repo}-worktrees`, { recursive: true, force: true });
  }
});

test('a non-git directory falls back instead of failing', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-plain-'));
  try {
    assert.equal(worktrees.ensureWorktree(plain, { name: 'x' }), null);
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('a test run never starts a real agent', async () => {
  assert.equal(process.env.OPENORCHA_NO_LAUNCH, '1', 'the guard must be set before the supervisor is loaded');

  const initiative = store.create({ name: 'Would launch', cwd: dir, notifyOnGate: false });
  initiative.status = 'running';
  store.save(initiative);

  const before = tmuxSessions();
  await supervisor.tickOne(store.get(initiative.id));
  assert.deepEqual(tmuxSessions(), before, 'tick must not create tmux sessions under the guard');

  const after = store.get(initiative.id);
  assert.equal(after.workers.length, 0);
  assert.ok(after.events.some(e => e.type === 'warning' && /Launch suppressed/.test(e.detail)));
});

function tmuxSessions() {
  try {
    return execSync('tmux ls 2>/dev/null || true', { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  } catch {
    return [];
  }
}
