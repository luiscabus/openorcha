// The initiative supervisor.
//
// This is the part that replaces you as the operator. It watches every running
// initiative, and on each tick it decides — from rules first, from a short LLM
// call only when the rules don't cover the situation — whether to approve a
// prompt, nudge an agent, advance a stage, or stop and ask you.
//
// It runs work in parallel on two axes: several initiatives at once, and
// several workers inside one initiative when a stage is split into tasks. Each
// parallel worker gets its own git worktree, because two agents sharing a
// working tree fight over the branch and the index.

const path = require('path');
const { execSync, execFile } = require('child_process');

const store = require('./initiativeStore');
const policy = require('./initiativePolicy');
const { runCheck, repoSnapshot, currentBranch } = require('./initiativeChecks');
const { launchAgentAsync } = require('./agentLauncher');
const worktrees = require('./initiativeWorktrees');
const { AGENT_DEFS } = require('./agentParsers');
const { getSessionResolver } = require('./sessionResolvers');
const { buildProcTable, getCwdMap } = require('./processTree');
const {
  shellEscape,
  buildTmuxPaneMap,
  buildScreenMap,
  detectMultiplexer,
  tmuxSessionNameFromMux,
  captureMuxText,
  captureAgentPaneText,
  detectCodexTerminalState,
  parsePermissionPrompt,
} = require('./multiplexer');

const TICK_MS = 6000;
// Don't act twice in quick succession: agents need room to actually work.
const MIN_ACTION_MS = 20000;
// A worker must look idle on two consecutive ticks before we treat it as idle,
// so we never interrupt a pause between tool calls.
const IDLE_TICKS_REQUIRED = 2;
// Stage checks can be expensive (a test command), so re-run them sparingly.
const CHECK_MIN_MS = 45000;
const LLM_TIMEOUT_MS = 90000;
const LLM_MAX_PER_HOUR = 20;
// A worker that has just been launched needs time to boot before we judge it.
const WORKER_BOOT_GRACE_MS = 30000;
// Ceiling across every initiative, so a fan-out cannot flood the machine.
const MAX_TOTAL_AGENTS = parseInt(process.env.OPENORCHA_MAX_AGENTS, 10) || 6;
// How many times a vanished worker is restarted before it becomes your problem.
const MAX_WORKER_RESTARTS = 2;

let timer = null;
let ticking = false;
const runtime = new Map();
const inFlight = new Set();
const log = [];

function rt(key) {
  if (!runtime.has(key)) {
    runtime.set(key, {
      idleTicks: 0,
      lastActionAt: 0,
      lastCheckAt: 0,
      lastCheck: null,
      llmInFlight: false,
      llmCalls: [],
      lastPromptSignature: null,
      restarts: 0,
    });
  }
  return runtime.get(key);
}

function workerKey(initiativeId, workerId) {
  return `${initiativeId}:${workerId}`;
}

function note(message, initiativeId = null) {
  const entry = { ts: new Date().toISOString(), initiativeId, message };
  log.push(entry);
  if (log.length > 300) log.shift();
  return entry;
}

// ─── Process snapshot ────────────────────────────────────────────────────────

// Taken once per tick and shared by every initiative: with a pool of workers,
// re-running `ps` per lane is the most expensive thing in the loop.
function takeSnapshot() {
  let psOut = '';
  try {
    psOut = execSync('ps -eo pid,pcpu,tty,args 2>/dev/null', { encoding: 'utf8' });
  } catch {
    return { agents: [], procs: {} };
  }

  const procs = buildProcTable();
  const tmuxMap = buildTmuxPaneMap();
  const screenMap = buildScreenMap();
  const agents = [];

  for (const line of psOut.trim().split('\n').slice(1)) {
    const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)/);
    if (!m) continue;
    const [, pid, cpu, tty, args] = m;
    const bin = path.basename(args.split(/\s+/)[0]);
    const def = AGENT_DEFS.find(d => d.match(bin, args));
    if (!def) continue;
    const mux = detectMultiplexer(pid, tty === '??' ? null : tty, procs, tmuxMap, screenMap);
    const session = tmuxSessionNameFromMux(mux);
    if (!session) continue;
    agents.push({ pid, agentId: def.id, cpu: parseFloat(cpu), mux, args, tty, session });
  }

  return { agents, procs };
}

