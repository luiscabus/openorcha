const express = require('express');
const os = require('os');
const fs = require('fs');

const store = require('../lib/initiativeStore');
const supervisor = require('../lib/initiativeSupervisor');
const { runCheck, repoSnapshot } = require('../lib/initiativeChecks');
const { removeWorktree } = require('../lib/initiativeWorktrees');
const { PROFILES } = require('../lib/initiativePolicy');
const templates = require('../lib/initiativeTemplates');
const framing = require('../lib/initiativeFraming');
const outcome = require('../lib/initiativeOutcome');
const orch = require('../lib/initiativeOrchestrator');
const timeline = require('../lib/initiativeTimeline');

const router = express.Router();

function expandCwd(cwd) {
  return String(cwd || '').trim().replace(/^~(?=\/|$)/, os.homedir());
}

function withLive(initiative, snapshot = supervisor.takeSnapshot()) {
  // Every worker gets its own live row: a fanned-out stage runs several agents
  // at once and the UI has to show which of them is actually moving.
  const workers = (initiative.workers || []).map(worker => {
    const agent = worker.status === 'gone' || worker.status === 'done'
      ? null
      : supervisor.agentForSession(worker.sessionName, snapshot);
    let live = null;
    if (agent) {
      const { status } = supervisor.inferStatus(agent);
      live = { pid: agent.pid, status, tmux: agent.mux?.target || null };
    }
    return { ...worker, live };
  });

  const first = workers.find(w => w.live);
  return {
    ...initiative,
    workers,
    live: first ? { ...first.live, cwd: first.cwd, worker: first.name } : null,
    liveWorkers: workers.filter(w => w.live).length,
    openGates: store.openGates(initiative),
    currentStage: store.currentStage(initiative),
  };
}

