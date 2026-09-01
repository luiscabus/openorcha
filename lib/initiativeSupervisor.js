// The initiative supervisor.
//
// This is the part that replaces you as the operator. It watches every running
// initiative, and on each tick it decides — from rules first, from a short LLM
// call only when the rules don't cover the situation — whether to approve a
// prompt, nudge the agent, advance a stage, or stop and ask you.
//
// The design comes from what actually stalls real sessions: agents sitting
// idle after offering a next step they could have taken, "done" claims nobody
// verified, and failures that wait hours for a human who has gone to bed.

const path = require('path');
const { execSync, execFile } = require('child_process');

const store = require('./initiativeStore');
const policy = require('./initiativePolicy');
const { runCheck, repoSnapshot } = require('./initiativeChecks');
const { launchAgent } = require('./agentLauncher');
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
// An agent must look idle on two consecutive ticks before we treat it as idle,
// so we never interrupt a pause between tool calls.
const IDLE_TICKS_REQUIRED = 2;
// Stage checks can be expensive (a test command), so re-run them sparingly.
const CHECK_MIN_MS = 45000;
const LLM_TIMEOUT_MS = 90000;
const LLM_MAX_PER_HOUR = 20;

let timer = null;
let ticking = false;
const runtime = new Map();
const log = [];

function rt(id) {
  if (!runtime.has(id)) {
    runtime.set(id, {
      idleTicks: 0,
      lastActionAt: 0,
      lastCheckAt: 0,
      lastCheck: null,
      llmInFlight: false,
      llmCalls: [],
      lastPromptSignature: null,
    });
  }
  return runtime.get(id);
}

function note(message, initiativeId = null) {
  const entry = { ts: new Date().toISOString(), initiativeId, message };
  log.push(entry);
  if (log.length > 300) log.shift();
  return entry;
}

// ─── Finding the agent behind an initiative ──────────────────────────────────

/**
 * Locate the live agent process for an initiative by its tmux session name.
 * Returns { pid, agentId, cwd, mux, cpu } or null.
 */
function findAgent(initiative) {
  const sessionName = initiative.run?.sessionName;
  if (!sessionName) return null;

  let psOut = '';
  try {
    psOut = execSync('ps -eo pid,pcpu,tty,args 2>/dev/null', { encoding: 'utf8' });
  } catch {
    return null;
  }

  const procs = buildProcTable();
  const tmuxMap = buildTmuxPaneMap();
  const screenMap = buildScreenMap();
  const candidates = [];

  for (const line of psOut.trim().split('\n').slice(1)) {
    const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)/);
    if (!m) continue;
    const [, pid, cpu, tty, args] = m;
    const bin = path.basename(args.split(/\s+/)[0]);
    const def = AGENT_DEFS.find(d => d.match(bin, args));
    if (!def) continue;
    const mux = detectMultiplexer(pid, tty === '??' ? null : tty, procs, tmuxMap, screenMap);
    if (tmuxSessionNameFromMux(mux) !== sessionName) continue;
    candidates.push({ pid, agentId: def.id, cpu: parseFloat(cpu), mux, args, tty });
  }

  if (!candidates.length) return null;
  // Several processes can share a pane; keep the root of the tree.
  const pids = new Set(candidates.map(c => c.pid));
  const root = candidates.find(c => !pids.has(procs[c.pid]?.ppid)) || candidates[0];
  root.cpu = candidates.reduce((sum, c) => sum + c.cpu, 0);
  root.cwd = getCwdMap([root.pid])[root.pid] || initiative.cwd;
  return root;
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

/** Last assistant message from the agent's own session transcript. */
function lastAssistantText(agent) {
  try {
    const resolver = getSessionResolver(agent.agentId);
    if (!resolver?.resolveLiveSession) return '';
    const paneText = ['claude', 'codex'].includes(agent.agentId) ? captureAgentPaneText(agent.pid) : '';
    const resolved = resolver.resolveLiveSession({ cwd: agent.cwd, pid: agent.pid, args: agent.args || '', paneText });
    if (!resolved) return '';
    const parsed = resolver.parseResolved(resolved);
    const messages = parsed?.messages || [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && (messages[i].text || '').trim()) return messages[i].text;
    }
  } catch {}
  return '';
}

