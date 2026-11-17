// The per-initiative orchestrator.
//
// A standing agent that owns one run: it holds the goal, the plan and the
// history across stages and workers, decides what happens next when the rules
// do not cover it, and is who the operator talks to.
//
// It has no hands. It cannot launch, kill or message anything — it answers, and
// the supervisor executes. That keeps one actuator in the system and means the
// orchestrator needs no API access, no shell, and no new permissions.

const path = require('path');

const ORCHESTRATOR_REPLY_TIMEOUT_MS = 150000;

// Everything the supervisor sends is prefixed, and an operator's own words get
// their own marker — otherwise a message that happens to start "Stage finished"
// is indistinguishable from the supervisor saying a stage finished, and the
// conversation cannot be told apart from the plumbing.
const OPERATOR_PREFIX = '[OpenOrcha · operator]';
const UPDATE_PREFIX = '[OpenOrcha]';

// The forms the supervisor itself sends. Anything else prefixed the same way
// came from a person.
const SUPERVISOR_SHAPES = [
  /^\[OpenOrcha\]\s+(Stage (started|finished)|Waiting on the operator|Operator answered|Worker (started|finished)|Parallel task finished|Acceptance criterion met|Run complete|Update):/,
  /^\[OpenOrcha\]\s+Decision needed on/,
  /^\[OpenOrcha\]\s+You are the orchestrator/,
  /^\[OpenOrcha · [^\]]+\]/,
  /No reply needed unless something looks wrong\.$/,
];

/** The standing brief: who it is, what it owns, and how to answer. */
function openingBrief(initiative, stages) {
  return [
    `[OpenOrcha] You are the orchestrator for one piece of work. You do not do the work yourself — other agents do, and a supervisor process carries out whatever you decide. Your job is to hold the thread of this run and to answer two kinds of question: what should happen next, and whatever the operator asks you.`,
    '',
    `INITIATIVE: ${initiative.name}`,
    initiative.ticket ? `TICKET: ${initiative.ticket}` : '',
    `GOAL: ${initiative.goal || '(not stated)'}`,
    `DIRECTORY: ${initiative.cwd}`,
    `AUTONOMY: ${initiative.profile} — local work, commits, pushes and draft PRs happen without asking; posting review comments, non-draft PRs, Jira writes and merges always stop for the operator.`,
    `PARALLELISM: up to ${initiative.maxParallel} worker agents at once, each in its own git worktree.`,
    '',
    'STAGES:',
    ...stages.map((s, i) => `  ${i + 1}. ${s.name} — ${s.instruction}${s.check ? ` [done when: ${describeCheckShort(s.check)}]` : ' [no automatic check]'}`),
    '',
    ...(initiative.acceptance || []).length
      ? ['DEFINITION OF DONE:', ...initiative.acceptance.map(c => `  · ${c.text}${c.check?.type === 'human' ? ' (needs the operator)' : ''}`), '']
      : [],
    'SCOPE:',
    `  Every worker has one job and one directory, and this run's is ${initiative.cwd}.`,
    '  A worker may only be told to do the work it was briefed on, in the directory it',
    '  was given. Work this run turns up that belongs somewhere else — another repo,',
    '  another project, a fix to the tooling you are running inside — is not something',
    '  to hand to whichever agent happens to be running. It gets its own agent, in its',
    '  own directory, with "delegate". If you are unsure whether something is in scope,',
    '  it is not: gate it and let the operator say.',
    '',
    'You will be sent updates as the run moves, and questions when a decision is needed.',
    'When asked for a decision, reply with ONLY a JSON object on its own line:',
    '  {"action":"continue","message":"what to tell the worker","reason":"one sentence"}',
    '  {"action":"advance","reason":"why this stage is finished"}',
    '  {"action":"delegate","directory":"/absolute/path","task":"what the new agent must do","reason":"why this is not that worker\'s job"}',
    '  {"action":"gate","question":"what the operator must decide","options":["..."],"defaultOption":"the safe reversible one or null","reason":"..."}',
    `When the operator talks to you the message starts with "${OPERATOR_PREFIX}". Answer those`,
    'normally, in prose, as a conversation — no JSON, and no need to be brief.',
    'Anything else starting with "[OpenOrcha]" is the supervisor keeping you informed.',
    '',
    'Do not read or change files, and do not run commands. You are the one keeping track, not the one doing.',
  ].filter(Boolean).join('\n');
}

function describeCheckShort(check) {
  if (!check) return 'judgement';
  switch (check.type) {
    case 'command': return check.command;
    case 'file-exists': return `${check.path} exists`;
    case 'file-contains': return `${check.path} covers ${(check.patterns || []).join(', ')}`;
    case 'git-dirty': return 'there are changes';
    case 'git-clean': return 'nothing uncommitted';
    case 'commits-ahead': return 'commits exist';
    case 'pushed': return 'branch pushed';
    case 'pr-exists': return 'a PR exists';
    case 'branch-created': return 'off master';
    default: return check.type;
  }
}

