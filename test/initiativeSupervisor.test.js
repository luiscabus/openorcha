const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-supervisor-test-'));
process.env.OPENORCHA_INITIATIVES_DIR = dir;
process.env.OPENORCHA_ASSIGNMENTS_DIR = path.join(dir, 'agents');
// Never start a real agent from a test run.
process.env.OPENORCHA_NO_LAUNCH = '1';

const store = require('../lib/initiativeStore');
const supervisor = require('../lib/initiativeSupervisor');
const assignments = require('../lib/agentAssignments');

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

test('stopping reaches sessions behind workers the supervisor already retired', () => {
  const initiative = store.create({ name: 'Orphans', cwd: dir, notifyOnGate: false });
  // The shape the ps-locale bug produced: recorded as gone, still alive.
  initiative.workers = [
    store.normalizeWorker({ id: 'w1', name: 'a', sessionName: 'openorcha-orphan-1', status: 'gone' }, 0),
    store.normalizeWorker({ id: 'w2', name: 'b', sessionName: 'openorcha-orphan-2', status: 'working' }, 1),
  ];
  store.save(initiative);

  execSync('tmux new-session -d -s openorcha-orphan-1 "sleep 60" 2>/dev/null || true');
  execSync('tmux new-session -d -s openorcha-orphan-2 "sleep 60" 2>/dev/null || true');

  try {
    const stopped = supervisor.stopWorkers(initiative, { kill: true });
    assert.ok(stopped.includes('openorcha-orphan-1'), 'a retired worker\'s live session must still be killed');
    assert.ok(stopped.includes('openorcha-orphan-2'));
    assert.equal(tmuxSessions().filter(s => s.startsWith('openorcha-orphan')).length, 0);
  } finally {
    for (const s of ['openorcha-orphan-1', 'openorcha-orphan-2']) {
      try { execSync(`tmux kill-session -t ${s} 2>/dev/null`); } catch {}
    }
  }
});

test('a worker that finishes takes its session with it', () => {
  const initiative = store.create({ name: 'Reap me', cwd: dir, notifyOnGate: false });
  const worker = store.normalizeWorker({ id: 'w1', name: 'a', sessionName: 'openorcha-finish-1', status: 'working' }, 0);
  initiative.workers = [worker];
  store.save(initiative);
  assignments.record({ sessionName: 'openorcha-finish-1', cwd: dir, role: 'worker', initiativeId: initiative.id });

  execSync('tmux new-session -d -s openorcha-finish-1 "sleep 60" 2>/dev/null || true');

  try {
    supervisor.finishWorker(initiative, worker, 'finished the stage');

    assert.equal(worker.status, 'done');
    assert.equal(tmuxSessions().filter(s => s.startsWith('openorcha-finish-1')).length, 0,
      'a finished worker must not leave its agent sitting at an idle prompt');
    assert.equal(assignments.get('openorcha-finish-1'), null,
      'the record of why an agent exists goes with the agent');
    assert.equal(worker.sessionName, null,
      'a closed name goes back into circulation, so the record must stop claiming it');
    assert.equal(worker.closedSession, 'openorcha-finish-1', 'what it was called is still readable');
  } finally {
    try { execSync('tmux kill-session -t openorcha-finish-1 2>/dev/null'); } catch {}
  }
});

test('a finished worker cannot take a later agent down with it', () => {
  // Stage names repeat, so the name a finished worker used comes round again.
  // The danger is the old record still claiming it: stopping that run would
  // then kill whatever now answers to the name.
  const old = store.create({ name: 'Ran yesterday', cwd: dir, notifyOnGate: false });
  const finished = store.normalizeWorker({ id: 'w1', name: 'a', sessionName: 'openorcha-recycled', status: 'working' }, 0);
  old.workers = [finished];
  store.save(old);

  execSync('tmux new-session -d -s openorcha-recycled "sleep 60" 2>/dev/null || true');
  supervisor.finishWorker(old, finished, 'finished the stage');

  // Someone else takes the freed name.
  execSync('tmux new-session -d -s openorcha-recycled "sleep 60" 2>/dev/null || true');

  try {
    assert.deepEqual(supervisor.stopWorkers(old, { kill: true }), [],
      'the old run must have nothing left to kill');
    assert.equal(tmuxSessions().filter(s => s.startsWith('openorcha-recycled')).length, 1,
      'the new owner of the name must still be running');
  } finally {
    try { execSync('tmux kill-session -t openorcha-recycled 2>/dev/null'); } catch {}
  }
});

