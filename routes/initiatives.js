const express = require('express');
const os = require('os');
const fs = require('fs');

const store = require('../lib/initiativeStore');
const supervisor = require('../lib/initiativeSupervisor');
const { runCheck, repoSnapshot } = require('../lib/initiativeChecks');
const { PROFILES } = require('../lib/initiativePolicy');

const router = express.Router();

function expandCwd(cwd) {
  return String(cwd || '').trim().replace(/^~(?=\/|$)/, os.homedir());
}

function withLive(initiative) {
  const agent = supervisor.findAgent(initiative);
  let live = null;
  if (agent) {
    const { status } = supervisor.inferStatus(agent);
    live = { pid: agent.pid, status, cwd: agent.cwd, tmux: agent.mux?.target || null };
  }
  return {
    ...initiative,
    live,
    openGates: store.openGates(initiative),
    currentStage: store.currentStage(initiative),
  };
}

// ─── Collection ──────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    res.json({
      initiatives: store.list().map(withLive),
      profiles: Object.keys(PROFILES),
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

router.delete('/:id', (req, res) => {
  res.json({ ok: store.remove(req.params.id) });
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

router.post('/:id/pause', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });
  initiative.status = 'paused';
  store.addEvent(initiative, 'paused', 'Paused by you');
  res.json({ initiative: withLive(store.save(initiative)) });
});

router.post('/:id/message', (req, res) => {
  const initiative = store.get(req.params.id);
  if (!initiative) return res.status(404).json({ error: 'Initiative not found' });
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message is required' });

  const agent = supervisor.findAgent(initiative);
  if (!agent) return res.status(400).json({ error: 'No live agent for this initiative' });

  try {
    supervisor.applyGateAnswer(initiative, { kind: 'note' }, message);
    store.addEvent(initiative, 'user-message', message.slice(0, 300));
    res.json({ initiative: withLive(store.save(initiative)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
