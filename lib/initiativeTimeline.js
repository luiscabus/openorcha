// One run, one stream.
//
// A run's story arrives from three places: what was said to and by its agents,
// what the supervisor did, and the decisions it stopped for. Splitting those
// into separate tabs made the operator reconstruct the order in their head, and
// hid the conversation — the one part they act through — behind a click.
//
// This merges them chronologically. Gates stay answerable in place, because a
// gate is a moment in the story, not a separate inbox.

const orch = require('./initiativeOrchestrator');

// Events worth telling the story with. The rest — every nudge, every approved
// prompt — is detail, available but not narrated by default.
const STORY_EVENTS = new Set([
  'created', 'started', 'baseline', 'run-started', 'worker-started', 'briefed',
  'orchestrator-briefed', 'stage-start', 'stage-done', 'stage-skipped', 'stage-split',
  'task-done', 'parallel-done', 'completed', 'paused', 'cancelled', 'relaunch',
  'error', 'warning', 'dod-set', 'dod-met', 'dod-gap', 'llm-failed', 'reset',
  'worktree-removed', 'message-queued', 'orchestrator-on', 'orchestrator-off', 'cleanup',
]);

const EVENT_LABELS = {
  created: 'Initiative created',
  started: 'Supervisor took over',
  baseline: 'Starting point recorded',
  'run-started': 'Run started',
  'worker-started': 'Agent started',
  briefed: 'Agent briefed',
  'orchestrator-briefed': 'Orchestrator briefed',
  'stage-start': 'Stage started',
  'stage-done': 'Stage finished',
  'stage-skipped': 'Stage skipped',
  'stage-split': 'Stage split into parallel tasks',
  'task-done': 'Task finished',
  'parallel-done': 'Parallel work merged',
  completed: 'Run complete',
  paused: 'Paused',
  cancelled: 'Stopped',
  relaunch: 'Relaunching',
  error: 'Error',
  warning: 'Warning',
  'dod-set': 'Definition of done set',
  'dod-met': 'Criterion met',
  'dod-gap': 'Held at the finish line',
  'llm-failed': 'Judgement call failed',
  nudge: 'Nudged',
  'llm-continue': 'Told to continue',
  'auto-approved': 'Approved a prompt',
  'gate-opened': 'Stopped for you',
  'gate-resolved': 'Answered',
  'worker-finished': 'Agent finished',
  'user-message': 'You said something',
  'prompt-answered': 'Prompt answered',
  reset: 'Reset',
};

function ts(value) {
  const n = Date.parse(value || '');
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build the stream.
 *
 * @param initiative  the run
 * @param chatTurns   classified turns from the orchestrator (or lead worker)
 * @param options     { detail: 'story' | 'all' }
 */
function build(initiative, chatTurns = [], { detail = 'story' } = {}) {
  const entries = [];

  for (const turn of chatTurns) {
    // Supervisor traffic in the transcript is already represented by events;
    // showing both says the same thing twice.
    if (turn.side === 'system') {
      if (detail === 'all') {
        entries.push({ kind: 'plumbing', at: turn.timestamp, text: turn.text, tools: turn.tools || [] });
      }
      continue;
    }
    entries.push({
      kind: turn.side === 'you' ? 'you' : 'agent',
      at: turn.timestamp,
      text: turn.text,
      tools: turn.tools || [],
      who: turn.who || null,
    });
  }

  for (const event of initiative.events || []) {
    if (detail !== 'all' && !STORY_EVENTS.has(event.type)) continue;
    // A gate gets its own card; its events would duplicate it.
    if (event.type === 'gate-opened' || event.type === 'gate-resolved') continue;
    // The operator's messages are already in the stream as what they said.
    if (event.type === 'user-message') continue;
    entries.push({
      kind: 'event',
      at: event.ts,
      type: event.type,
      label: EVENT_LABELS[event.type] || event.type,
      text: event.detail,
      stage: event.stageName || null,
      severity: event.type === 'error' ? 'error' : event.type === 'warning' ? 'warning' : 'normal',
    });
  }

  for (const gate of initiative.gates || []) {
    entries.push({
      kind: 'gate',
      at: gate.createdAt,
      gateId: gate.id,
      gateKind: gate.kind,
      question: gate.question,
      options: gate.options || [],
      defaultOption: gate.defaultOption || null,
      reason: gate.reason || '',
      context: gate.context || '',
      command: gate.command || null,
      open: !gate.resolvedAt,
      answer: gate.answer || null,
      answeredBy: gate.answeredBy || null,
      resolvedAt: gate.resolvedAt || null,
    });
  }

  entries.sort((a, b) => ts(a.at) - ts(b.at));

  // Fold runs of identical events: "Approved a prompt" fourteen times in a row
  // is one thing that happened, not fourteen.
  const folded = [];
  for (const entry of entries) {
    const last = folded[folded.length - 1];
    if (entry.kind === 'event' && last?.kind === 'event' && last.type === entry.type && entry.severity === 'normal') {
      last.count = (last.count || 1) + 1;
      last.at = entry.at;
      last.text = entry.text;
      continue;
    }
    folded.push({ ...entry });
  }

  return folded;
}

module.exports = { build, STORY_EVENTS, EVENT_LABELS };
