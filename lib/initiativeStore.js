// Durable initiatives.
//
// The AI Agents tab already had "initiatives", but they were localStorage
// labels keyed to a live PID — they died with the process. Long work has to
// outlive the agent running it, so an initiative is a file on disk here, and
// the running agent is just its current attempt.

const fs = require('fs');
const path = require('path');
const { DEFAULT_PROFILE, PROFILES } = require('./initiativePolicy');

// Overridable so tests can work against a temp directory.
const INITIATIVES_DIR = process.env.OPENORCHA_INITIATIVES_DIR
  || path.join(__dirname, '..', 'data', 'initiatives');
const MAX_EVENTS = 400;

const STATUSES = ['draft', 'running', 'blocked', 'paused', 'done', 'failed'];

// The default pipeline mirrors the cycle these sessions actually run:
// jira -> explore -> branch -> (explore/test)xN -> commit -> push -> PR -> review.
function defaultStages() {
  return [
    {
      id: 'plan',
      name: 'Plan',
      instruction: 'Read the goal and the relevant code. Produce a short plan: the files you will touch and how you will verify the change. Do not write code yet.',
      check: null,
      maxNudges: 3,
    },
    {
      id: 'branch',
      name: 'Branch',
      instruction: 'Create the working branch for this initiative. Never work on master.',
      check: { type: 'branch-created' },
      maxNudges: 2,
    },
    {
      id: 'implement',
      name: 'Implement',
      instruction: 'Implement the change. Keep it to the stated goal — no unrelated refactors.',
      check: { type: 'git-dirty' },
      maxNudges: 6,
    },
    {
      id: 'verify',
      name: 'Verify',
      instruction: 'Run the verification command for this project and make it pass. Fix what it reports rather than working around it.',
      check: null,
      maxNudges: 6,
    },
    {
      id: 'commit',
      name: 'Commit',
      instruction: 'Commit the work in focused commits following the repository conventions.',
      check: { type: 'commits-ahead' },
      maxNudges: 3,
    },
    {
      id: 'ship',
      name: 'Push & draft PR',
      instruction: 'Push the branch and open a draft pull request describing what changed and how it was verified.',
      check: { type: 'pr-exists' },
      maxNudges: 3,
    },
  ];
}

function ensureDir() {
  fs.mkdirSync(INITIATIVES_DIR, { recursive: true });
}

function createId() {
  return `init-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function filePathFor(id) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id || '')) return null;
  return path.join(INITIATIVES_DIR, `${id}.json`);
}

function normalizeStage(stage, index) {
  return {
    id: stage?.id || `stage-${index + 1}`,
    name: stage?.name || `Stage ${index + 1}`,
    instruction: stage?.instruction || '',
    check: stage?.check || null,
    maxNudges: Number.isFinite(stage?.maxNudges) ? stage.maxNudges : 5,
    status: ['pending', 'active', 'done', 'skipped'].includes(stage?.status) ? stage.status : 'pending',
    nudges: stage?.nudges || 0,
    consecutiveFailures: stage?.consecutiveFailures || 0,
    startedAt: stage?.startedAt || null,
    finishedAt: stage?.finishedAt || null,
  };
}

function normalize(raw) {
  const stages = (Array.isArray(raw?.stages) && raw.stages.length ? raw.stages : defaultStages())
    .map(normalizeStage);
  const status = STATUSES.includes(raw?.status) ? raw.status : 'draft';
  return {
    id: raw?.id || createId(),
    name: String(raw?.name || '').trim() || 'Untitled initiative',
    goal: String(raw?.goal || '').trim(),
    cwd: String(raw?.cwd || '').trim(),
    agentId: raw?.agentId || 'claude',
    presetFile: raw?.presetFile || null,
    ticket: raw?.ticket || null,
    profile: PROFILES[raw?.profile] ? raw.profile : DEFAULT_PROFILE,
    verifyCommand: raw?.verifyCommand || '',
    quietHours: raw?.quietHours || null,
    autoDecideAfterMs: Number.isFinite(raw?.autoDecideAfterMs) ? raw.autoDecideAfterMs : 30 * 60 * 1000,
    notifyOnGate: raw?.notifyOnGate !== false,
    status,
    stageIndex: Number.isFinite(raw?.stageIndex) ? Math.max(0, Math.min(raw.stageIndex, stages.length - 1)) : 0,
    stages,
    run: raw?.run || null,
    gates: Array.isArray(raw?.gates) ? raw.gates : [],
    events: Array.isArray(raw?.events) ? raw.events.slice(-MAX_EVENTS) : [],
    stats: {
      nudges: raw?.stats?.nudges || 0,
      autoApprovals: raw?.stats?.autoApprovals || 0,
      gates: raw?.stats?.gates || 0,
      llmDecisions: raw?.stats?.llmDecisions || 0,
      autoDecided: raw?.stats?.autoDecided || 0,
      stagesCompleted: raw?.stats?.stagesCompleted || 0,
      supervisedMs: raw?.stats?.supervisedMs || 0,
    },
    createdAt: raw?.createdAt || new Date().toISOString(),
    updatedAt: raw?.updatedAt || new Date().toISOString(),
  };
}

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function list() {
  ensureDir();
  const out = [];
  for (const f of fs.readdirSync(INITIATIVES_DIR)) {
    if (!f.endsWith('.json')) continue;
    const raw = readJson(path.join(INITIATIVES_DIR, f));
    if (raw) out.push(normalize(raw));
  }
  out.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return out;
}

function get(id) {
  const fp = filePathFor(id);
  if (!fp || !fs.existsSync(fp)) return null;
  const raw = readJson(fp);
  return raw ? normalize(raw) : null;
}

function save(initiative) {
  ensureDir();
  const normalized = normalize(initiative);
  normalized.updatedAt = new Date().toISOString();
  const fp = filePathFor(normalized.id);
  if (!fp) throw new Error(`Invalid initiative id: ${normalized.id}`);
  fs.writeFileSync(fp, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function create(data) {
  const initiative = normalize({ ...data, id: createId(), createdAt: new Date().toISOString() });
  if (!initiative.cwd) throw new Error('cwd is required');
  if (initiative.verifyCommand) {
    const verify = initiative.stages.find(s => s.id === 'verify');
    if (verify && !verify.check) verify.check = { type: 'command', command: initiative.verifyCommand };
  }
  return save(addEvent(initiative, 'created', `Initiative created in ${initiative.cwd}`));
}

function update(id, patch) {
  const current = get(id);
  if (!current) return null;
  // Stages, gates, events and stats are owned by the supervisor; a plain
  // update should not silently reset them.
  const merged = {
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
    stages: patch.stages || current.stages,
    gates: current.gates,
    events: current.events,
    stats: current.stats,
  };
  return save(merged);
}

function remove(id) {
  const fp = filePathFor(id);
  if (!fp || !fs.existsSync(fp)) return false;
  fs.unlinkSync(fp);
  return true;
}

// ─── Events ──────────────────────────────────────────────────────────────────

function addEvent(initiative, type, detail, extra = {}) {
  const stage = initiative.stages[initiative.stageIndex];
  initiative.events = [
    ...(initiative.events || []),
    {
      ts: new Date().toISOString(),
      type,
      stage: stage?.id || null,
      stageName: stage?.name || null,
      detail: String(detail || '').slice(0, 2000),
      ...extra,
    },
  ].slice(-MAX_EVENTS);
  return initiative;
}

// ─── Gates ───────────────────────────────────────────────────────────────────

function openGate(initiative, gate) {
  const entry = {
    id: `gate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind: gate.kind || 'decision',
    question: String(gate.question || 'The run needs a decision.').slice(0, 2000),
    options: Array.isArray(gate.options) ? gate.options.slice(0, 8) : [],
    defaultOption: gate.defaultOption || null,
    reason: gate.reason || '',
    command: gate.command || null,
    context: String(gate.context || '').slice(0, 4000),
    stageId: initiative.stages[initiative.stageIndex]?.id || null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    answer: null,
    answeredBy: null,
  };
  initiative.gates.push(entry);
  initiative.stats.gates += 1;
  initiative.status = 'blocked';
  addEvent(initiative, 'gate-opened', `${entry.kind}: ${entry.question}`, { gateId: entry.id });
  return entry;
}