// ─── Collection ──────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const snapshot = supervisor.takeSnapshot();
    res.json({
      initiatives: store.list().map(i => withLive(i, snapshot)),
      profiles: Object.keys(PROFILES),
      templates: templates.list(),
      supervisor: supervisor.status(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', (req, res) => {
  try {
    const cwd = expandCwd(req.body?.cwd);
    if (!cwd) return res.status(400).json({ error: 'cwd is required' });
    if (!fs.existsSync(cwd)) return res.status(400).json({ error: `Directory does not exist: ${cwd}` });
    const initiative = store.create({ ...req.body, cwd });
    res.json({ initiative: withLive(initiative) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Trash ───────────────────────────────────────────────────────────────────

router.get('/trash', (req, res) => {
  res.json({ trash: store.listTrash() });
});

router.post('/trash/:file/restore', (req, res) => {
  const result = store.restore(req.params.file);
  if (!result) return res.status(404).json({ error: 'Not in the trash' });
  if (result.conflict) return res.status(409).json({ error: `An initiative with id ${result.id} already exists` });
  res.json({ initiative: withLive(result.initiative) });
});

router.delete('/trash/:file', (req, res) => {
  res.json({ ok: store.purgeTrash(req.params.file) });
});

router.get('/templates', (req, res) => {
  res.json({ templates: templates.list() });
});

// ─── Definition of done ──────────────────────────────────────────────────────

// Ask for a proposed definition of done before an initiative exists. This is
// the one interactive pass: you settle "done" here, so the run does not have to
// keep asking you later.
router.post('/frame', async (req, res) => {
  try {
    const cwd = expandCwd(req.body?.cwd);
    const goal = String(req.body?.goal || '').trim();
    if (!goal) return res.status(400).json({ error: 'goal is required' });
    if (!cwd || !fs.existsSync(cwd)) return res.status(400).json({ error: 'a real project directory is required' });

    const proposal = await framing.frame({
      goal,
      cwd,
      template: req.body?.template,
      spec: req.body?.spec,
      ticket: req.body?.ticket,
    });
    if (!proposal) return res.status(502).json({ error: 'Could not work out a definition of done — write it by hand and press Create.' });
    res.json({ proposal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id/acceptance', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });
  const criteria = Array.isArray(req.body?.criteria) ? req.body.criteria : [];
  store.setAcceptance(initiative, criteria);
  res.json({ initiative: withLive(store.save(initiative)) });
});

// Run every checkable criterion now and report where the run really stands.
router.post('/:id/acceptance/check', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });

  const results = [];
  for (const criterion of initiative.acceptance || []) {
    if (criterion.check?.type === 'human') {
      results.push({ id: criterion.id, text: criterion.text, passed: null, detail: criterion.check.detail || 'your call' });
      continue;
    }
    const result = runCheck(criterion.check, initiative.cwd);
    if (result.passed === true) store.setCriterionStatus(initiative, criterion.id, 'met', result.detail);
    else if (criterion.status === 'met') store.setCriterionStatus(initiative, criterion.id, 'unmet', result.detail);
    else criterion.detail = result.detail;
    results.push({ id: criterion.id, text: criterion.text, passed: result.passed, detail: result.detail });
  }
  res.json({ results, initiative: withLive(store.save(initiative)) });
});

router.post('/:id/acceptance/:criterionId', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });
  const status = req.body?.status;
  if (!['met', 'unmet', 'waived'].includes(status)) return res.status(400).json({ error: 'status must be met, unmet or waived' });
  const criterion = store.setCriterionStatus(initiative, req.params.criterionId, status, req.body?.detail || 'set by you');
  if (!criterion) return res.status(404).json({ error: 'Criterion not found' });
  res.json({ initiative: withLive(store.save(initiative)) });
});

router.get('/digest', (req, res) => {
  try {
    res.json(supervisor.buildDigest(req.query.since));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── One initiative ──────────────────────────────────────────────────────────

router.get('/:id', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });
  res.json({ initiative: withLive(initiative), repo: repoSnapshot(initiative.cwd) });
});

router.patch('/:id', (req, res) => {
  try {
    const patch = { ...req.body };
    if (patch.cwd) {
      patch.cwd = expandCwd(patch.cwd);
      if (!fs.existsSync(patch.cwd)) return res.status(400).json({ error: `Directory does not exist: ${patch.cwd}` });
    }
    const updated = store.update(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'Initiative not found' });
    res.json({ initiative: withLive(updated) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Remove: the record moves to the trash, where it can be restored; what it
// produced does not go anywhere. Agents are killed by default so nothing keeps
// running for a thing that no longer exists, and worktrees are only removed
// when asked and only when clean.
router.delete('/:id', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.json({ ok: store.remove(req.params.id) });

  const keepAgents = req.query.keepAgents === 'true';
  const stopped = keepAgents ? [] : supervisor.stopWorkers(initiative, { kill: true });

  const removedWorktrees = [];
  const keptWorktrees = [];
  if (req.query.pruneWorktrees === 'true') {
    for (const worker of initiative.workers || []) {
      if (!worker.worktree || !fs.existsSync(worker.worktree.path)) continue;
      const dirty = runCheck({ type: 'git-dirty' }, worker.worktree.path);
      if (dirty.passed === true) {
        keptWorktrees.push({ path: worker.worktree.path, why: 'uncommitted changes' });
        continue;
      }
      if (removeWorktree(initiative.cwd, worker.worktree.path)) removedWorktrees.push(worker.worktree.path);
    }
  }

  res.json({
    ok: store.remove(req.params.id),
    stopped,
    removedWorktrees,
    keptWorktrees,
    branchesKept: (initiative.workers || []).map(w => w.worktree?.branch).filter(Boolean),
  });
});

// ─── Run control ─────────────────────────────────────────────────────────────

router.post('/:id/start', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });

  initiative.status = 'running';
  const stage = store.currentStage(initiative);
  if (stage && stage.status === 'pending') {
    stage.status = 'active';
    stage.startedAt = new Date().toISOString();
  }
  store.addEvent(initiative, 'started', 'Supervisor took over this initiative');
  const saved = store.save(initiative);

  // Kick a tick immediately so the run does not wait for the next interval.
  supervisor.tick().catch(() => {});
  res.json({ initiative: withLive(saved) });
});

// Pause: stop supervising, leave the agents alive so you can take one over.
router.post('/:id/pause', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });
  initiative.status = 'paused';
  store.addEvent(initiative, 'paused', 'Paused by you — agents left running');
  res.json({ initiative: withLive(store.save(initiative)) });
});

