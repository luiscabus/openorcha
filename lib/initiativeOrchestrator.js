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
    'You will be sent updates as the run moves, and questions when a decision is needed.',
    'When asked for a decision, reply with ONLY a JSON object on its own line:',
    '  {"action":"continue","message":"what to tell the worker","reason":"one sentence"}',
    '  {"action":"advance","reason":"why this stage is finished"}',
    '  {"action":"gate","question":"what the operator must decide","options":["..."],"defaultOption":"the safe reversible one or null","reason":"..."}',
    'When the operator talks to you, answer them normally — no JSON.',
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

/** A decision request, phrased so the reply is parsable. */
function decisionRequest({ work, workerName, checkDetail, transcript, hasCheck }) {
  return [
    `[OpenOrcha] Decision needed on "${work?.name}".`,
    workerName ? `Worker: ${workerName}.` : '',
    hasCheck
      ? `Check: ${describeCheckShort(work?.check)} — last result: ${checkDetail || 'not evaluated'}.`
      : 'There is no automatic check for this — judge from what the worker has done whether it is finished.',
    '',
    'What the worker has been doing:',
    transcript || '(nothing recorded)',
    '',
    'Reply with only the JSON decision object.',
  ].filter(Boolean).join('\n');
}

/** Short notes so the orchestrator keeps up without being asked. */
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
  if (!['continue', 'advance', 'gate'].includes(parsed.action)) {
    return parsed.message ? { ...parsed, action: 'continue' } : null;
  }
  return parsed;
}

module.exports = {
  ORCHESTRATOR_REPLY_TIMEOUT_MS,
  openingBrief,
  decisionRequest,
  updateNote,
  extractDecision,
  describeCheckShort,
};