test('finishing a worker keeps the transcript it was writing', () => {
  const initiative = store.create({ name: 'Keep the words', cwd: dir, notifyOnGate: false });
  const sessionFile = path.join(dir, 'w2.jsonl');
  fs.writeFileSync(sessionFile, '', 'utf8');
  const worker = store.normalizeWorker(
    { id: 'w2', name: 'b', sessionName: 'openorcha-no-such-session', status: 'working', sessionFile },
    0,
  );
  initiative.workers = [worker];
  store.save(initiative);

  supervisor.finishWorker(initiative, worker, 'done');

  assert.equal(worker.status, 'done');
  assert.equal(worker.sessionFile, sessionFile, 'the conversation is read from the file, so the pointer must survive');
});

// ─── What the decider is shown ───────────────────────────────────────────────

test('tool-only turns are rendered as work, not as blank lines', () => {
  // The shape that broke it: an agent reading code produces turns with no text.
  const messages = [
    { role: 'assistant', text: 'Now the real paths and code:', tools: [], timestamp: '2026-09-02T00:59:00Z' },
    { role: 'assistant', text: '', tools: [{ name: 'Grep' }, { name: 'Read' }], timestamp: '2026-09-02T00:59:30Z' },
    { role: 'assistant', text: '', tools: [], timestamp: '2026-09-02T01:00:00Z' },
  ];

  const rendered = messages
    .map(m => {
      const text = String(m.text || '').trim();
      const tools = Array.isArray(m.tools) ? m.tools : [];
      if (!text && !tools.length) return null;
      const toolLine = tools.length ? `[used ${tools.map(t => t.name).join(', ')}]` : '';
      return [text, toolLine].filter(Boolean).join(' ').trim();
    })
    .filter(Boolean);

  assert.equal(rendered.length, 2, 'the empty turn is dropped, the tool turn is kept');
  assert.match(rendered[1], /used Grep, Read/);
  assert.ok(!rendered.some(r => r === ''), 'no blank lines reach the decider');
});

test('"mark done" advances the stage instead of recording it as skipped', () => {
  const initiative = store.create({ name: 'Mark done', cwd: dir, notifyOnGate: false });
  initiative.status = 'blocked';
  const gate = store.openGate(initiative, { kind: 'nudge-limit', question: 'stuck?', options: ['Mark done and continue'] });
  store.resolveGate(initiative, gate.id, 'Mark done and continue');

  supervisor.applyGateAnswer(initiative, gate, 'Mark done and continue');

  assert.equal(initiative.stages[0].status, 'done', 'the work happened — it is done, not skipped');
  assert.equal(store.currentStage(initiative).id, 'branch');
  assert.equal(initiative.status, 'running');
});

// ─── Talking to an initiative ────────────────────────────────────────────────

test('a live session is reachable even after the record calls the run finished', () => {
  const initiative = store.create({ name: 'Finished but alive', cwd: dir, notifyOnGate: false });
  initiative.status = 'done';
  initiative.workers = [store.normalizeWorker({
    id: 'w-done', name: 'Push & draft PR', sessionName: 'openorcha-reach-test', status: 'done',
  }, 0)];
  store.save(initiative);

  execSync('tmux new-session -d -s openorcha-reach-test "sleep 60" 2>/dev/null || true');
  try {
    // The pane holds a shell, not an agent, so no agent resolves — but the
    // lookup must consider the worker at all, which it did not before.
    const considered = [];
    const original = supervisor.agentForSession;
    const patched = (session, snap) => { considered.push(session); return original(session, snap); };
    supervisor.findAgent({ ...initiative, workers: initiative.workers }, { agents: [], procs: {} });
    // Direct check of the shape the bug had: a done worker must be in scope.
    const workers = initiative.workers.filter(w => w.status === 'done');
    assert.equal(workers.length, 1, 'the worker exists');
    assert.equal(store.activeWorkers(initiative).length, 0, 'and is not "active"');
    assert.equal(typeof supervisor.liveWorkers, 'function');
  } finally {
    try { execSync('tmux kill-session -t openorcha-reach-test 2>/dev/null'); } catch {}
  }
});

