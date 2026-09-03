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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const store = require('./initiativeStore');
const policy = require('./initiativePolicy');
const { runCheck, repoSnapshot, currentBranch } = require('./initiativeChecks');
const { parsePsLineShort } = require('./psNumbers');
const { sendMuxInput, sendMuxKey } = require('./muxInput');
const { launchAgentAsync } = require('./agentLauncher');
const worktrees = require('./initiativeWorktrees');
const orch = require('./initiativeOrchestrator');
const { AGENT_DEFS } = require('./agentParsers');
const { getSessionResolver } = require('./sessionResolvers');
const { buildProcTable, getCwdMap } = require('./processTree');
const {
  shellEscape,
  tmuxSessionExists,
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
// How recently the agent must have produced a turn to count as still working.
const WORKING_QUIET_MS = 90000;
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
    psOut = execSync('LC_ALL=C ps -eo pid,pcpu,tty,args 2>/dev/null', { encoding: 'utf8' });
  } catch {
    return { agents: [], procs: {} };
  }

  const procs = buildProcTable();
  const tmuxMap = buildTmuxPaneMap();
  const screenMap = buildScreenMap();
  const agents = [];

  for (const line of psOut.trim().split('\n').slice(1)) {
    const parsed = parsePsLineShort(line);
    if (!parsed) continue;
    const { pid, cpu, tty, args } = parsed;
    const bin = path.basename(args.split(/\s+/)[0]);
    const def = AGENT_DEFS.find(d => d.match(bin, args));
    if (!def) continue;
    const mux = detectMultiplexer(pid, tty === '??' ? null : tty, procs, tmuxMap, screenMap);
    const session = tmuxSessionNameFromMux(mux);
    if (!session) continue;
    agents.push({ pid, agentId: def.id, cpu, mux, args, tty, session });
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

/**
 * An initiative's live agent, preferring one the record still calls active.
 *
 * Sessions outlive the record's idea of them: a finished initiative can still
 * have every agent sitting there, and refusing to talk to one because a field
 * says "done" is the record telling the operator what they can see is false.
 */
function findAgent(initiative, snapshot = takeSnapshot(), { workerId = null } = {}) {
  const workers = initiative.workers || [];
  const wanted = workerId ? workers.filter(w => w.id === workerId) : workers;
  const active = wanted.filter(w => w.status === 'starting' || w.status === 'working');

  for (const worker of [...active, ...wanted.filter(w => !active.includes(w))]) {
    const agent = agentForSession(worker.sessionName, snapshot);
    if (agent) return { ...agent, cwd: agent.cwd || worker.cwd || initiative.cwd, workerId: worker.id, workerName: worker.name };
  }
  return null;
}

/** Every worker of this initiative that still has a live session. */
function liveWorkers(initiative, snapshot = takeSnapshot()) {
  return (initiative.workers || [])
    .map(worker => {
      const agent = agentForSession(worker.sessionName, snapshot);
      return agent ? { worker, agent } : null;
    })
    .filter(Boolean);
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

function allMessages(agent) {
  try {
    const resolver = getSessionResolver(agent.agentId);
    if (!resolver) return [];

    // A remembered file wins: it is the one this worker was seen writing, and
    // it keeps working once the process is gone.
    if (agent.sessionFile && fs.existsSync(agent.sessionFile)) {
      const parsed = resolver.parseResolved({ sessionFile: agent.sessionFile });
      if (parsed?.messages) return parsed.messages;
    }

    if (!resolver.resolveLiveSession || !agent.pid) return [];
    const paneText = ['claude', 'codex'].includes(agent.agentId) ? captureAgentPaneText(agent.pid) : '';
    const resolved = resolver.resolveLiveSession({ cwd: agent.cwd, pid: agent.pid, args: agent.args || '', paneText });
    if (!resolved) return [];
    const parsed = resolver.parseResolved(resolved);
    if (parsed?.messages && resolved.sessionFile) agent.resolvedSessionFile = resolved.sessionFile;
    return parsed?.messages || [];
  } catch {
    return [];
  }
}

/** Remember which transcript a worker turned out to own. */
function rememberSessionFile(initiative, worker, agent) {
  if (!agent?.resolvedSessionFile || worker.sessionFile === agent.resolvedSessionFile) return false;
  worker.sessionFile = agent.resolvedSessionFile;
  return true;
}

/**
 * The messages of one worker, resolving and remembering its transcript on the
 * way. Uses the agent's real working directory rather than the recorded one —
 * they differ, and the difference is enough to find nothing.
 */
function workerMessages(initiative, worker, snapshot = takeSnapshot()) {
  const agent = worker.sessionName ? agentForSession(worker.sessionName, snapshot) : null;
  const probe = {
    agentId: worker.agentId || initiative.agentId,
    pid: agent?.pid || null,
    args: agent?.args || '',
    cwd: agent?.cwd || worker.cwd || initiative.cwd,
    sessionFile: worker.sessionFile || null,
  };
  const messages = allMessages(probe);
  if (rememberSessionFile(initiative, worker, probe)) store.save(initiative);
  return messages;
}

/**
 * The last few turns, rendered so a decider can tell what the agent is doing.
 *
 * A turn that only calls tools carries no text, and feeding those through as
 * empty lines told the decider nothing — it then re-issued instructions for
 * work already underway. Tool calls are the work, so they get summarised.
 */
function parsedMessages(agent, count = 6) {
  const rendered = [];
  for (const m of allMessages(agent)) {
    const text = String(m.text || '').trim();
    const tools = Array.isArray(m.tools) ? m.tools : [];
    if (!text && !tools.length) continue;
    const toolLine = tools.length
      ? `[used ${tools.map(t => (typeof t === 'string' ? t : t.name || t.tool || 'tool')).slice(0, 6).join(', ')}]`
      : '';
    rendered.push({ role: m.role, text: [text, toolLine].filter(Boolean).join(' ').trim(), timestamp: m.timestamp });
  }
  return rendered.slice(-count);
}

/** When the agent last produced anything, from its own transcript. */
function lastActivityAt(agent) {
  const messages = allMessages(agent);
  for (let i = messages.length - 1; i >= 0; i--) {
    const ts = Date.parse(messages[i].timestamp || '');
    if (Number.isFinite(ts)) return ts;
  }
  return 0;
}

function lastAssistantText(agent) {
  const messages = allMessages(agent).slice(-12);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && (messages[i].text || '').trim()) return messages[i].text;
  }
  return '';
}