function openGates(initiative) {
  return (initiative.gates || []).filter(g => !g.resolvedAt);
}

function resolveGate(initiative, gateId, answer, answeredBy = 'user') {
  const gate = (initiative.gates || []).find(g => g.id === gateId);
  if (!gate || gate.resolvedAt) return null;
  gate.resolvedAt = new Date().toISOString();
  gate.answer = String(answer || '').slice(0, 2000);
  gate.answeredBy = answeredBy;
  if (answeredBy === 'auto') initiative.stats.autoDecided += 1;
  addEvent(initiative, 'gate-resolved', `${answeredBy === 'auto' ? 'auto-decided' : 'answered'}: ${gate.answer}`, { gateId: gate.id });
  if (!openGates(initiative).length && initiative.status === 'blocked') initiative.status = 'running';
  return gate;
}

// ─── Stage transitions ───────────────────────────────────────────────────────

function currentStage(initiative) {
  return initiative.stages[initiative.stageIndex] || null;
}

function advanceStage(initiative, reason = '') {
  const stage = currentStage(initiative);
  if (stage) {
    stage.status = 'done';
    stage.finishedAt = new Date().toISOString();
    initiative.stats.stagesCompleted += 1;
    addEvent(initiative, 'stage-done', `${stage.name} complete${reason ? ` — ${reason}` : ''}`);
  }
  if (initiative.stageIndex >= initiative.stages.length - 1) {
    initiative.status = 'done';
    addEvent(initiative, 'completed', 'All stages complete');
    return null;
  }
  initiative.stageIndex += 1;
  const next = currentStage(initiative);
  next.status = 'active';
  next.startedAt = new Date().toISOString();
  next.nudges = 0;
  next.consecutiveFailures = 0;
  addEvent(initiative, 'stage-start', `Started ${next.name}`);
  return next;
}

function skipStage(initiative, reason = '') {
  const stage = currentStage(initiative);
  if (stage) {
    stage.status = 'skipped';
    stage.finishedAt = new Date().toISOString();
    addEvent(initiative, 'stage-skipped', `${stage.name} skipped${reason ? ` — ${reason}` : ''}`);
  }
  if (initiative.stageIndex >= initiative.stages.length - 1) {
    initiative.status = 'done';
    return null;
  }
  initiative.stageIndex += 1;
  const next = currentStage(initiative);
  next.status = 'active';
  next.startedAt = new Date().toISOString();
  return next;
}

module.exports = {
  INITIATIVES_DIR,
  STATUSES,
  defaultStages,
  normalize,
  list,
  get,
  save,
  create,
  update,
  remove,
  addEvent,
  openGate,
  openGates,
  resolveGate,
  currentStage,
  advanceStage,
  skipStage,
};