// Stop: end the run and kill the agents it started. The work on disk and the
// branches stay exactly where they are.
router.post('/:id/stop', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });

  const stopped = supervisor.stopWorkers(initiative, { kill: req.body?.keepAgents !== true });
  initiative.status = 'cancelled';
  for (const gate of store.openGates(initiative)) {
    store.resolveGate(initiative, gate.id, 'run stopped', 'user');
  }
  store.addEvent(initiative, 'cancelled', stopped.length
    ? `Stopped by you — killed ${stopped.length} agent session(s): ${stopped.join(', ')}`
    : 'Stopped by you');
  res.json({ stopped, initiative: withLive(store.save(initiative)) });
});

// Messaging an initiative always succeeds. It reaches a live agent when there
// is one — a named worker if you say which — and waits for the next briefing
// when there is not. Losing what the operator typed is never the right answer.
router.post('/:id/message', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message is required' });

  try {
    const snapshot = supervisor.takeSnapshot();
    // Default addressee is the orchestrator: it owns the run and knows what
    // has happened. Name a workerId to talk to one worker directly.
    const workerId = req.body?.workerId || store.orchestrator(initiative)?.id || null;
    const agent = supervisor.findAgent(initiative, snapshot, { workerId })
      || supervisor.findAgent(initiative, snapshot);

    if (!agent) {
      const queued = store.queueMessage(initiative, message);
      return res.json({
        delivered: false,
        queued: true,
        note: 'No agent is running for this initiative right now — this is held and handed over with the next briefing.',
        pending: (store.save(initiative).pendingMessages || []).length,
        at: queued.ts,
      });
    }

    const sent = supervisor.deliverNote(initiative, message, { workerId: agent.workerId });
    store.addEvent(initiative, 'user-message', `→ ${sent.workerName || 'agent'}: ${message.slice(0, 260)}`, { workerId: sent.workerId });
    res.json({ delivered: true, worker: sent.workerName, initiative: withLive(store.save(initiative), snapshot) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Who is actually reachable right now, so the UI can offer a choice.
router.get('/:id/live', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });
  const live = supervisor.liveWorkers(initiative).map(({ worker, agent }) => ({
    workerId: worker.id,
    name: worker.name,
    session: worker.sessionName,
    pid: agent.pid,
    status: supervisor.inferStatus(agent).status,
    branch: worker.worktree?.branch || null,
  }));
  res.json({ live, pending: (initiative.pendingMessages || []).length });
});

router.post('/:id/check', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });
  const stage = store.currentStage(initiative);
  res.json({ stage: stage?.name || null, result: runCheck(stage?.check, initiative.cwd) });
});

router.post('/:id/advance', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });
  const next = store.advanceStage(initiative, 'advanced by you');
  res.json({ initiative: withLive(store.save(initiative)), next: next?.name || null });
});

// ─── What the run has produced ───────────────────────────────────────────────

// How each worker's messages are read, wherever they came from: a remembered
// transcript first, so a finished worker's conversation is still readable.
function readWorkerMessages(initiative, worker, snapshot) {
  return supervisor.workerMessages(initiative, worker, snapshot);
}

// What a tool call actually did, in one line. "Bash" six times tells you
// nothing; the commands tell you what the agent was looking at.
function describeToolCall(tool) {
  if (typeof tool === 'string') return { name: tool, detail: '' };
  const name = tool?.name || 'tool';
  const input = tool?.input || {};
  const detail = input.command
    || input.file_path
    || input.path
    || input.pattern
    || input.query
    || (input.prompt ? String(input.prompt).slice(0, 120) : '')
    || (input.description || '');
  return { name, detail: String(detail || '').replace(/\s+/g, ' ').slice(0, 220) };
}