/**
 * A decision request, phrased so the reply is parsable.
 *
 * The worker's directory and branch travel with the question on purpose. Asked
 * only "what should Worker 2 do next", an orchestrator has no way to notice that
 * what it is about to say belongs to a different project — and whatever it says
 * is delivered to that worker verbatim.
 */
function decisionRequest({ work, worker, workerName, checkDetail, transcript, hasCheck }) {
  const name = workerName || worker?.name || null;
  const where = worker?.cwd || null;
  const branch = worker?.worktree?.branch || null;

  return [
    `[OpenOrcha] Decision needed on "${work?.name}".`,
    name ? `Worker: ${name}.` : '',
    where ? `Its directory: ${where}${branch ? ` (branch ${branch})` : ''}.` : '',
    work?.instruction ? `What it was briefed to do: ${String(work.instruction).slice(0, 300)}` : '',
    hasCheck
      ? `Check: ${describeCheckShort(work?.check)} — last result: ${checkDetail || 'not evaluated'}.`
      : 'There is no automatic check for this — judge from what the worker has done whether it is finished.',
    '',
    'What the worker has been doing:',
    transcript || '(nothing recorded)',
    '',
    'A "continue" message goes to this worker, in that directory, word for word. It',
    'must be about the work above. Anything else — another repo, another project, a',
    'fix to the tooling — is a "delegate" or a "gate", never a message to this worker.',
    '',
    'Reply with only the JSON decision object.',
  ].filter(Boolean).join('\n');
}

/** Short notes so the orchestrator keeps up without being asked. */
function operatorMessage(text) {
  return `${OPERATOR_PREFIX} ${String(text || '').trim()}`;
}

function updateNote(kind, detail) {
  const prefix = {
    'stage-start': 'Stage started',
    'stage-done': 'Stage finished',
    'gate-opened': 'Waiting on the operator',
    'gate-resolved': 'Operator answered',
    'worker-started': 'Worker started',
    'worker-finished': 'Worker finished',
    'task-done': 'Parallel task finished',
    'dod-met': 'Acceptance criterion met',
    completed: 'Run complete',
  }[kind] || 'Update';
  return `[OpenOrcha] ${prefix}: ${String(detail || '').slice(0, 400)}. No reply needed unless something looks wrong.`;
}

/**
 * Which side of the conversation a turn belongs to.
 *
 * 'you'          — the operator's own message
 * 'orchestrator' — its answer to you
 * 'system'       — the brief, the status updates, decision requests and the
 *                  JSON decisions: real, but not the conversation
 */
function classifyTurn(role, text) {
  const t = String(text || '').trim();
  if (!t) return 'system';

  if (role !== 'assistant') {
    if (t.startsWith(OPERATOR_PREFIX)) return 'you';
    // A prefixed message is only the supervisor's if it takes one of the
    // supervisor's shapes. Matching the prefix alone made an operator's own
    // words — sent that way before the marker existed — read as plumbing.
    if (SUPERVISOR_SHAPES.some(re => re.test(t))) return 'system';
    // Anything else, prefixed or not, is a person talking.
    return 'you';
  }

  // A bare decision object is an answer to the supervisor, not to a person.
  const stripped = t.replace(/```(?:json)?/g, '').trim();
  if (stripped.startsWith('{') && extractDecision(stripped)) return 'system';
  return 'orchestrator';
}

function stripMarkers(text) {
  return String(text || '')
    .replace(new RegExp(`^\\${OPERATOR_PREFIX.slice(0, 1)}OpenOrcha · operator\\]\\s*`), '')
    .replace(/^\[OpenOrcha\]\s*/, '')
    .trim();
}

function extractDecision(text) {
  const t = String(text || '');
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!['continue', 'advance', 'gate', 'delegate'].includes(parsed.action)) {
    // A reply with a message and no usable action was meant for the worker.
    // Anything naming a directory was not: coercing that into a message is how
    // out-of-scope work ends up pasted into whoever is running.
    if (parsed.directory || parsed.task) return { ...parsed, action: 'delegate' };
    return parsed.message ? { ...parsed, action: 'continue' } : null;
  }
  return parsed;
}

module.exports = {
  ORCHESTRATOR_REPLY_TIMEOUT_MS,
  OPERATOR_PREFIX,
  operatorMessage,
  classifyTurn,
  stripMarkers,
  openingBrief,
  decisionRequest,
  updateNote,
  extractDecision,
  describeCheckShort,
};