function recentMessages(agent, count = 6) {
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

// ─── Sending input ───────────────────────────────────────────────────────────

function sendToAgent(agent, message, { noEnter = false } = {}) {
  if (!agent.mux) throw new Error('agent is not in a multiplexer');
  const target = agent.mux.type === 'tmux' ? agent.mux.target : agent.mux.session;
  if (agent.mux.type === 'tmux') {
    if (noEnter) {
      execSync(`tmux send-keys -t ${shellEscape(target)} ${shellEscape(message)}`, { timeout: 5000 });
    } else {
      execSync(`tmux send-keys -t ${shellEscape(target)} ${shellEscape(message)}`, { timeout: 5000 });
      execSync('sleep 0.15');
      execSync(`tmux send-keys -t ${shellEscape(target)} Enter`, { timeout: 5000 });
    }
    return;
  }
  const stuffed = noEnter ? message : `${message}\n`;
  execSync(`screen -S ${shellEscape(target)} -X stuff ${shellEscape(stuffed)}`, { timeout: 5000 });
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
  // Arrow-key style prompt: move the selection to the chosen option, then Enter.
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

function buildDecisionPrompt(initiative, stage, messages, checkDetail) {
  const transcript = messages
    .map(m => `${m.role === 'assistant' ? 'AGENT' : 'USER'}: ${String(m.text || '').slice(0, 900)}`)
    .join('\n\n');

  return [
    'You are supervising a coding agent so its human operator does not have to sit and watch it.',
    '',
    `INITIATIVE: ${initiative.name}`,
    `GOAL: ${initiative.goal || '(not stated)'}`,
    `CURRENT STAGE: ${stage?.name} — ${stage?.instruction || ''}`,
    `STAGE CHECK: ${policy.describeCheck(stage?.check)} — last result: ${checkDetail || 'not evaluated'}`,
    `AUTONOMY: ${initiative.profile} (local work, commits, pushes and draft PRs are pre-approved; posting review comments, non-draft PRs, Jira writes and merges are not)`,
    '',
    'RECENT TRANSCRIPT:',
    transcript || '(no messages)',
    '',
    'The agent is idle. Choose ONE action:',
    '  "continue" — it can keep working; supply the message to send it.',
    '  "advance"  — the stage is genuinely finished even though the check could not confirm it.',
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

function askLlm(initiative, stage, messages, checkDetail) {
  return new Promise(resolve => {
    const prompt = buildDecisionPrompt(initiative, stage, messages, checkDetail);
    execFile(
      'claude',
      ['-p', prompt, '--output-format', 'json', '--model', 'sonnet'],
      { cwd: initiative.cwd, timeout: LLM_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: process.env },
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

// ─── Acting on a decision ────────────────────────────────────────────────────

function stageBriefing(initiative, stage) {
  return [
    `[OpenOrcha · ${initiative.name}] Stage: ${stage.name}.`,
    stage.instruction,
    stage.check ? `This stage is done when ${policy.describeCheck(stage.check)}.` : '',
    initiative.goal ? `Overall goal: ${initiative.goal}` : '',
    'Work through it without asking for confirmation on reversible steps. If you must make a judgement call, take the safe option and note the assumption in one line.',
  ].filter(Boolean).join(' ');
}

function openGateAndNotify(initiative, gate) {
  const entry = store.openGate(initiative, gate);
  if (initiative.notifyOnGate) {
    notify(`${initiative.name} needs you`, entry.question);
  }
  note(`gate opened: ${entry.question}`, initiative.id);
  return entry;
}

// ─── One initiative, one tick ────────────────────────────────────────────────

async function tickOne(initiative) {
  const state = rt(initiative.id);

  // Auto-decide parked questions that have a safe default and have gone stale.
  const auto = autoDecideStaleGates(initiative);
  if (auto) return auto;

  if (initiative.status !== 'running') return null;
  if (inQuietHours(initiative)) return null;

  let agent = findAgent(initiative);

  // No agent yet — start one and brief it on the current stage.
  if (!agent) {
    if (!initiative.run) return startRun(initiative);
    return handleMissingAgent(initiative);
  }

  const { status, prompt, text } = inferStatus(agent);

  if (status === 'thinking') {
    state.idleTicks = 0;
    return null;
  }

  // A permission prompt is worth answering immediately — no idle debounce.
  const isPrompt = status === 'waiting_input' && prompt;
  if (!isPrompt) {
    state.idleTicks += 1;
    if (state.idleTicks < IDLE_TICKS_REQUIRED) return null;
    if (Date.now() - state.lastActionAt < MIN_ACTION_MS) return null;
  } else {
    // Never answer the same prompt twice in a row — that means our answer did
    // not take, and hammering Enter at a stuck prompt helps nobody.
    const signature = `${prompt.question}|${(prompt.options || []).map(o => o.label).join('|')}`;
    if (state.lastPromptSignature === signature && Date.now() - state.lastActionAt < MIN_ACTION_MS) return null;
    state.lastPromptSignature = signature;
  }

  const stage = store.currentStage(initiative);
  const stopText = isPrompt ? '' : lastAssistantText(agent);

  // Ground-truth check, throttled.
  let checkPassed = state.lastCheck?.passed ?? null;
  let checkDetail = state.lastCheck?.detail || '';
  if (!isPrompt && stage?.check && Date.now() - state.lastCheckAt > CHECK_MIN_MS) {
    const result = runCheck(stage.check, initiative.cwd);
    state.lastCheck = result;
    state.lastCheckAt = Date.now();
    checkPassed = result.passed;
    checkDetail = result.detail;
    if (result.passed === false) stage.consecutiveFailures = (stage.consecutiveFailures || 0) + 1;
    else if (result.passed === true) stage.consecutiveFailures = 0;
  }

  const decision = policy.decide({
    status,
    prompt,
    stopText,
    stage,
    checkPassed,
    nudges: stage?.nudges || 0,
    consecutiveFailures: stage?.consecutiveFailures || 0,
    profile: initiative.profile,
    isLastStage: initiative.stageIndex >= initiative.stages.length - 1,
  });

  return applyDecision(initiative, agent, stage, decision, { checkDetail, text });
}

async function applyDecision(initiative, agent, stage, decision, ctx) {
  const state = rt(initiative.id);

  switch (decision.action) {
    case 'wait':
      return null;

    case 'approve': {
      try {
        answerPrompt(agent, decision);
        initiative.stats.autoApprovals += 1;
        state.lastActionAt = Date.now();
        store.addEvent(initiative, 'auto-approved', `${decision.command || 'prompt'} — ${decision.reason}`);
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
      stage.nudges = (stage.nudges || 0) + 1;
      initiative.stats.nudges += 1;
      state.lastActionAt = Date.now();
      state.idleTicks = 0;
      store.addEvent(initiative, 'nudge', `${decision.reason} → "${decision.message.slice(0, 160)}"`);
      note(`nudged: ${decision.reason}`, initiative.id);
      return store.save(initiative);
    }

    case 'advance': {
      const next = store.advanceStage(initiative, decision.reason);
      state.lastCheck = null;
      state.lastCheckAt = 0;
      state.lastActionAt = Date.now();
      state.idleTicks = 0;
      if (next) {
        sendToAgent(agent, stageBriefing(initiative, next));
        note(`advanced to ${next.name}`, initiative.id);
      } else {
        notify(`${initiative.name} finished`, 'All stages complete.');
        note('initiative complete', initiative.id);
      }
      return store.save(initiative);
    }

    case 'complete': {
      store.advanceStage(initiative, decision.reason);
      initiative.status = 'done';
      store.addEvent(initiative, 'completed', decision.reason);
      notify(`${initiative.name} finished`, 'All stages complete.');
      note('initiative complete', initiative.id);
      return store.save(initiative);
    }

    case 'gate': {
      openGateAndNotify(initiative, {
        kind: decision.kind,
        question: decision.question,
        options: decision.options,
        defaultOption: decision.defaultOption,
        reason: decision.reason,
        command: decision.command,
        context: ctx.checkDetail,
      });
      state.lastActionAt = Date.now();
      return store.save(initiative);
    }

    case 'ask-llm': {
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
      const messages = recentMessages(agent);
      const result = await askLlm(initiative, stage, messages, ctx.checkDetail);
      state.llmInFlight = false;

      const fresh = store.get(initiative.id);
      if (!fresh || fresh.status !== 'running') return null;
      const freshStage = store.currentStage(fresh);
      fresh.stats.llmDecisions += 1;

      if (!result) {
        openGateAndNotify(fresh, {
          kind: 'decision',
          question: `"${fresh.name}" is idle and the supervisor could not work out the next step.`,
          options: ['Keep going', 'Skip this stage', 'Stop the run'],
          reason: 'judgement call failed or timed out',
          context: ctx.checkDetail,
        });
        return store.save(fresh);
      }

      if (result.action === 'gate') {
        openGateAndNotify(fresh, {
          kind: 'decision',
          question: result.question || 'The run needs a decision.',
          options: Array.isArray(result.options) ? result.options : [],
          defaultOption: result.defaultOption || null,
          reason: result.reason || 'judged to need a human',
          context: ctx.checkDetail,
        });
        return store.save(fresh);
      }

      if (result.action === 'advance') {
        const next = store.advanceStage(fresh, result.reason || 'judged complete');
        if (next) sendToAgent(agent, stageBriefing(fresh, next));
        state.lastCheck = null;
        state.lastCheckAt = 0;
        state.lastActionAt = Date.now();
        return store.save(fresh);
      }

      const message = result.message || policy.decide({ status: 'idle', stage: freshStage, stopText: '', checkPassed: false, nudges: 0, profile: fresh.profile }).message
        || 'Continue with the current stage.';
      sendToAgent(agent, message);
      freshStage.nudges = (freshStage.nudges || 0) + 1;
      fresh.stats.nudges += 1;
      state.lastActionAt = Date.now();
      state.idleTicks = 0;
      store.addEvent(fresh, 'llm-continue', `${result.reason || 'judged safe to continue'} → "${String(message).slice(0, 160)}"`);
      note(`llm decided continue: ${result.reason || ''}`, fresh.id);
      return store.save(fresh);
    }

    default:
      return null;
  }
}

// ─── Run lifecycle ───────────────────────────────────────────────────────────

function startRun(initiative) {
  const stage = store.currentStage(initiative);
  try {
    const { sessionName } = launchAgent({
      agentId: initiative.agentId,
      cwd: initiative.cwd,
      sessionName: `init-${initiative.name}`.slice(0, 40),
      skipPermissions: false,
      presetFlags: '',
    });
    initiative.run = { sessionName, startedAt: new Date().toISOString() };
    stage.status = 'active';
    stage.startedAt = stage.startedAt || new Date().toISOString();
    store.addEvent(initiative, 'run-started', `Launched ${initiative.agentId} in tmux session ${sessionName}`);
    note(`launched ${initiative.agentId} (${sessionName})`, initiative.id);
    rt(initiative.id).lastActionAt = Date.now();
    // The agent needs a moment to boot before it can read anything.
    setTimeout(() => {
      const agent = findAgent(store.get(initiative.id) || initiative);
      if (!agent) return;
      try {
        sendToAgent(agent, stageBriefing(initiative, stage));
      } catch {}
    }, 8000);
    return store.save(initiative);
  } catch (e) {
    initiative.status = 'failed';
    store.addEvent(initiative, 'error', `Could not launch agent: ${e.message}`);
    return store.save(initiative);
  }
}

function handleMissingAgent(initiative) {
  const alreadyAsked = store.openGates(initiative).some(g => g.kind === 'agent-exited');
  if (alreadyAsked) return null;
  openGateAndNotify(initiative, {
    kind: 'agent-exited',
    question: `The agent for "${initiative.name}" is no longer running. Relaunch and continue from "${store.currentStage(initiative)?.name}"?`,
    options: ['Relaunch', 'Stop the run'],
    defaultOption: 'Relaunch',
    reason: 'agent process disappeared',
  });
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

  if (gate.kind === 'agent-exited') {
    if (/^relaunch/.test(lower)) {
      initiative.run = null;
      initiative.status = 'running';
      store.addEvent(initiative, 'relaunch', 'Relaunching the agent for this initiative');
    }
    return;
  }

  if (/^skip/.test(lower)) {
    store.skipStage(initiative, 'skipped at a gate');
    initiative.status = 'running';
    return;
  }

  initiative.status = 'running';
  const agent = findAgent(initiative);
  if (!agent) return;

  try {
    if (gate.kind === 'permission') {
      // The human answered a permission prompt in words; relay the answer and
      // let the agent re-ask if it no longer matches the prompt on screen.
      sendToAgent(agent, text);
    } else {
      sendToAgent(agent, `[OpenOrcha] ${text}`);
    }
    rt(initiative.id).lastActionAt = Date.now();
    rt(initiative.id).idleTicks = 0;
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
      autoApprovals: counts['auto-approved'] || 0,
      nudges: (counts.nudge || 0) + (counts['llm-continue'] || 0),
      gatesOpened: counts['gate-opened'] || 0,
      autoDecided: events.filter(e => e.type === 'gate-resolved' && /auto-decided/.test(e.detail)).length,
      openGates: store.openGates(initiative).map(g => ({ id: g.id, question: g.question, kind: g.kind, createdAt: g.createdAt })),
      repo: repoSnapshot(initiative.cwd),
      lastEvent: events[events.length - 1] || null,
    });
  }

  const totals = items.reduce((acc, i) => ({
    autoApprovals: acc.autoApprovals + i.autoApprovals,
    nudges: acc.nudges + i.nudges,
    stages: acc.stages + i.stagesCompleted.length,
    openGates: acc.openGates + i.openGates.length,
  }), { autoApprovals: 0, nudges: 0, stages: 0, openGates: 0 });

  return { since: since.toISOString(), generatedAt: new Date().toISOString(), totals, items };
}

// ─── Loop ────────────────────────────────────────────────────────────────────

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (const initiative of store.list()) {
      if (['done', 'failed', 'draft'].includes(initiative.status)) continue;
      try {
        await tickOne(initiative);
      } catch (e) {
        note(`tick error: ${e.message}`, initiative.id);
      }
    }
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
    tracked: [...runtime.keys()],
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
  inferStatus,
  applyGateAnswer,
  buildDigest,
  startRun,
  notify,
  TICK_MS,
};