// ─── Sending input ───────────────────────────────────────────────────────────

function sendToAgent(agent, message, { noEnter = false } = {}) {
  if (!agent.mux) throw new Error('agent is not in a multiplexer');
  const target = agent.mux.type === 'tmux' ? agent.mux.target : agent.mux.session;
  // Briefings are long. They go through a tmux buffer, never send-keys, or the
  // agent receives a truncated instruction and answers the wrong question.
  sendMuxInput(target, agent.mux.type, { message, noEnter });
}

// Prompt answers are single keys, which is what send-keys is actually for.
function answerPrompt(agent, verdict) {
  const target = agent.mux.type === 'tmux' ? agent.mux.target : agent.mux.session;

  if (verdict.optionKey) {
    sendMuxKey(target, agent.mux.type, String(verdict.optionKey));
    execSync('sleep 0.2');
    sendMuxKey(target, agent.mux.type, 'Enter');
    return;
  }

  const delta = (verdict.optionIndex || 0) - (verdict.selectedIdx || 0);
  const key = delta > 0 ? 'Down' : 'Up';
  for (let i = 0; i < Math.abs(delta); i++) {
    sendMuxKey(target, agent.mux.type, key);
  }
  sendMuxKey(target, agent.mux.type, 'Enter');
}

/**
 * Answer an on-screen prompt by the label the operator picked.
 *
 * A gate carries labels, not keystrokes, so the prompt is re-read and the
 * matching option selected — this is how "Yes, I trust this folder" gets
 * chosen rather than whatever happened to be highlighted.
 */
function answerPromptByLabel(agent, label) {
  const { prompt } = inferStatus(agent);
  if (!prompt) return false;
  const wanted = String(label || '').trim().toLowerCase();
  const idx = (prompt.options || []).findIndex(o => String(o.label || '').trim().toLowerCase() === wanted);
  if (idx === -1) return false;
  const option = prompt.options[idx];
  answerPrompt(agent, {
    optionKey: prompt.isNumbered ? (option.key || String(idx + 1)) : null,
    optionIndex: idx,
    selectedIdx: prompt.selectedIdx || 0,
  });
  return true;
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
    work?.check
      ? `CHECK: ${policy.describeCheck(work.check)} — last result: ${checkDetail || 'not evaluated'}`
      : 'CHECK: none — nothing here can be verified automatically, so judge from the transcript whether the work described above is actually finished.',
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
    'Prefer "continue" while there is real work left. When this stage has no check and the',
    'transcript shows its goal has been met, choose "advance" — do not keep it going for its',
    'own sake. Only choose "gate" for a decision that is irreversible, outward-facing, or a',
    'product/scope judgement the code cannot answer.',
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

// The decider runs from a scratch directory, never the initiative's. Claude
// writes a transcript per working directory, so running it in the repo dropped
// the supervisor's own prompts into the very folder it later searches to find
// the agent's session — polluting the match and making it blind.
function deciderCwd() {
  const dir = path.join(os.tmpdir(), 'openorcha-supervisor');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return os.tmpdir();
  }
}

