// Durable initiatives.
//
// The AI Agents tab already had "initiatives", but they were localStorage
// labels keyed to a live PID — they died with the process. Long work has to
// outlive the agent running it, so an initiative is a file on disk here, and
// the running agent is just its current attempt.

const fs = require('fs');
const path = require('path');
const { DEFAULT_PROFILE, PROFILES } = require('./initiativePolicy');
const templates = require('./initiativeTemplates');

// Overridable so tests can work against a temp directory.
const INITIATIVES_DIR = process.env.OPENORCHA_INITIATIVES_DIR
  || path.join(__dirname, '..', 'data', 'initiatives');
const MAX_EVENTS = 400;

const STATUSES = ['draft', 'running', 'blocked', 'paused', 'cancelled', 'done', 'failed'];

// The default pipeline mirrors the cycle these sessions actually run:
// jira -> explore -> branch -> (explore/test)xN -> commit -> push -> PR -> review.
function defaultStages() {
  const template = templates.get('ticket-to-pr');
  if (template) return template.stages.map(s => ({ ...s }));
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

function normalizeTask(task, index) {
  return {
    id: task?.id || `task-${index + 1}`,
    name: task?.name || `Task ${index + 1}`,
    instruction: task?.instruction || '',
    check: task?.check || null,
    status: ['pending', 'active', 'done', 'skipped'].includes(task?.status) ? task.status : 'pending',
    workerId: task?.workerId || null,
    branch: task?.branch || null,
    nudges: task?.nudges || 0,
    consecutiveFailures: task?.consecutiveFailures || 0,
    startedAt: task?.startedAt || null,
    finishedAt: task?.finishedAt || null,
  };
}

function normalizeStage(stage, index) {
  const tasks = Array.isArray(stage?.tasks) ? stage.tasks.map(normalizeTask) : [];
  return {
    id: stage?.id || `stage-${index + 1}`,
    name: stage?.name || `Stage ${index + 1}`,
    instruction: stage?.instruction || '',
    check: stage?.check || null,
    maxNudges: Number.isFinite(stage?.maxNudges) ? stage.maxNudges : 5,
    status: ['pending', 'active', 'done', 'skipped'].includes(stage?.status) ? stage.status : 'pending',
    // A stage with tasks fans out: one worker per task, each in its own
    // worktree, and the stage is done when every task's check passes.
    tasks,
    isolate: stage?.isolate !== false,
    nudges: stage?.nudges || 0,
    consecutiveFailures: stage?.consecutiveFailures || 0,
    startedAt: stage?.startedAt || null,
    finishedAt: stage?.finishedAt || null,
  };
}

function normalizeCriterion(c, index) {
  return {
    id: c?.id || `dod-${index + 1}`,
    text: String(c?.text || '').trim(),
    // How the supervisor knows it is met. `human` means it cannot be checked
    // and is explicitly your call — better stated than pretended.
    check: c?.check || { type: 'human' },
    status: ['unmet', 'met', 'waived'].includes(c?.status) ? c.status : 'unmet',
    detail: c?.detail || '',
    checkedAt: c?.checkedAt || null,
    stageId: c?.stageId || null,
  };
}

function normalizeWorker(worker, index) {
  return {
    id: worker?.id || `worker-${index + 1}`,
    name: worker?.name || `Worker ${index + 1}`,
    // 'worker' does the stage work; 'orchestrator' owns the run, decides what
    // happens next, and is who you talk to. Never does the work itself.
    role: worker?.role === 'orchestrator' ? 'orchestrator' : 'worker',
    sessionName: worker?.sessionName || null,
    agentId: worker?.agentId || 'claude',
    taskId: worker?.taskId || null,
    stageId: worker?.stageId || null,
    cwd: worker?.cwd || null,
    worktree: worker?.worktree || null,
    // Recorded the first time the supervisor resolves it, so the conversation
    // is still readable once the agent has exited.
    sessionFile: worker?.sessionFile || null,
    status: ['starting', 'working', 'done', 'gone'].includes(worker?.status) ? worker.status : 'starting',
    nudges: worker?.nudges || 0,
    consecutiveFailures: worker?.consecutiveFailures || 0,
    briefed: !!worker?.briefed,
    startedAt: worker?.startedAt || new Date().toISOString(),
    finishedAt: worker?.finishedAt || null,
  };
}

function normalizeWorkers(raw) {
  if (Array.isArray(raw?.workers) && raw.workers.length) return raw.workers.map(normalizeWorker);
  if (raw?.run?.sessionName) {
    return [normalizeWorker({
      id: 'worker-1',
      name: 'Main',
      sessionName: raw.run.sessionName,
      agentId: raw.agentId || 'claude',
      cwd: raw.cwd || null,
      status: 'working',
      briefed: true,
      startedAt: raw.run.startedAt,
    }, 0)];
  }
  return [];
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
    template: raw?.template || null,
    profile: PROFILES[raw?.profile] ? raw.profile : DEFAULT_PROFILE,
    verifyCommand: raw?.verifyCommand || '',
    quietHours: raw?.quietHours || null,
    autoDecideAfterMs: Number.isFinite(raw?.autoDecideAfterMs) ? raw.autoDecideAfterMs : 30 * 60 * 1000,
    notifyOnGate: raw?.notifyOnGate !== false,
    status,
    stageIndex: Number.isFinite(raw?.stageIndex) ? Math.max(0, Math.min(raw.stageIndex, stages.length - 1)) : 0,
    stages,
    // A run used to be one agent; it is now a pool of workers. Old files are
    // migrated so an existing initiative keeps its agent.
    workers: normalizeWorkers(raw),
    maxParallel: Number.isFinite(raw?.maxParallel) ? Math.max(1, Math.min(raw.maxParallel, 8)) : 3,
    // A standing agent that owns this run. Off by default: it is one more
    // session per initiative, and most runs do not need someone to talk to.
    useOrchestrator: raw?.useOrchestrator === true,
    worktreeRoot: raw?.worktreeRoot || null,
    branchPrefix: raw?.branchPrefix || null,
    // Branches produced by a fanned-out stage, handed to the stage that merges them.
    integration: raw?.integration || null,
    // Where the repository stood when this run began. Without it, "what this
    // run produced" is indistinguishable from whatever branch was checked out.
    baseline: raw?.baseline || null,
    // The definition of done, agreed before the work starts. Every criterion
    // carries the check that settles it, so the supervisor can verify the run
    // instead of asking you whether it is finished.
    acceptance: Array.isArray(raw?.acceptance) ? raw.acceptance.map(normalizeCriterion) : [],
    framing: raw?.framing || null,
    // Things you said to the run while it had no live agent. They are handed
    // over with the next briefing rather than thrown away.
    pendingMessages: Array.isArray(raw?.pendingMessages) ? raw.pendingMessages.slice(-20) : [],
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
  const templated = templates.applyTo(data || {});
  const initiative = normalize({ ...templated, id: createId(), createdAt: new Date().toISOString() });
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

// ─── Removal is reversible ───────────────────────────────────────────────────
//
// Removing an initiative moves its file to .trash rather than unlinking it.
// The record is the only thing that holds what a run was for — its goal, its
// stages, its history — and a wildcard delete or a mis-click should not be the
// end of it.

const TRASH_DIR = path.join(INITIATIVES_DIR, '.trash');
const TRASH_KEEP = 50;

function ensureTrashDir() {
  fs.mkdirSync(TRASH_DIR, { recursive: true });
}

function pruneTrash() {
  try {
    const files = fs.readdirSync(TRASH_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ f, mtime: fs.statSync(path.join(TRASH_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of files.slice(TRASH_KEEP)) {
      fs.unlinkSync(path.join(TRASH_DIR, stale.f));
    }
  } catch {}
}

function remove(id) {
  const fp = filePathFor(id);
  if (!fp || !fs.existsSync(fp)) return false;

  ensureTrashDir();
  const trashed = path.join(TRASH_DIR, `${id}.${Date.now()}.json`);
  try {
    const raw = readJson(fp) || {};
    raw.deletedAt = new Date().toISOString();
    fs.writeFileSync(trashed, `${JSON.stringify(raw, null, 2)}\n`);
    fs.unlinkSync(fp);
  } catch {
    // If the copy fails the original stays put — losing it is the worse outcome.
    return false;
  }
  pruneTrash();
  return true;
}

/** Removed initiatives, newest first. */
function listTrash() {
  try {
    return fs.readdirSync(TRASH_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const raw = readJson(path.join(TRASH_DIR, f));
        if (!raw) return null;
        return {
          file: f,
          id: raw.id,
          name: raw.name,
          cwd: raw.cwd,
          status: raw.status,
          template: raw.template || null,
          stage: raw.stages?.[raw.stageIndex || 0]?.name || null,
          deletedAt: raw.deletedAt || null,
          createdAt: raw.createdAt || null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.deletedAt || 0) - new Date(a.deletedAt || 0));
  } catch {
    return [];
  }
}

function isTrashFile(file) {
  return /^[a-z0-9][a-z0-9._-]*\.json$/i.test(file || '') && !file.includes('/');
}

/** Put one back. Refuses to overwrite an initiative that exists again. */
function restore(file) {
  if (!isTrashFile(file)) return null;
  const fp = path.join(TRASH_DIR, file);
  if (!fs.existsSync(fp)) return null;

  const raw = readJson(fp);
  if (!raw?.id) return null;
  if (get(raw.id)) return { conflict: true, id: raw.id };

  delete raw.deletedAt;
  const restored = save(addEvent(normalize(raw), 'restored', 'Restored from trash'));
  fs.unlinkSync(fp);
  return { initiative: restored };
}

function purgeTrash(file) {
  if (!isTrashFile(file)) return false;
  const fp = path.join(TRASH_DIR, file);
  if (!fs.existsSync(fp)) return false;
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

// ─── Messages waiting for an agent ───────────────────────────────────────────

function queueMessage(initiative, message) {
  const entry = { ts: new Date().toISOString(), message: String(message || '').slice(0, 4000) };
  initiative.pendingMessages = [...(initiative.pendingMessages || []), entry].slice(-20);
  addEvent(initiative, 'message-queued', entry.message.slice(0, 200));
  return entry;
}

function takePendingMessages(initiative) {
  const pending = initiative.pendingMessages || [];
  initiative.pendingMessages = [];
  return pending;
}

// ─── Definition of done ──────────────────────────────────────────────────────

function unmetCriteria(initiative) {
  return (initiative.acceptance || []).filter(c => c.status === 'unmet');
}

/** Criteria a machine can settle, as opposed to the ones that need your eyes. */
function checkableCriteria(initiative) {
  return (initiative.acceptance || []).filter(c => c.check?.type && c.check.type !== 'human');
}

function setCriterionStatus(initiative, id, status, detail = '') {
  const criterion = (initiative.acceptance || []).find(c => c.id === id);
  if (!criterion) return null;
  const changed = criterion.status !== status;
  criterion.status = status;
  criterion.detail = detail || criterion.detail;
  criterion.checkedAt = new Date().toISOString();
  if (changed) addEvent(initiative, `dod-${status}`, `${criterion.text}${detail ? ` — ${detail}` : ''}`, { criterionId: id });
  return criterion;
}

function setAcceptance(initiative, criteria) {
  initiative.acceptance = (criteria || []).map(normalizeCriterion);
  addEvent(initiative, 'dod-set', `Definition of done: ${initiative.acceptance.length} criteria — ${initiative.acceptance.map(c => c.text).join('; ').slice(0, 400)}`);
  return initiative.acceptance;
}

// ─── Workers ─────────────────────────────────────────────────────────────────

function activeWorkers(initiative) {
  return (initiative.workers || [])
    .filter(w => w.role !== 'orchestrator')
    .filter(w => w.status === 'starting' || w.status === 'working');
}

/** The run's orchestrator, if it has one running. */
function orchestrator(initiative) {
  return (initiative.workers || []).find(w => w.role === 'orchestrator' && w.status !== 'gone') || null;
}

function workerFor(initiative, taskId) {
  return (initiative.workers || []).find(w => w.taskId === taskId && w.status !== 'gone' && w.status !== 'done');
}

function addWorker(initiative, worker) {
  const entry = normalizeWorker({
    ...worker,
    id: worker.id || `worker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  }, (initiative.workers || []).length);
  initiative.workers = [...(initiative.workers || []), entry];
  addEvent(initiative, 'worker-started', `${entry.name} → tmux ${entry.sessionName}${entry.worktree ? ` (worktree ${entry.worktree.branch})` : ''}`, { workerId: entry.id });
  return entry;
}

function retireWorker(initiative, workerId, status = 'done', detail = '') {
  const worker = (initiative.workers || []).find(w => w.id === workerId);
  if (!worker) return null;
  worker.status = status;
  worker.finishedAt = new Date().toISOString();
  addEvent(initiative, 'worker-finished', `${worker.name} ${status}${detail ? ` — ${detail}` : ''}`, { workerId });
  return worker;
}

// ─── Parallel tasks ──────────────────────────────────────────────────────────

function stageTasks(stage) {
  return Array.isArray(stage?.tasks) ? stage.tasks : [];
}

/** Tasks that still need a worker on them. */
function pendingTasks(stage) {
  return stageTasks(stage).filter(t => t.status === 'pending');
}

function unfinishedTasks(stage) {
  return stageTasks(stage).filter(t => t.status !== 'done' && t.status !== 'skipped');
}

function allTasksSettled(stage) {
  const tasks = stageTasks(stage);
  return tasks.length > 0 && tasks.every(t => t.status === 'done' || t.status === 'skipped');
}

function setTaskStatus(initiative, stage, taskId, status, detail = '') {
  const task = stageTasks(stage).find(t => t.id === taskId);
  if (!task) return null;
  task.status = status;
  if (status === 'done' || status === 'skipped') task.finishedAt = new Date().toISOString();
  if (status === 'active' && !task.startedAt) task.startedAt = new Date().toISOString();
  addEvent(initiative, `task-${status}`, `${task.name}${detail ? ` — ${detail}` : ''}`, { taskId });
  return task;
}

/** Split the current stage into parallel tasks. */
function setStageTasks(initiative, stageId, tasks) {
  const stage = initiative.stages.find(s => s.id === stageId) || currentStage(initiative);
  if (!stage) return null;
  stage.tasks = tasks.map((t, i) => normalizeTask({
    ...t,
    id: t.id || `task-${Date.now()}-${i}`,
  }, i));
  addEvent(initiative, 'stage-split', `${stage.name} split into ${stage.tasks.length} parallel task(s): ${stage.tasks.map(t => t.name).join(', ')}`);
  return stage;
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
  listTrash,
  restore,
  purgeTrash,
  TRASH_DIR,
  addEvent,
  openGate,
  openGates,
  resolveGate,
  currentStage,
  advanceStage,
  skipStage,
  normalizeWorker,
  normalizeCriterion,
  queueMessage,
  takePendingMessages,
  unmetCriteria,
  checkableCriteria,
  setCriterionStatus,
  setAcceptance,
  activeWorkers,
  orchestrator,
  workerFor,
  addWorker,
  retireWorker,
  stageTasks,
  pendingTasks,
  unfinishedTasks,
  allTasksSettled,
  setTaskStatus,
  setStageTasks,
};
