// Framing: working out what "done" means before the work starts.
//
// A run is only as autonomous as its definition of done. With nothing to check
// against, the supervisor has to fall back on judgement and gates — which is
// precisely the thing that pulls you back in. So this makes one pass up front:
// it reads the goal and enough of the repository to be concrete, and proposes
// acceptance criteria that each carry the check that settles them.
//
// It is a proposal, not a decision. You edit it and press go once, instead of
// answering twenty questions later.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const templates = require('./initiativeTemplates');

const FRAMING_TIMEOUT_MS = 180000;
const MAX_CONTEXT_CHARS = 6000;

/** A cheap sketch of the repository, so the proposal talks about real files. */
function repoContext(cwd) {
  const parts = [];
  const push = (label, body) => {
    if (body && body.trim()) parts.push(`--- ${label} ---\n${body.trim().slice(0, 2000)}`);
  };

  const readIfPresent = name => {
    const fp = path.join(cwd, name);
    try {
      return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
    } catch {
      return '';
    }
  };

  push('README', readIfPresent('README.md').split('\n').slice(0, 40).join('\n'));
  push('CLAUDE.md', readIfPresent('CLAUDE.md').split('\n').slice(0, 30).join('\n'));

  const pkg = readIfPresent('package.json');
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg);
      push('package.json scripts', JSON.stringify(parsed.scripts || {}, null, 2));
    } catch {}
  }

  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
      .slice(0, 40)
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name));
    push('top level', entries.join('  '));
  } catch {}

  return parts.join('\n\n').slice(0, MAX_CONTEXT_CHARS);
}

function buildPrompt({ goal, cwd, template, spec, ticket }) {
  const tpl = template ? templates.get(template) : null;
  return [
    'You are helping decide what "done" means for a piece of work, BEFORE it starts.',
    'The answer is used by an automated supervisor that keeps a coding agent moving without',
    'a human watching, so every criterion you propose must be something a machine can check',
    'from the filesystem or a shell command — or, when it genuinely cannot be, be marked as',
    'needing a human verdict rather than dressed up as checkable.',
    '',
    `GOAL: ${goal}`,
    ticket ? `TICKET: ${ticket}` : '',
    `WORKING DIRECTORY: ${cwd}`,
    tpl ? `KIND OF WORK: ${tpl.name} — ${tpl.summary}\nSTAGES: ${tpl.stages.map(s => s.name).join(' → ')}` : '',
    '',
    spec ? `SPEC / NOTES PROVIDED:\n${String(spec).slice(0, 4000)}\n` : '',
    'REPOSITORY:',
    repoContext(cwd) || '(nothing readable)',
    '',
    'Propose 3 to 6 acceptance criteria. Each is one sentence describing an observable',
    'outcome, plus the check that settles it. Available check types:',
    '  {"type":"command","command":"npm test"}            — passes when the command exits 0',
    '  {"type":"file-exists","path":"docs/plan.md"}       — the deliverable exists',
    '  {"type":"file-contains","path":"docs/plan.md","patterns":["Phase","Risks"]} — and covers these points',
    '  {"type":"git-clean"}      — nothing uncommitted is left behind',
    '  {"type":"git-dirty"}      — the opposite: changes EXIST but are not committed yet',
    '  {"type":"commits-ahead"}  — the branch has commits master does not',
    '  {"type":"pushed"}         — the branch is pushed and in sync',
    '  {"type":"pr-exists"}      — a pull request exists for the branch',
    '  {"type":"human","detail":"why a person has to judge this"}',
    '',
    'Rules:',
    '- Prefer a real check over a human one; use "human" only when nothing observable settles it.',
    '- For document work (a spec review, a discovery, a breakdown), name the actual file the',
    '  agent should write and the points it must cover.',
    '- For code work, prefer the project\'s own test or build command — look at the scripts above.',
    '- Criteria must be specific to THIS goal. No generic "code is high quality".',
    '- Also list the questions whose answers would change the criteria, so they can be settled now.',
    '',
    'Reply with ONLY this JSON object, no prose, no code fence:',
    '{"criteria":[{"text":"...","check":{...}}],',
    ' "verifyCommand":"the project command that proves code work, or empty",',
    ' "openQuestions":["question that would change the definition of done"],',
    ' "suggestedTemplate":"pr-review|spec-to-tickets|ticket-to-pr|poc-spike|discovery",',
    ' "summary":"one sentence on what done looks like"}',
  ].filter(Boolean).join('\n');
}

function framingCwd() {
  const dir = path.join(os.tmpdir(), 'openorcha-framing');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return os.tmpdir();
  }
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

const VALID_CHECKS = ['command', 'file-exists', 'file-contains', 'git-dirty', 'git-clean', 'branch-created', 'commits-ahead', 'pushed', 'pr-exists', 'human'];

function sanitizeProposal(raw) {
  if (!raw || !Array.isArray(raw.criteria)) return null;
  const criteria = raw.criteria
    .filter(c => c && String(c.text || '').trim())
    .slice(0, 8)
    .map((c, i) => {
      let type = VALID_CHECKS.includes(c.check?.type) ? c.check.type : 'human';
      // "Everything is committed" is git-clean, not git-dirty. Left inverted,
      // the criterion can never pass once the work is actually committed and
      // the run would sit at the finish line for ever.
      if (type === 'git-dirty' && /\b(no uncommitted|nothing uncommitted|all .{0,24}committed|working tree.{0,12}clean|are committed)\b/i.test(c.text)) {
        type = 'git-clean';
      }
      const check = type === 'human'
        ? { type: 'human', detail: String(c.check?.detail || 'needs your judgement').slice(0, 200) }
        : { ...c.check, type };
      return { id: `dod-${i + 1}`, text: String(c.text).trim().slice(0, 300), check };
    });
  if (!criteria.length) return null;
  return {
    criteria,
    verifyCommand: String(raw.verifyCommand || '').trim().slice(0, 200),
    openQuestions: (Array.isArray(raw.openQuestions) ? raw.openQuestions : []).slice(0, 5).map(q => String(q).slice(0, 300)),
    suggestedTemplate: templates.get(raw.suggestedTemplate) ? raw.suggestedTemplate : null,
    summary: String(raw.summary || '').slice(0, 400),
  };
}

/**
 * Ask for a definition of done. Resolves to a proposal, or null if the pass
 * could not produce a usable one — the caller falls back to writing it by hand.
 */
function frame({ goal, cwd, template, spec, ticket, model = 'sonnet' }) {
  return new Promise(resolve => {
    if (!goal || !cwd) return resolve(null);
    execFile(
      'claude',
      [
        '-p', buildPrompt({ goal, cwd, template, spec, ticket }),
        '--output-format', 'json',
        '--model', model,
        // No tools. The repository context this pass needs is already in the
        // prompt, and letting it explore turned a one-minute answer into a
        // timeout — framing has to be fast enough to sit in front of the work.
        '--disallowed-tools', 'Read', 'Grep', 'Glob', 'Bash', 'Task', 'WebFetch', 'WebSearch',
      ],
      // Same reason as the decider: keep this pass's transcript out of the
      // project directory the supervisor searches for live agent sessions.
      { cwd: framingCwd(), timeout: FRAMING_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: process.env },
      (err, stdout) => {
        if (err && !stdout) return resolve(null);
        let text = stdout;
        const envelope = extractJson(stdout);
        if (envelope && typeof envelope.result === 'string') text = envelope.result;
        resolve(sanitizeProposal(extractJson(text)));
      },
    );
  });
}

module.exports = { frame, buildPrompt, repoContext, sanitizeProposal, FRAMING_TIMEOUT_MS };