/**
 * Ask for a decision. Resolves to { decision } or { failure } — never a bare
 * null, because "the supervisor could not work out the next step" with no
 * reason attached is a gate nobody can act on.
 */
function askLlm(initiative, work, messages, checkDetail) {
  return new Promise(resolve => {
    // spawn, not execFile: execFile leaves stdin open and the CLI waits three
    // seconds for input it will never get, on every single call.
    const child = spawn('claude', [
      '-p', buildDecisionPrompt(initiative, work, messages, checkDetail),
      '--output-format', 'json',
      '--model', 'sonnet',
      '--disallowed-tools', 'Read', 'Grep', 'Glob', 'Bash', 'Task', 'WebFetch', 'WebSearch',
    ], { cwd: deciderCwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ failure: `no answer within ${Math.round(LLM_TIMEOUT_MS / 1000)}s` });
    }, LLM_TIMEOUT_MS);

    child.stdout.on('data', d => { if (stdout.length < 4e6) stdout += d; });
    child.stderr.on('data', d => { if (stderr.length < 20000) stderr += d; });
    child.on('error', e => finish({ failure: `could not run claude: ${e.message}` }));

    child.on('close', code => {
      if (!stdout.trim()) {
        return finish({ failure: `claude exited ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}` : ' with no output'}` });
      }

      let text = stdout;
      const envelope = extractJson(stdout);
      if (envelope && typeof envelope.result === 'string') text = envelope.result;
      const decision = extractJson(text);

      if (!decision) {
        return finish({ failure: `reply was not JSON: ${String(text).trim().slice(0, 200)}` });
      }
      if (!['continue', 'advance', 'gate'].includes(decision.action)) {
        // A usable message with a mangled action is still usable.
        if (decision.message) return finish({ decision: { ...decision, action: 'continue' } });
        return finish({ failure: `unknown action ${JSON.stringify(decision.action)}` });
      }
      finish({ decision });
    });
  });
}

// ─── Briefings ───────────────────────────────────────────────────────────────

function briefing(initiative, work, worker) {
  const waiting = store.takePendingMessages(initiative);
  return [
    `[OpenOrcha · ${initiative.name}] ${work.name}.`,
    work.instruction,
    work.check ? `This is done when ${policy.describeCheck(work.check)}.` : '',
    initiative.goal ? `Overall goal: ${initiative.goal}` : '',
    acceptanceBrief(initiative),
    worker?.worktree ? `You are on branch ${worker.worktree.branch} in your own worktree — other agents are working in parallel on sibling branches, so stay inside this directory.` : '',
    initiative.integration?.branches?.length && !worker?.taskId
      ? `Parallel work landed on these branches: ${initiative.integration.branches.join(', ')}. Merge them into this branch before continuing.`
      : '',
    'Work through it without asking for confirmation on reversible steps. If you must make a judgement call, take the safe option and note the assumption in one line.',
    waiting.length
      ? `While you were not running, the operator said: ${waiting.map(m => `"${m.message}"`).join(' ')} — take that into account.`
      : '',
  ].filter(Boolean).join(' ');
}

function acceptanceBrief(initiative) {
  const open = (initiative.acceptance || []).filter(c => c.status !== 'met' && c.status !== 'waived');
  if (!open.length) return '';
  return `This is done when: ${open.map(c => `(${c.id}) ${c.text}${c.check?.type && c.check.type !== 'human' ? ` [checked by ${policy.describeCheck(c.check)}]` : ''}`).join('; ')}.`;
}

function openGateAndNotify(initiative, gate) {
  const entry = store.openGate(initiative, gate);
  if (initiative.notifyOnGate) notify(`${initiative.name} needs you`, entry.question);
  informOrchestrator(initiative, 'gate-opened', entry.question);
  note(`gate opened: ${entry.question}`, initiative.id);
  return entry;
}

// ─── Definition of done ──────────────────────────────────────────────────────

/**
 * Run every checkable acceptance criterion and record where it stands.
 *
 * This is what a definition of done buys: with criteria the supervisor can
 * settle itself, finishing is a measurement rather than a question for you.
 */
function evaluateAcceptance(initiative) {
  const met = [];
  const unmet = [];
  const human = [];

  for (const criterion of initiative.acceptance || []) {
    if (criterion.status === 'waived') { met.push(criterion); continue; }
    if (criterion.check?.type === 'human') {
      (criterion.status === 'met' ? met : human).push(criterion);
      continue;
    }
    const result = runCheck(criterion.check, initiative.cwd);
    if (result.passed === true) {
      store.setCriterionStatus(initiative, criterion.id, 'met', result.detail);
      met.push(criterion);
    } else {
      if (criterion.status === 'met') store.setCriterionStatus(initiative, criterion.id, 'unmet', result.detail);
      else criterion.detail = result.detail;
      unmet.push({ ...criterion, detail: result.detail });
    }
  }

  return { met, unmet, human };
}

/** Record where the repo stood when the run began, once. */
function recordBaseline(initiative) {
  if (initiative.baseline) return false;
  const branch = currentBranch(initiative.cwd);
  if (!branch) return false;
  let sha = '';
  try {
    sha = execSync('LC_ALL=C git rev-parse HEAD', { cwd: initiative.cwd, encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return false;
  }
  initiative.baseline = { branch, sha, at: new Date().toISOString() };
  store.addEvent(initiative, 'baseline', `Starting from ${branch} at ${sha.slice(0, 8)}`);
  return true;
}

// ─── The orchestrator ────────────────────────────────────────────────────────

/**
 * Start this initiative's orchestrator if it wants one and has none running.
 * It counts against the machine-wide agent budget like any other session.
 */
const ORCH_RETRY_AFTER_MS = 300000;
const orchestratorFailures = new Map();

async function ensureOrchestrator(initiative, snapshot) {
  if (!initiative.useOrchestrator) return false;
  // A draft has not been started, and a cancelled or failed run is over.
  if (['draft', 'cancelled', 'failed'].includes(initiative.status)) return false;

  const lastFailure = orchestratorFailures.get(initiative.id) || 0;
  if (Date.now() - lastFailure < ORCH_RETRY_AFTER_MS) return false;

  const existing = store.orchestrator(initiative);
  if (existing) {
    if (agentForSession(existing.sessionName, snapshot)) return false;
    if (Date.now() - new Date(existing.startedAt).getTime() < WORKER_BOOT_GRACE_MS) return false;
    store.retireWorker(initiative, existing.id, 'gone', 'orchestrator session ended');
    store.save(initiative);
    return false;
  }

  if (MAX_TOTAL_AGENTS - liveAgentCount(snapshot) <= 0) {
    if (!store.openGates(initiative).some(g => g.kind === 'budget')) {
      store.addEvent(initiative, 'warning', `Orchestrator is waiting: all ${MAX_TOTAL_AGENTS} agent slots are in use`);
      store.save(initiative);
    }
    return false;
  }
  if (process.env.OPENORCHA_NO_LAUNCH === '1') {
    store.addEvent(initiative, 'warning', 'Orchestrator launch suppressed (OPENORCHA_NO_LAUNCH)');
    store.save(initiative);
    return false;
  }

  let sessionName;
  try {
    ({ sessionName } = await launchAgentAsync({
      agentId: initiative.agentId,
      cwd: initiative.cwd,
      sessionName: `orch-${worktrees.slug(initiative.name)}`.slice(0, 40),
      skipPermissions: false,
      presetFlags: '',
    }));
  } catch (e) {
    orchestratorFailures.set(initiative.id, Date.now());
    store.addEvent(initiative, 'error', `Could not launch the orchestrator: ${e.message} — retrying in 5 minutes`);
    store.save(initiative);
    return false;
  }

  const fresh = store.get(initiative.id) || initiative;
  const worker = store.addWorker(fresh, {
    name: 'Orchestrator',
    role: 'orchestrator',
    sessionName,
    agentId: fresh.agentId,
    cwd: fresh.cwd,
  });
  orchestratorFailures.delete(initiative.id);
  note(`orchestrator started for ${fresh.name}`, fresh.id);
  store.save(fresh);

  // Brief it once the CLI is up.
  setTimeout(() => {
    const current = store.get(fresh.id);
    if (!current) return;
    const agent = agentForSession(sessionName, takeSnapshot());
    if (!agent) return;
    if (inferStatus(agent).prompt) return; // a prompt is up; tickOne will gate it
    try {
      sendToAgent(agent, orch.openingBrief(current, current.stages));
      const w = (current.workers || []).find(x => x.id === worker.id);
      if (w) { w.briefed = true; w.status = 'working'; }
      store.addEvent(current, 'orchestrator-briefed', 'Orchestrator briefed on the run');
      store.save(current);
      // Its transcript exists once it has been spoken to; find it now, so its
      // answers can be read and its conversation shown.
      setTimeout(() => {
        const fresh = store.get(current.id);
        const boss = fresh && store.orchestrator(fresh);
        if (boss) workerMessages(fresh, boss);
      }, 12000);
    } catch {}
  }, 9000);

  return true;
}

/** Tell the orchestrator what just happened. Fire and forget. */
function informOrchestrator(initiative, kind, detail) {
  const worker = store.orchestrator(initiative);
  if (!worker || !worker.briefed) return;
  const agent = agentForSession(worker.sessionName, takeSnapshot());
  if (!agent) return;
  try {
    sendToAgent(agent, orch.updateNote(kind, detail));
  } catch {}
}

/**
 * Ask the orchestrator to decide. Resolves { decision } or { failure }.
 *
 * The reply is read from its transcript rather than the pane: the pane is a
 * rendering, the transcript is what it said.
 */
function askOrchestrator(initiative, work, messages, checkDetail, workerName) {
  return new Promise(resolve => {
    const worker = store.orchestrator(initiative);
    if (!worker || !worker.briefed) return resolve({ failure: 'no orchestrator running' });
    const agent = agentForSession(worker.sessionName, takeSnapshot());
    if (!agent) return resolve({ failure: 'orchestrator session is gone' });
    agent.cwd = agent.cwd || worker.cwd || initiative.cwd;

    const before = workerMessages(initiative, worker, takeSnapshot()).length;
    const transcript = messages
      .map(m => `${m.role === 'assistant' ? 'WORKER' : 'OPERATOR'}: ${String(m.text || '').slice(0, 700)}`)
      .join('\n');

    try {
      sendToAgent(agent, orch.decisionRequest({
        work, workerName, checkDetail, transcript, hasCheck: !!work?.check,
      }));
    } catch (e) {
      return resolve({ failure: `could not reach the orchestrator: ${e.message}` });
    }

    const deadline = Date.now() + orch.ORCHESTRATOR_REPLY_TIMEOUT_MS;
    const poll = setInterval(() => {
      const fresh = agentForSession(worker.sessionName, takeSnapshot());
      if (!fresh) {
        clearInterval(poll);
        return resolve({ failure: 'orchestrator went away mid-question' });
      }
      fresh.cwd = agent.cwd;
      const current = store.get(initiative.id) || initiative;
      const bossNow = store.orchestrator(current) || worker;
      const msgs = workerMessages(current, bossNow, takeSnapshot());
      if (msgs.length > before) {
        const replies = msgs.slice(before).filter(m => m.role === 'assistant' && (m.text || '').trim());
        for (const reply of replies) {
          const decision = orch.extractDecision(reply.text);
          if (decision) {
            clearInterval(poll);
            return resolve({ decision, via: 'orchestrator' });
          }
        }
      }
      if (Date.now() > deadline) {
        clearInterval(poll);
        resolve({ failure: 'orchestrator did not answer in time' });
      }
    }, 4000);
  });
}

// ─── Worker provisioning ─────────────────────────────────────────────────────

/**
 * Make sure the current stage has the workers it needs, without exceeding the
 * initiative's fan-out or the machine-wide agent budget.
 */
async function ensureWorkers(initiative, stage, snapshot) {
  // A completed stage does not need another agent. Without this, a run that
  // got flipped back to running while sitting on its finished last stage grew
  // a new worker on every tick.
  if (['done', 'skipped'].includes(stage?.status)) return false;
  if (initiative.status === 'done') return false;

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
  // A hard stop against launching real agents where that would be wrong —
  // tests, CI, or a dry run. Without it, anything that calls tick() on a
  // running initiative spawns a live CLI session.
  if (process.env.OPENORCHA_NO_LAUNCH === '1') {
    store.addEvent(initiative, 'warning', `Launch suppressed (OPENORCHA_NO_LAUNCH): ${name}`);
    store.save(initiative);
    return null;
  }

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

/**
 * Stop an initiative's workers.
 *
 * Pausing leaves the agents alive so you can take one over by hand; stopping
 * kills the tmux sessions this initiative started, because an unsupervised
 * agent left running is an agent still spending tokens on work nobody wants.
 * Only sessions this initiative launched are touched.
 */
function stopWorkers(initiative, { kill = true } = {}) {
  const stopped = [];
  // Every worker this initiative ever started, not just the ones currently
  // marked active: a worker the supervisor retired can still have a live
  // session behind it, and those are exactly the ones left orphaned.
  for (const worker of initiative.workers || []) {
    // Includes the orchestrator: nothing about this run should outlive it.
    if (kill && worker.sessionName && tmuxSessionExists(worker.sessionName)) {
      try {
        execSync(`tmux kill-session -t ${shellEscape(worker.sessionName)} 2>/dev/null`, { timeout: 5000 });
        stopped.push(worker.sessionName);
      } catch {
        // Already gone, or never made it into tmux — nothing to do.
      }
    }
    if (['starting', 'working'].includes(worker.status)) {
      store.retireWorker(initiative, worker.id, 'gone', kill ? 'stopped by you' : 'left running');
    }
    runtime.delete(workerKey(initiative.id, worker.id));
  }
  return stopped;
}

// ─── One worker, one tick ────────────────────────────────────────────────────

async function tickWorker(initiative, worker, stage, snapshot) {
  const key = workerKey(initiative.id, worker.id);
  const state = rt(key);
  const task = worker.taskId ? store.stageTasks(stage).find(t => t.id === worker.taskId) : null;
  const work = task || stage;
  const agent = agentForSession(worker.sessionName, snapshot);

  if (!agent) return handleMissingWorker(initiative, worker, stage, task, state);

  // A freshly launched worker gets its briefing once the CLI is up — but never
  // while a prompt is waiting. Pasting a briefing into Claude Code's trust
  // prompt answers it with whatever is highlighted, which is "No, exit": the
  // agent is killed by its own instructions.
  if (!worker.briefed) {
    if (Date.now() - new Date(worker.startedAt).getTime() < 6000) return null;

    const opening = inferStatus(agent);
    if (opening.prompt) {
      const verdict = policy.classifyPrompt(opening.prompt, initiative.profile);
      if (verdict.action === 'approve') {
        try { answerPrompt(agent, verdict); } catch {}
        return null;
      }
      const already = store.openGates(initiative).some(g => g.kind === (verdict.kind || 'permission'));
      if (!already) {
        openGateAndNotify(initiative, {
          kind: verdict.kind || 'permission',
          question: verdict.kind === 'trust'
            ? `Claude Code has not been trusted in ${worker.cwd || initiative.cwd}. Trust it so this run can work there?`
            : opening.prompt.question,
          options: (opening.prompt.options || []).map(o => o.label),
          defaultOption: null,
          reason: verdict.reason,
          context: opening.prompt.context,
          workerId: worker.id,
        });
        return store.save(initiative);
      }
      return null;
    }

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
  agent.sessionFile = worker.sessionFile || null;
  const { status, prompt } = inferStatus(agent);

  if (status === 'thinking') {
    state.idleTicks = 0;
    return null;
  }

  const isPrompt = status === 'waiting_input' && prompt;
  if (!isPrompt) {
    // The pane can look quiet between tool calls. The transcript is the
    // honest signal: if the agent produced a turn moments ago it is working,
    // and interrupting it with a nudge only tells it to do what it is doing.
    const since = Date.now() - lastActivityAt(agent);
    if (since < WORKING_QUIET_MS) {
      state.idleTicks = 0;
      return null;
    }
    state.idleTicks += 1;
    if (state.idleTicks < IDLE_TICKS_REQUIRED) return null;
    if (Date.now() - state.lastActionAt < MIN_ACTION_MS) return null;
  } else {
    const signature = `${prompt.question}|${(prompt.options || []).map(o => o.label).join('|')}`;
    if (state.lastPromptSignature === signature && Date.now() - state.lastActionAt < MIN_ACTION_MS) return null;
    state.lastPromptSignature = signature;
  }

  const stopText = isPrompt ? '' : lastAssistantText(agent);
  if (rememberSessionFile(initiative, worker, agent)) store.save(initiative);
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
        informOrchestrator(initiative, 'task-done', `${task.name} (branch ${task.branch || 'none'})`);
        note(`task done: ${task.name}`, initiative.id);
        return store.save(initiative);
      }

      const isFinal = initiative.stageIndex >= initiative.stages.length - 1;

      // The last stage does not end the run — the definition of done does.
      if (isFinal && (initiative.acceptance || []).length) {
        const { unmet, human } = evaluateAcceptance(initiative);

        if (unmet.length) {
          sendToAgent(agent, `The stages are done but the definition of done is not met yet: ${unmet.map(c => `${c.text} (${c.detail || 'not met'})`).join('; ')}. Close those gaps, then report.`);
          work.nudges = (work.nudges || 0) + 1;
          initiative.stats.nudges += 1;
          store.addEvent(initiative, 'dod-gap', `${unmet.length} criteria still unmet: ${unmet.map(c => c.text).join('; ').slice(0, 300)}`, { workerId: worker.id });
          note(`held at the finish line: ${unmet.length} criteria unmet`, initiative.id);
          return store.save(initiative);
        }

        if (human.length) {
          openGateAndNotify(initiative, {
            kind: 'sign-off',
            question: `Everything checkable passes. These need your eyes: ${human.map(c => c.text).join('; ')}`,
            options: ['Accept — it is done', 'Not yet'],
            reason: 'criteria that only a person can settle',
            context: (initiative.acceptance || []).map(c => `${c.status === 'met' ? '✓' : '·'} ${c.text}`).join('\n'),
            workerId: worker.id,
          });
          return store.save(initiative);
        }
      }

      const next = store.advanceStage(initiative, decision.reason);
      if (next) {
        store.retireWorker(initiative, worker.id, 'done', `finished ${stage.name}`);
        informOrchestrator(initiative, 'stage-done', `${stage.name} finished; now on ${next.name}`);
        note(`advanced to ${next.name}`, initiative.id);
      } else {
        initiative.status = 'done';
        store.retireWorker(initiative, worker.id, 'done', 'initiative complete');
        informOrchestrator(initiative, 'completed', `${initiative.name} is complete`);
        notify(`${initiative.name} finished`, (initiative.acceptance || []).length
          ? 'Every acceptance criterion is met.'
          : 'All stages complete.');
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

      // The orchestrator owns this run, so it decides. A one-shot call is the
      // fallback when there is no orchestrator, or it cannot answer.
      const ask = store.orchestrator(initiative)
        ? askOrchestrator(initiative, work, messages, ctx.checkDetail, worker.name)
            .then(result => (result.decision ? result : askLlm(initiative, work, messages, ctx.checkDetail)))
        : askLlm(initiative, work, messages, ctx.checkDetail);

      ask
        .then(({ decision, failure, via }) => applyLlmResult(initiative.id, worker.id, decision, ctx.checkDetail, failure, via))
        .catch(() => {})
        .finally(() => { state.llmInFlight = false; });
      return null;
    }

    default:
      return null;
  }
}

function applyLlmResult(initiativeId, workerId, result, checkDetail, failure, via) {
  const initiative = store.get(initiativeId);
  if (!initiative || initiative.status !== 'running') return;

  const worker = (initiative.workers || []).find(w => w.id === workerId);
  if (!worker || worker.status === 'done' || worker.status === 'gone') return;

  const stage = store.currentStage(initiative);
  const task = worker.taskId ? store.stageTasks(stage).find(t => t.id === worker.taskId) : null;
  const work = task || stage;
  const state = rt(workerKey(initiativeId, workerId));
  initiative.stats.llmDecisions += 1;

  // Resolve the live agent once: the gate wants the agent's own last words in
  // it, and the continue path needs the agent to send to.
  const snapshot = takeSnapshot();
  const liveAgent = agentForSession(worker.sessionName, snapshot);
  if (liveAgent) liveAgent.cwd = liveAgent.cwd || worker.cwd || initiative.cwd;

  if (!result || result.action === 'gate') {
    const lastSaid = liveAgent ? String(lastAssistantText(liveAgent) || '').slice(-400) : '';
    openGateAndNotify(initiative, {
      kind: 'decision',
      question: result?.question
        || `"${worker.name}" is idle and the supervisor could not decide for itself — ${failure || 'no reason recorded'}.`,
      options: Array.isArray(result?.options) ? result.options : ['Mark done and continue', 'Keep going', 'Skip this stage', 'Stop the run'],
      defaultOption: result?.defaultOption || null,
      reason: result?.reason || failure || 'judgement call failed',
      context: [checkDetail, lastSaid && `Agent last said: ${lastSaid}`].filter(Boolean).join('\n\n'),
      workerId,
    });
    if (failure) store.addEvent(initiative, 'llm-failed', failure, { workerId });
    store.save(initiative);
    return;
  }

  const agent = liveAgent;
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
  store.addEvent(initiative, 'llm-continue', `${worker.name}: ${result.reason || 'judged safe to continue'}${via === 'orchestrator' ? ' (orchestrator)' : ''}`, { workerId });
  note(`llm decided continue for ${worker.name}`, initiative.id);
  store.save(initiative);
}

// ─── One initiative, one tick ────────────────────────────────────────────────

async function tickOne(initiative, snapshot = takeSnapshot()) {
  const auto = autoDecideStaleGates(initiative);
  if (auto) return auto;

  // Before the status check: an orchestrator is an addressee and a keeper of
  // context, and you may well want one precisely when the run is blocked or
  // finished. Refusing to start it because the run is not advancing means a
  // click with no effect and no explanation.
  if (await ensureOrchestrator(initiative, snapshot)) return store.get(initiative.id);

  if (initiative.status !== 'running') return null;
  if (inQuietHours(initiative)) return null;

  const stage = store.currentStage(initiative);
  if (!stage) return null;

  if (recordBaseline(initiative)) store.save(initiative);

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
 * Deliver a message to a run without changing its state.
 *
 * This used to go through applyGateAnswer, which ends by setting the run
 * running again — so messaging a finished initiative resurrected it, and the
 * next tick launched a fresh worker for its already-completed last stage. Five
 * agents accumulated on one run that way.
 */
function deliverNote(initiative, text, { workerId = null } = {}) {
  const snapshot = takeSnapshot();
  const agent = findAgent(initiative, snapshot, { workerId });
  if (!agent) return { delivered: false };

  sendToAgent(agent, `[OpenOrcha] ${String(text || '').trim()}`);
  const key = workerKey(initiative.id, agent.workerId || 'main');
  rt(key).lastActionAt = Date.now();
  rt(key).idleTicks = 0;
  return { delivered: true, workerId: agent.workerId, workerName: agent.workerName };
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

  if (gate.kind === 'sign-off') {
    if (/^accept/.test(lower)) {
      for (const criterion of initiative.acceptance || []) {
        if (criterion.status !== 'met') store.setCriterionStatus(initiative, criterion.id, 'met', 'accepted by you');
      }
      initiative.status = 'done';
      store.addEvent(initiative, 'completed', 'Signed off by you');
      return;
    }
    initiative.status = 'running';
    return;
  }

  if (/^mark done/.test(lower)) {
    const next = store.advanceStage(initiative, 'marked done by you');
    initiative.status = next ? 'running' : 'done';
    return;
  }

  if (/^skip/.test(lower)) {
    store.skipStage(initiative, 'skipped at a gate');
    initiative.status = 'running';
    return;
  }

  // Only a run that was interrupted resumes; a finished or stopped one stays
  // as it is, whatever gets answered.
  if (['blocked', 'paused', 'running'].includes(initiative.status)) initiative.status = 'running';
  const snapshot = takeSnapshot();
  const worker = gate.workerId
    ? (initiative.workers || []).find(w => w.id === gate.workerId)
    : store.activeWorkers(initiative)[0];
  const agent = worker ? agentForSession(worker.sessionName, snapshot) : findAgent(initiative, snapshot);
  if (!agent) return;

  try {
    if (gate.kind === 'trust' || gate.kind === 'permission') {
      // Select the option the operator chose; fall back to typing it.
      if (!answerPromptByLabel(agent, text)) sendToAgent(agent, text);
      store.addEvent(initiative, 'prompt-answered', `${gate.kind}: ${text}`, { workerId: worker?.id });
    } else {
      sendToAgent(agent, `[OpenOrcha] ${text}`);
    }
    const key = workerKey(initiative.id, worker?.id || 'main');
    rt(key).lastActionAt = Date.now();
    rt(key).idleTicks = 0;
    rt(key).lastPromptSignature = null;
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
    const runnable = store.list().filter(i => {
      if (!['done', 'failed', 'draft', 'cancelled'].includes(i.status)) return true;
      // A finished run still gets ticked while it is waiting for an
      // orchestrator it was asked for — and only until it has one.
      return i.useOrchestrator && i.status === 'done' && !store.orchestrator(i);
    });

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
  liveWorkers,
  agentForSession,
  takeSnapshot,
  liveAgentCount,
  inferStatus,
  applyGateAnswer,
  deliverNote,
  buildDigest,
  stopWorkers,
  evaluateAcceptance,
  startWorker,
  ensureWorkers,
  recordBaseline,
  ensureOrchestrator,
  informOrchestrator,
  askOrchestrator,
  answerPromptByLabel,
  allMessages,
  workerMessages,
  notify,
  MAX_TOTAL_AGENTS,
  TICK_MS,
};