/** The live agent for one tmux session, or null. */
function agentForSession(sessionName, snapshot) {
  if (!sessionName) return null;
  const matches = snapshot.agents.filter(a => a.session === sessionName);
  if (!matches.length) return null;
  // Several processes can share a pane; keep the root of the tree.
  const pids = new Set(matches.map(m => m.pid));
  const root = matches.find(m => !pids.has(snapshot.procs[m.pid]?.ppid)) || matches[0];
  root.cpu = matches.reduce((sum, m) => sum + m.cpu, 0);
  root.cwd = getCwdMap([root.pid])[root.pid] || null;
  return root;
}

/** Kept for the API and tests: find an initiative's first live agent. */
function findAgent(initiative, snapshot = takeSnapshot()) {
  for (const worker of store.activeWorkers(initiative)) {
    const agent = agentForSession(worker.sessionName, snapshot);
    if (agent) return { ...agent, cwd: agent.cwd || worker.cwd || initiative.cwd, workerId: worker.id };
  }
  return null;
}

function liveAgentCount(snapshot = takeSnapshot()) {
  let count = 0;
  for (const initiative of store.list()) {
    for (const worker of store.activeWorkers(initiative)) {
      if (agentForSession(worker.sessionName, snapshot)) count += 1;
    }
  }
  return count;
}

/** Same inference the AI Agents tab shows, reused so the UI and the loop agree. */
function inferStatus(agent) {
  const text = agent.mux ? captureMuxText(agent.mux, agent.pid, -60) : '';
  const prompt = text ? parsePermissionPrompt(text) : null;
  if (prompt) return { status: 'waiting_input', prompt, text };
  if (agent.agentId === 'codex' && text && detectCodexTerminalState(text) === 'thinking') {
    return { status: 'thinking', prompt: null, text };
  }
  const lines = (text || '').split('\n').filter(l => l.trim());
  const lastLine = lines[lines.length - 1]?.trim() || '';
  if (/^[❯>]\s*$/.test(lastLine) && agent.cpu < 2) return { status: 'idle', prompt: null, text };
  if (agent.cpu > 2) return { status: 'thinking', prompt: null, text };
  return { status: 'idle', prompt: null, text };
}

function parsedMessages(agent, count = 6) {
  try {
    const resolver = getSessionResolver(agent.agentId);
    if (!resolver?.resolveLiveSession) return [];
    const paneText = ['claude', 'codex'].includes(agent.agentId) ? captureAgentPaneText(agent.pid) : '';
    const resolved = resolver.resolveLiveSession({ cwd: agent.cwd, pid: agent.pid, args: agent.args || '', paneText });
    if (!resolved) return [];
    const parsed = resolver.parseResolved(resolved);
    return (parsed?.messages || []).slice(-count);
  } catch {
    return [];
  }
}

function lastAssistantText(agent) {
  const messages = parsedMessages(agent, 12);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && (messages[i].text || '').trim()) return messages[i].text;
  }
  return '';
}

// ─── Sending input ───────────────────────────────────────────────────────────

function sendToAgent(agent, message, { noEnter = false } = {}) {
  if (!agent.mux) throw new Error('agent is not in a multiplexer');
  const target = agent.mux.type === 'tmux' ? agent.mux.target : agent.mux.session;
  if (agent.mux.type === 'tmux') {
    execSync(`tmux send-keys -t ${shellEscape(target)} ${shellEscape(message)}`, { timeout: 5000 });
    if (!noEnter) {
      execSync('sleep 0.15');
      execSync(`tmux send-keys -t ${shellEscape(target)} Enter`, { timeout: 5000 });
    }
    return;
  }
  execSync(`screen -S ${shellEscape(target)} -X stuff ${shellEscape(noEnter ? message : `${message}\n`)}`, { timeout: 5000 });
}

function answerPrompt(agent, verdict) {
  if (verdict.optionKey) {
    sendToAgent(agent, String(verdict.optionKey), { noEnter: true });
    execSync('sleep 0.2');
    if (agent.mux.type === 'tmux') {
      execSync(`tmux send-keys -t ${shellEscape(agent.mux.target)} Enter`, { timeout: 5000 });
    } else {
      sendToAgent(agent, '', {});
    }
    return;
  }
  const delta = (verdict.optionIndex || 0) - (verdict.selectedIdx || 0);
  const key = delta > 0 ? 'Down' : 'Up';
  if (agent.mux.type === 'tmux') {
    for (let i = 0; i < Math.abs(delta); i++) {
      execSync(`tmux send-keys -t ${shellEscape(agent.mux.target)} ${key}`, { timeout: 5000 });
    }
    execSync(`tmux send-keys -t ${shellEscape(agent.mux.target)} Enter`, { timeout: 5000 });
  }
}