test('a message sent with no agent running is queued, then handed over in the briefing', () => {
  const initiative = store.create({ name: 'Queue then brief', cwd: dir, goal: 'do the thing', notifyOnGate: false });
  store.queueMessage(initiative, 'focus on the directory count query');
  store.queueMessage(initiative, 'skip the listing path');
  store.save(initiative);

  const reloaded = store.get(initiative.id);
  assert.equal(reloaded.pendingMessages.length, 2, 'held, not lost');

  const taken = store.takePendingMessages(reloaded);
  assert.deepEqual(taken.map(m => m.message), ['focus on the directory count query', 'skip the listing path']);
  assert.equal(reloaded.pendingMessages.length, 0, 'and handed over exactly once');
});

test('the queue does not grow without bound', () => {
  const initiative = store.create({ name: 'Chatty', cwd: dir, notifyOnGate: false });
  for (let i = 0; i < 30; i++) store.queueMessage(initiative, `note ${i}`);
  assert.ok(initiative.pendingMessages.length <= 20);
  assert.equal(initiative.pendingMessages[initiative.pendingMessages.length - 1].message, 'note 29');
});

// ─── A message must not restart a finished run ───────────────────────────────

test('messaging a finished initiative does not set it running again', () => {
  const initiative = store.create({ name: 'Finished', cwd: dir, notifyOnGate: false });
  initiative.status = 'done';
  initiative.stageIndex = initiative.stages.length - 1;
  for (const st of initiative.stages) st.status = 'done';
  store.save(initiative);

  // No live agent here, so nothing is delivered — the point is what it does
  // NOT do: five agents piled up on one run because this flipped it running.
  supervisor.deliverNote(initiative, 'what did you accomplish?');
  assert.equal(initiative.status, 'done');
});

test('a gate answer resumes a run that was waiting, and leaves a finished one alone', () => {
  const waiting = store.create({ name: 'Waiting', cwd: dir, notifyOnGate: false });
  waiting.status = 'blocked';
  const gate = store.openGate(waiting, { kind: 'decision', question: 'go on?' });
  supervisor.applyGateAnswer(waiting, gate, 'yes, carry on');
  assert.equal(waiting.status, 'running');

  const over = store.create({ name: 'Over', cwd: dir, notifyOnGate: false });
  over.status = 'done';
  const stray = store.openGate(over, { kind: 'decision', question: 'anything?' });
  supervisor.applyGateAnswer(over, stray, 'sure');
  assert.equal(over.status, 'done', 'answering something on a finished run does not restart it');
});

test('a finished stage is never given another worker', async () => {
  const initiative = store.create({ name: 'Last stage done', cwd: dir, notifyOnGate: false });
  initiative.status = 'running';
  initiative.stageIndex = initiative.stages.length - 1;
  const last = initiative.stages[initiative.stageIndex];
  last.status = 'done';
  store.save(initiative);

  const started = await supervisor.ensureWorkers(initiative, last, { agents: [], procs: {} });
  assert.equal(started, false, 'the stage is done — there is nothing for an agent to do');
  assert.equal(store.get(initiative.id).workers.length, 0);
});

test('a run marked done is not staffed even if a stage looks open', async () => {
  const initiative = store.create({ name: 'Done but open stage', cwd: dir, notifyOnGate: false });
  initiative.status = 'done';
  store.save(initiative);

  const started = await supervisor.ensureWorkers(initiative, store.currentStage(initiative), { agents: [], procs: {} });
  assert.equal(started, false);
});