router.get('/:id/outcome', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });
  try {
    const snapshot = supervisor.takeSnapshot();
    res.json({ outcome: outcome.build(initiative, worker => readWorkerMessages(initiative, worker, snapshot)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One worker's conversation, so the run can be read without leaving the tab.
router.get('/:id/transcript', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });

  const worker = (initiative.workers || []).find(w => w.id === req.query.workerId)
    || (initiative.workers || [])[0];
  if (!worker) return res.json({ worker: null, messages: [] });

  try {
    const snapshot = supervisor.takeSnapshot();
    const limit = Math.min(parseInt(req.query.limit, 10) || 60, 300);
    const all = readWorkerMessages(initiative, worker, snapshot);
    const agent = worker.sessionName ? supervisor.agentForSession(worker.sessionName, snapshot) : null;

    res.json({
      worker: {
        workerId: worker.id, name: worker.name, role: worker.role || 'worker',
        status: worker.status, branch: worker.worktree?.branch || null,
        live: !!agent, pid: agent?.pid || null,
      },
      total: all.length,
      messages: all.slice(-limit).map(m => ({
        role: m.role,
        text: String(m.text || '').slice(0, 6000),
        tools: (Array.isArray(m.tools) ? m.tools : []).slice(0, 12).map(describeToolCall),
        timestamp: m.timestamp || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Who you are talking to: the orchestrator when there is one, otherwise
// whichever agent is doing the work.
function chatTarget(initiative) {
  return store.orchestrator(initiative) || store.activeWorkers(initiative)[0] || (initiative.workers || [])[0] || null;
}

// ─── The run as one stream ───────────────────────────────────────────────────

router.get('/:id/timeline', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });

  try {
    const snapshot = supervisor.takeSnapshot();
    const worker = chatTarget(initiative);
    const agent = worker?.sessionName ? supervisor.agentForSession(worker.sessionName, snapshot) : null;

    const turns = worker
      ? supervisor.workerMessages(initiative, worker, snapshot).map(m => ({
        side: orch.classifyTurn(m.role, m.text),
        text: orch.stripMarkers(m.text),
        tools: (Array.isArray(m.tools) ? m.tools : []).map(t => (typeof t === 'string' ? t : t.name || 'tool')).slice(0, 8),
        timestamp: m.timestamp || null,
        who: worker.name,
      })).filter(t => t.text || t.tools.length)
      : [];

    const entries = timeline.build(initiative, turns, { detail: req.query.detail === 'all' ? 'all' : 'story' });

    res.json({
      entries,
      talkingTo: worker
        ? {
          workerId: worker.id,
          name: worker.name,
          isOrchestrator: (worker.role || 'worker') === 'orchestrator',
          live: !!agent,
          status: agent ? supervisor.inferStatus(agent).status : worker.status,
        }
        : null,
      pending: (initiative.pendingMessages || []).length,
      openGates: store.openGates(initiative).length,
      updatedAt: initiative.updatedAt,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Chatting with the orchestrator ──────────────────────────────────────────

// The conversation, with the supervisor's own traffic marked rather than mixed
// in: the brief, the status updates and the JSON decisions are real but they
// are not what you said to it.
router.get('/:id/chat', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });

  const worker = chatTarget(initiative);
  if (!worker) return res.json({ worker: null, turns: [], pending: (initiative.pendingMessages || []).length });

  try {
    const snapshot = supervisor.takeSnapshot();
    const agent = worker.sessionName ? supervisor.agentForSession(worker.sessionName, snapshot) : null;
    const all = supervisor.workerMessages(initiative, worker, snapshot);

    const turns = all.map((m, index) => {
      const side = orch.classifyTurn(m.role, m.text);
      return {
        index,
        side,
        text: orch.stripMarkers(m.text),
        tools: (Array.isArray(m.tools) ? m.tools : []).map(t => (typeof t === 'string' ? t : t.name || 'tool')).slice(0, 8),
        timestamp: m.timestamp || null,
      };
    }).filter(t => t.text || t.tools.length);

    res.json({
      worker: {
        workerId: worker.id,
        name: worker.name,
        role: worker.role || 'worker',
        isOrchestrator: (worker.role || 'worker') === 'orchestrator',
        live: !!agent,
        status: agent ? supervisor.inferStatus(agent).status : worker.status,
      },
      turns,
      pending: (initiative.pendingMessages || []).length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send, and say how many turns existed beforehand so the caller knows what to
// wait for rather than guessing when the answer has landed.
router.post('/:id/chat', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message is required' });

  try {
    const worker = chatTarget(initiative);
    const snapshot = supervisor.takeSnapshot();
    const before = worker ? supervisor.workerMessages(initiative, worker, snapshot).length : 0;
    const sent = worker ? supervisor.deliverNote(initiative, message, { workerId: worker.id }) : { delivered: false };

    if (!sent.delivered) {
      store.queueMessage(initiative, message);
      return res.json({
        delivered: false,
        queued: true,
        note: 'Nothing is running for this initiative — held for the next agent.',
        pending: (store.save(initiative).pendingMessages || []).length,
      });
    }

    store.addEvent(initiative, 'user-message', `→ ${sent.workerName || 'agent'}: ${message.slice(0, 260)}`, { workerId: sent.workerId });
    store.save(initiative);
    res.json({ delivered: true, worker: sent.workerName, turnsBefore: before });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Orchestrator ────────────────────────────────────────────────────────────

router.post('/:id/orchestrator', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });

  const enabled = req.body?.enabled !== false;
  initiative.useOrchestrator = enabled;

  if (!enabled) {
    const existing = store.orchestrator(initiative);
    if (existing) {
      supervisor.stopWorkers({ ...initiative, workers: [existing] }, { kill: true });
      const w = initiative.workers.find(x => x.id === existing.id);
      if (w) { w.status = 'gone'; w.finishedAt = new Date().toISOString(); }
    }
    store.addEvent(initiative, 'orchestrator-off', 'Orchestrator turned off');
  } else {
    store.addEvent(initiative, 'orchestrator-on', 'Orchestrator turned on — it starts on the next tick');
  }

  const saved = store.save(initiative);
  // Kick a tick whatever the run's state: the orchestrator is wanted now.
  if (enabled) supervisor.tick().catch(() => {});
  res.json({ initiative: withLive(saved), starting: enabled });
});

// ─── Parallel work ───────────────────────────────────────────────────────────

router.post('/:id/split', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });

  const tasks = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
  if (!tasks.length) return res.status(400).json({ error: 'tasks are required' });
  if (tasks.length > 8) return res.status(400).json({ error: 'at most 8 parallel tasks' });
  if (tasks.some(t => !String(t?.name || '').trim())) return res.status(400).json({ error: 'every task needs a name' });

  const stageId = req.body?.stageId || store.currentStage(initiative)?.id;
  const stage = store.setStageTasks(initiative, stageId, tasks.map(t => ({
    name: String(t.name).trim(),
    instruction: String(t.instruction || '').trim(),
    check: t.check || null,
  })));
  if (!stage) return res.status(400).json({ error: 'Stage not found' });

  res.json({ initiative: withLive(store.save(initiative)) });
});

router.post('/:id/worktrees/prune', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });

  // Only worktrees whose worker has finished, and never one with uncommitted
  // work in it — the branch survives either way.
  const removed = [];
  const kept = [];
  const missing = [];
  for (const worker of initiative.workers || []) {
    if (!worker.worktree || !['done', 'gone'].includes(worker.status)) continue;

    // Someone removed it by hand: drop the stale pointer, keep the branch.
    if (!fs.existsSync(worker.worktree.path)) {
      missing.push(worker.worktree.path);
      worker.worktree = null;
      continue;
    }

    const dirty = runCheck({ type: 'git-dirty' }, worker.worktree.path);
    if (dirty.passed === true) {
      kept.push({ path: worker.worktree.path, why: 'uncommitted changes' });
      continue;
    }
    if (removeWorktree(initiative.cwd, worker.worktree.path)) {
      removed.push(worker.worktree.path);
      store.addEvent(initiative, 'worktree-removed', `${worker.name} — ${worker.worktree.branch} kept, worktree removed`);
    } else {
      kept.push({ path: worker.worktree.path, why: 'git could not remove it' });
    }
  }
  res.json({ removed, kept, missing, initiative: withLive(store.save(initiative)) });
});

// ─── Gates ───────────────────────────────────────────────────────────────────

router.get('/:id/gates', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });
  res.json({ gates: initiative.gates });
});

router.post('/:id/gates/:gateId', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });

  const answer = String(req.body?.answer || '').trim();
  if (!answer) return res.status(400).json({ error: 'answer is required' });

  const gate = (initiative.gates || []).find(g => g.id === req.params.gateId);
  if (!gate) return res.status(404).json({ error: 'Gate not found' });
  if (gate.resolvedAt) return res.status(400).json({ error: 'Gate is already resolved' });

  store.resolveGate(initiative, gate.id, answer, 'user');
  supervisor.applyGateAnswer(initiative, gate, answer);
  const saved = store.save(initiative);
  supervisor.tick().catch(() => {});
  res.json({ initiative: withLive(saved) });
});

module.exports = router;