// ─── Notifications ───────────────────────────────────────────────────────────

function notify(title, message) {
  if (process.platform !== 'darwin') return;
  try {
    const script = `display notification ${JSON.stringify(String(message).slice(0, 220))} with title ${JSON.stringify(String(title).slice(0, 60))} sound name "Submarine"`;
    execSync(`osascript -e ${shellEscape(script)}`, { timeout: 4000 });
  } catch {}
}

// ─── The LLM decider ─────────────────────────────────────────────────────────

function llmBudgetLeft(state) {
  const cutoff = Date.now() - 3600000;
  state.llmCalls = state.llmCalls.filter(ts => ts > cutoff);
  return LLM_MAX_PER_HOUR - state.llmCalls.length;
}

function buildDecisionPrompt(initiative, work, messages, checkDetail) {
  const transcript = messages
    .map(m => `${m.role === 'assistant' ? 'AGENT' : 'USER'}: ${String(m.text || '').slice(0, 900)}`)
    .join('\n\n');

  return [
    'You are supervising a coding agent so its human operator does not have to sit and watch it.',
    '',
    `INITIATIVE: ${initiative.name}`,
    `GOAL: ${initiative.goal || '(not stated)'}`,
    `CURRENT WORK: ${work?.name} — ${work?.instruction || ''}`,
    `CHECK: ${policy.describeCheck(work?.check)} — last result: ${checkDetail || 'not evaluated'}`,
    `AUTONOMY: ${initiative.profile} (local work, commits, pushes and draft PRs are pre-approved; posting review comments, non-draft PRs, Jira writes and merges are not)`,
    '',
    'RECENT TRANSCRIPT:',
    transcript || '(no messages)',
    '',
    'The agent is idle. Choose ONE action:',
    '  "continue" — it can keep working; supply the message to send it.',
    '  "advance"  — the work is genuinely finished even though the check could not confirm it.',
    '  "gate"     — it needs a decision only the human can make; supply the question and 2-3 options.',
    '',
    'Prefer "continue". Only choose "gate" for a decision that is irreversible, outward-facing,',
    'or a product/scope judgement the code cannot answer.',
    '',
    'Reply with ONLY a JSON object, no prose, no code fence:',
    '{"action":"continue|advance|gate","message":"text to send if continue","question":"if gate","options":["..."],"defaultOption":"the safe reversible choice, or null","reason":"one short sentence"}',
  ].join('\n');
}

function extractJson(text) {
  const t = String(text || '');
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function askLlm(initiative, work, messages, checkDetail, cwd) {
  return new Promise(resolve => {
    execFile(
      'claude',
      ['-p', buildDecisionPrompt(initiative, work, messages, checkDetail), '--output-format', 'json', '--model', 'sonnet'],
      { cwd: cwd || initiative.cwd, timeout: LLM_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: process.env },
      (err, stdout) => {
        if (err && !stdout) return resolve(null);
        let text = stdout;
        const envelope = extractJson(stdout);
        if (envelope && typeof envelope.result === 'string') text = envelope.result;
        const decision = extractJson(text);
        if (!decision || !['continue', 'advance', 'gate'].includes(decision.action)) return resolve(null);
        resolve(decision);
      },
    );
  });
}

// ─── Briefings ───────────────────────────────────────────────────────────────

function briefing(initiative, work, worker) {
  return [
    `[OpenOrcha · ${initiative.name}] ${work.name}.`,
    work.instruction,
    work.check ? `This is done when ${policy.describeCheck(work.check)}.` : '',
    initiative.goal ? `Overall goal: ${initiative.goal}` : '',
    worker?.worktree ? `You are on branch ${worker.worktree.branch} in your own worktree — other agents are working in parallel on sibling branches, so stay inside this directory.` : '',
    initiative.integration?.branches?.length && !worker?.taskId
      ? `Parallel work landed on these branches: ${initiative.integration.branches.join(', ')}. Merge them into this branch before continuing.`
      : '',
    'Work through it without asking for confirmation on reversible steps. If you must make a judgement call, take the safe option and note the assumption in one line.',
  ].filter(Boolean).join(' ');
}

function openGateAndNotify(initiative, gate) {
  const entry = store.openGate(initiative, gate);
  if (initiative.notifyOnGate) notify(`${initiative.name} needs you`, entry.question);
  note(`gate opened: ${entry.question}`, initiative.id);
  return entry;
}

// ─── Worker provisioning ─────────────────────────────────────────────────────

/**
 * Make sure the current stage has the workers it needs, without exceeding the
 * initiative's fan-out or the machine-wide agent budget.
 */
async function ensureWorkers(initiative, stage, snapshot) {
  const active = store.activeWorkers(initiative);
  const tasks = store.stageTasks(stage);
  const globalRoom = MAX_TOTAL_AGENTS - liveAgentCount(snapshot);
  if (globalRoom <= 0) return false;

  // A stage with no tasks runs on a single worker, as before.
  if (!tasks.length) {
    if (active.length) return false;
    await startWorker(initiative, { name: stage.name, stageId: stage.id });
    return true;
  }

  const pending = store.pendingTasks(stage);
  const room = Math.min(
    initiative.maxParallel - active.length,
    pending.length,
    globalRoom,
  );
  if (room <= 0) return false;

  // Start one worker per tick: launching blocks on tmux for a moment, and a
  // staggered ramp keeps the loop responsive for every other lane.
  const task = pending[0];
  await startWorker(initiative, { name: `${stage.name}: ${task.name}`, stageId: stage.id, task });
  return true;
}

async function startWorker(initiative, { name, stageId, task }) {
  const stage = initiative.stages.find(s => s.id === stageId);
  let cwd = initiative.cwd;
  let worktree = null;

  // Parallel workers each get their own worktree; a lone worker uses the
  // initiative directory directly.
  if (task && stage?.isolate) {
    worktree = worktrees.ensureWorktree(initiative.cwd, {
      name: `${initiative.name}-${task.name}`,
      branchPrefix: initiative.branchPrefix,
      worktreeRoot: initiative.worktreeRoot,
    });
    if (worktree) {
      cwd = worktree.path;
    } else {
      store.addEvent(initiative, 'warning', `Could not create a worktree for "${task.name}" — it will share ${initiative.cwd}`);
    }
  }

  let sessionName;
  try {
    ({ sessionName } = await launchAgentAsync({
      agentId: initiative.agentId,
      cwd,
      sessionName: `init-${worktrees.slug(name)}`.slice(0, 40),
      skipPermissions: false,
      presetFlags: '',
    }));
  } catch (e) {
    store.addEvent(initiative, 'error', `Could not launch a worker: ${e.message}`);
    store.save(initiative);
    return null;
  }

  const fresh = store.get(initiative.id) || initiative;
  const worker = store.addWorker(fresh, {
    name,
    sessionName,
    agentId: fresh.agentId,
    taskId: task?.id || null,
    stageId,
    cwd,
    worktree: worktree ? { path: worktree.path, branch: worktree.branch } : null,
  });
  if (task) {
    const freshStage = fresh.stages.find(s => s.id === stageId);
    store.setTaskStatus(fresh, freshStage, task.id, 'active', worker.name);
    const t = store.stageTasks(freshStage).find(x => x.id === task.id);
    if (t) {
      t.workerId = worker.id;
      t.branch = worktree?.branch || null;
    }
  }
  note(`worker started: ${worker.name}`, fresh.id);
  store.save(fresh);
  return worker;
}

// ─── One worker, one tick ────────────────────────────────────────────────────

async function tickWorker(initiative, worker, stage, snapshot) {
  const key = workerKey(initiative.id, worker.id);
  const state = rt(key);
  const task = worker.taskId ? store.stageTasks(stage).find(t => t.id === worker.taskId) : null;
  const work = task || stage;
  const agent = agentForSession(worker.sessionName, snapshot);

  if (!agent) return handleMissingWorker(initiative, worker, stage, task, state);

  // A freshly launched worker gets its briefing once the CLI is up.
  if (!worker.briefed) {
    if (Date.now() - new Date(worker.startedAt).getTime() < 6000) return null;
    try {
      sendToAgent({ ...agent, cwd: worker.cwd }, briefing(initiative, work, worker));
      worker.briefed = true;
      worker.status = 'working';
      state.lastActionAt = Date.now();
      store.addEvent(initiative, 'briefed', `${worker.name} briefed on ${work.name}`, { workerId: worker.id });
      return store.save(initiative);
    } catch {
      return null;
    }
  }

  agent.cwd = agent.cwd || worker.cwd || initiative.cwd;
  const { status, prompt } = inferStatus(agent);

  if (status === 'thinking') {
    state.idleTicks = 0;
    return null;
  }

  const isPrompt = status === 'waiting_input' && prompt;
  if (!isPrompt) {
    state.idleTicks += 1;
    if (state.idleTicks < IDLE_TICKS_REQUIRED) return null;
    if (Date.now() - state.lastActionAt < MIN_ACTION_MS) return null;
  } else {
    const signature = `${prompt.question}|${(prompt.options || []).map(o => o.label).join('|')}`;
    if (state.lastPromptSignature === signature && Date.now() - state.lastActionAt < MIN_ACTION_MS) return null;
    state.lastPromptSignature = signature;
  }

  const stopText = isPrompt ? '' : lastAssistantText(agent);
  const checkCwd = worker.cwd || initiative.cwd;

  let checkPassed = state.lastCheck?.passed ?? null;
  let checkDetail = state.lastCheck?.detail || '';
  if (!isPrompt && work?.check && Date.now() - state.lastCheckAt > CHECK_MIN_MS) {
    const result = runCheck(work.check, checkCwd);
    state.lastCheck = result;
    state.lastCheckAt = Date.now();
    checkPassed = result.passed;
    checkDetail = result.detail;
    if (result.passed === false) work.consecutiveFailures = (work.consecutiveFailures || 0) + 1;
    else if (result.passed === true) work.consecutiveFailures = 0;
  }

  const decision = policy.decide({
    status,
    prompt,
    stopText,
    stage: work,
    checkPassed,
    nudges: work?.nudges || 0,
    consecutiveFailures: work?.consecutiveFailures || 0,
    profile: initiative.profile,
    protectedBranch: isProtectedBranch(checkCwd),
    isLastStage: !task && initiative.stageIndex >= initiative.stages.length - 1,
  });

  return applyDecision(initiative, { agent, worker, stage, task, work, state, checkDetail }, decision);
}

function isProtectedBranch(cwd) {
  const branch = currentBranch(cwd);
  return ['master', 'main'].includes(branch);
}

function handleMissingWorker(initiative, worker, stage, task, state) {
  // Still booting — tmux exists before the CLI does.
  if (Date.now() - new Date(worker.startedAt).getTime() < WORKER_BOOT_GRACE_MS) return null;

  store.retireWorker(initiative, worker.id, 'gone', 'agent process disappeared');

  if (task) {
    // One of many: restart it rather than spending your attention.
    state.restarts += 1;
    if (state.restarts <= MAX_WORKER_RESTARTS) {
      store.setTaskStatus(initiative, stage, task.id, 'pending', `worker vanished, restarting (${state.restarts})`);
      return store.save(initiative);
    }
    openGateAndNotify(initiative, {
      kind: 'stuck',
      question: `The worker for "${task.name}" keeps dying. Retry it, drop the task, or stop the run?`,
      options: ['Retry once more', 'Skip this stage', 'Stop the run'],
      reason: `${state.restarts} failed worker starts`,
    });
    return store.save(initiative);
  }

  const alreadyAsked = store.openGates(initiative).some(g => g.kind === 'agent-exited');
  if (!alreadyAsked) {
    openGateAndNotify(initiative, {
      kind: 'agent-exited',
      question: `The agent for "${initiative.name}" is no longer running. Relaunch and continue from "${stage?.name}"?`,
      options: ['Relaunch', 'Stop the run'],
      defaultOption: 'Relaunch',
      reason: 'agent process disappeared',
    });
  }
  return store.save(initiative);
}

// ─── Acting on a decision ────────────────────────────────────────────────────

async function applyDecision(initiative, ctx, decision) {
  const { agent, worker, stage, task, work, state } = ctx;

  switch (decision.action) {
    case 'wait':
      return null;

    case 'approve': {
      try {
        answerPrompt(agent, decision);
        initiative.stats.autoApprovals += 1;
        state.lastActionAt = Date.now();
        store.addEvent(initiative, 'auto-approved', `${worker.name}: ${decision.command || 'prompt'} — ${decision.reason}`, { workerId: worker.id });
        note(`auto-approved: ${decision.command || decision.reason}`, initiative.id);
      } catch (e) {
        openGateAndNotify(initiative, {
          kind: 'permission',
          question: 'Could not answer the permission prompt automatically.',
          reason: e.message,
          options: ['I handled it', 'Stop the run'],
        });
      }
      return store.save(initiative);
    }

    case 'nudge': {
      sendToAgent(agent, decision.message);
      work.nudges = (work.nudges || 0) + 1;
      initiative.stats.nudges += 1;
      state.lastActionAt = Date.now();
      state.idleTicks = 0;
      store.addEvent(initiative, 'nudge', `${worker.name}: ${decision.reason}`, { workerId: worker.id });
      note(`nudged ${worker.name}: ${decision.reason}`, initiative.id);
      return store.save(initiative);
    }

    case 'advance':
    case 'complete': {
      state.lastCheck = null;
      state.lastCheckAt = 0;
      state.lastActionAt = Date.now();
      state.idleTicks = 0;

      // A task finishing retires its worker; the stage advances only once every
      // parallel task is settled.
      if (task) {
        store.setTaskStatus(initiative, stage, task.id, 'done', decision.reason);
        store.retireWorker(initiative, worker.id, 'done', task.name);
        note(`task done: ${task.name}`, initiative.id);
        return store.save(initiative);
      }

      const next = store.advanceStage(initiative, decision.reason);
      if (next) {
        store.retireWorker(initiative, worker.id, 'done', `finished ${stage.name}`);
        note(`advanced to ${next.name}`, initiative.id);
      } else {
        initiative.status = 'done';
        store.retireWorker(initiative, worker.id, 'done', 'initiative complete');
        notify(`${initiative.name} finished`, 'All stages complete.');
        note('initiative complete', initiative.id);
      }
      return store.save(initiative);
    }

    case 'gate': {
      openGateAndNotify(initiative, {
        kind: decision.kind,
        question: `${worker.name}: ${decision.question}`,
        options: decision.options,
        defaultOption: decision.defaultOption,
        reason: decision.reason,
        command: decision.command,
        context: ctx.checkDetail,
        workerId: worker.id,
      });
      state.lastActionAt = Date.now();
      return store.save(initiative);
    }

    case 'ask-llm': {
      // Fired and forgotten: awaiting a 90-second judgement call inside the
      // tick would freeze every other worker and every other initiative.
      if (state.llmInFlight) return null;
      if (llmBudgetLeft(state) <= 0) {
        openGateAndNotify(initiative, {
          kind: 'decision',
          question: `"${initiative.name}" needs a decision and the supervisor has used its hourly judgement budget.`,
          options: ['Keep going', 'Stop the run'],
          reason: 'LLM decision budget exhausted',
        });
        return store.save(initiative);
      }

      state.llmInFlight = true;
      state.llmCalls.push(Date.now());
      const messages = parsedMessages(agent);
      askLlm(initiative, work, messages, ctx.checkDetail, worker.cwd)
        .then(result => applyLlmResult(initiative.id, worker.id, result, ctx.checkDetail))
        .catch(() => {})
        .finally(() => { state.llmInFlight = false; });
      return null;
    }

    default:
      return null;
  }
}

function applyLlmResult(initiativeId, workerId, result, checkDetail) {
  const initiative = store.get(initiativeId);
  if (!initiative || initiative.status !== 'running') return;

  const worker = (initiative.workers || []).find(w => w.id === workerId);
  if (!worker || worker.status === 'done' || worker.status === 'gone') return;

  const stage = store.currentStage(initiative);
  const task = worker.taskId ? store.stageTasks(stage).find(t => t.id === worker.taskId) : null;
  const work = task || stage;
  const state = rt(workerKey(initiativeId, workerId));
  initiative.stats.llmDecisions += 1;

  if (!result || result.action === 'gate') {
    openGateAndNotify(initiative, {
      kind: 'decision',
      question: result?.question || `"${worker.name}" is idle and the supervisor could not work out the next step.`,
      options: Array.isArray(result?.options) ? result.options : ['Keep going', 'Skip this stage', 'Stop the run'],
      defaultOption: result?.defaultOption || null,
      reason: result?.reason || 'judgement call failed or timed out',
      context: checkDetail,
      workerId,
    });
    store.save(initiative);
    return;
  }

  const agent = agentForSession(worker.sessionName, takeSnapshot());
  if (!agent) return;

  if (result.action === 'advance') {
    if (task) {
      store.setTaskStatus(initiative, stage, task.id, 'done', result.reason || 'judged complete');
      store.retireWorker(initiative, worker.id, 'done', task.name);
    } else {
      const next = store.advanceStage(initiative, result.reason || 'judged complete');
      store.retireWorker(initiative, worker.id, 'done', `finished ${stage.name}`);
      if (!next) initiative.status = 'done';
    }
    state.lastCheck = null;
    state.lastCheckAt = 0;
    state.lastActionAt = Date.now();
    store.save(initiative);
    return;
  }

  const message = result.message || `Continue with ${work.name}.`;
  try {
    sendToAgent(agent, message);
  } catch {
    return;
  }
  work.nudges = (work.nudges || 0) + 1;
  initiative.stats.nudges += 1;
  state.lastActionAt = Date.now();
  state.idleTicks = 0;
  store.addEvent(initiative, 'llm-continue', `${worker.name}: ${result.reason || 'judged safe to continue'}`, { workerId });
  note(`llm decided continue for ${worker.name}`, initiative.id);
  store.save(initiative);
}

// ─── One initiative, one tick ────────────────────────────────────────────────

async function tickOne(initiative, snapshot = takeSnapshot()) {
  const auto = autoDecideStaleGates(initiative);
  if (auto) return auto;

  if (initiative.status !== 'running') return null;
  if (inQuietHours(initiative)) return null;

  const stage = store.currentStage(initiative);
  if (!stage) return null;

  // A fanned-out stage is finished when every task is settled.
  if (store.allTasksSettled(stage)) return settleParallelStage(initiative, stage);

  const started = await ensureWorkers(initiative, stage, snapshot);
  if (started) return store.get(initiative.id);

  const fresh = store.get(initiative.id) || initiative;
  const freshStage = store.currentStage(fresh);
  for (const worker of store.activeWorkers(fresh)) {
    try {
      await tickWorker(fresh, worker, freshStage, snapshot);
    } catch (e) {
      note(`worker error (${worker.name}): ${e.message}`, fresh.id);
    }
  }
  return store.get(fresh.id);
}

/** Collect the parallel branches, then move on to the next stage. */
function settleParallelStage(initiative, stage) {
  const branches = store.stageTasks(stage).map(t => t.branch).filter(Boolean);
  for (const worker of store.activeWorkers(initiative)) {
    if (worker.stageId === stage.id) store.retireWorker(initiative, worker.id, 'done', 'stage complete');
  }
  if (branches.length) {
    initiative.integration = { branches, stageId: stage.id };
    store.addEvent(initiative, 'parallel-done', `${branches.length} parallel branch(es) ready to merge: ${branches.join(', ')}`);
  }
  const next = store.advanceStage(initiative, 'all parallel tasks complete');
  if (!next) initiative.status = 'done';
  note(`parallel stage "${stage.name}" complete`, initiative.id);
  return store.save(initiative);
}

function inQuietHours(initiative) {
  const q = initiative.quietHours;
  if (!q || !Number.isFinite(q.startHour) || !Number.isFinite(q.endHour)) return false;
  const hour = new Date().getHours();
  return q.startHour <= q.endHour
    ? hour >= q.startHour && hour < q.endHour
    : hour >= q.startHour || hour < q.endHour;
}

// ─── Gates ───────────────────────────────────────────────────────────────────

function autoDecideStaleGates(initiative) {
  const open = store.openGates(initiative);
  if (!open.length) return null;
  const ttl = initiative.autoDecideAfterMs;
  if (!ttl) return null;

  let changed = false;
  for (const gate of open) {
    if (!gate.defaultOption) continue;
    if (Date.now() - new Date(gate.createdAt).getTime() < ttl) continue;
    store.resolveGate(initiative, gate.id, gate.defaultOption, 'auto');
    applyGateAnswer(initiative, gate, gate.defaultOption);
    note(`auto-decided "${gate.question.slice(0, 60)}" → ${gate.defaultOption}`, initiative.id);
    changed = true;
  }
  return changed ? store.save(initiative) : null;
}

/**
 * Apply a gate answer to the run. Shared by the API (human answer) and the
 * auto-decide path.
 */
function applyGateAnswer(initiative, gate, answer) {
  const text = String(answer || '').trim();
  const lower = text.toLowerCase();

  if (/^stop/.test(lower)) {
    initiative.status = 'paused';
    store.addEvent(initiative, 'paused', 'Stopped at a gate');
    return;
  }

  if (gate.kind === 'agent-exited' && /^relaunch/.test(lower)) {
    initiative.workers = (initiative.workers || []).map(w => ({ ...w, status: 'gone' }));
    initiative.status = 'running';
    store.addEvent(initiative, 'relaunch', 'Relaunching the agent for this initiative');
    return;
  }

  if (/^skip/.test(lower)) {
    store.skipStage(initiative, 'skipped at a gate');
    initiative.status = 'running';
    return;
  }

  initiative.status = 'running';
  const snapshot = takeSnapshot();
  const worker = gate.workerId
    ? (initiative.workers || []).find(w => w.id === gate.workerId)
    : store.activeWorkers(initiative)[0];
  const agent = worker ? agentForSession(worker.sessionName, snapshot) : findAgent(initiative, snapshot);
  if (!agent) return;

  try {
    sendToAgent(agent, gate.kind === 'permission' ? text : `[OpenOrcha] ${text}`);
    const key = workerKey(initiative.id, worker?.id || 'main');
    rt(key).lastActionAt = Date.now();
    rt(key).idleTicks = 0;
  } catch (e) {
    store.addEvent(initiative, 'error', `Could not deliver the answer: ${e.message}`);
  }
}

// ─── Digest ──────────────────────────────────────────────────────────────────

/**
 * What happened while you were away. Built from the event log, so it costs no
 * agent time to produce.
 */
function buildDigest(sinceIso) {
  const since = sinceIso ? new Date(sinceIso) : new Date(Date.now() - 12 * 3600 * 1000);
  const initiatives = store.list();
  const items = [];

  for (const initiative of initiatives) {
    const events = (initiative.events || []).filter(e => new Date(e.ts) >= since);
    if (!events.length && initiative.status !== 'blocked') continue;

    const counts = events.reduce((acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1;
      return acc;
    }, {});

    items.push({
      id: initiative.id,
      name: initiative.name,
      status: initiative.status,
      stage: store.currentStage(initiative)?.name || null,
      stagesCompleted: events.filter(e => e.type === 'stage-done').map(e => e.stageName),
      tasksCompleted: events.filter(e => e.type === 'task-done').length,
      workersStarted: counts['worker-started'] || 0,
      activeWorkers: store.activeWorkers(initiative).map(w => ({ name: w.name, branch: w.worktree?.branch || null })),
      autoApprovals: counts['auto-approved'] || 0,
      nudges: (counts.nudge || 0) + (counts['llm-continue'] || 0),
      gatesOpened: counts['gate-opened'] || 0,
      autoDecided: events.filter(e => e.type === 'gate-resolved' && /auto-decided/.test(e.detail)).length,
      openGates: store.openGates(initiative).map(g => ({ id: g.id, question: g.question, kind: g.kind, createdAt: g.createdAt })),
      repo: repoSnapshot(initiative.cwd),
      branches: initiative.integration?.branches || [],
      lastEvent: events[events.length - 1] || null,
    });
  }

  const totals = items.reduce((acc, i) => ({
    autoApprovals: acc.autoApprovals + i.autoApprovals,
    nudges: acc.nudges + i.nudges,
    stages: acc.stages + i.stagesCompleted.length,
    tasks: acc.tasks + i.tasksCompleted,
    openGates: acc.openGates + i.openGates.length,
    workers: acc.workers + i.activeWorkers.length,
  }), { autoApprovals: 0, nudges: 0, stages: 0, tasks: 0, openGates: 0, workers: 0 });

  return { since: since.toISOString(), generatedAt: new Date().toISOString(), totals, items };
}

// ─── Loop ────────────────────────────────────────────────────────────────────

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const snapshot = takeSnapshot();
    const runnable = store.list().filter(i => !['done', 'failed', 'draft'].includes(i.status));

    // Lanes advance concurrently, and a lane already mid-tick is skipped rather
    // than queued — one slow initiative must never hold up the others.
    await Promise.all(runnable.map(async initiative => {
      if (inFlight.has(initiative.id)) return;
      inFlight.add(initiative.id);
      try {
        await tickOne(initiative, snapshot);
      } catch (e) {
        note(`tick error: ${e.message}`, initiative.id);
      } finally {
        inFlight.delete(initiative.id);
      }
    }));
  } finally {
    ticking = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
  note('supervisor started');
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  note('supervisor stopped');
}

function status() {
  return {
    running: !!timer,
    tickMs: TICK_MS,
    maxTotalAgents: MAX_TOTAL_AGENTS,
    liveAgents: liveAgentCount(),
    inFlight: [...inFlight],
    log: log.slice(-60),
  };
}

module.exports = {
  start,
  stop,
  status,
  tick,
  tickOne,
  findAgent,
  agentForSession,
  takeSnapshot,
  liveAgentCount,
  inferStatus,
  applyGateAnswer,
  buildDigest,
  startWorker,
  ensureWorkers,
  notify,
  MAX_TOTAL_AGENTS,
  TICK_MS,
};
