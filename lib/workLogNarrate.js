// Describing a day in words.
//
// Detection knows *when* you worked and *which* ticket. It cannot say what you
// were doing — the mechanical summary was three truncated signal strings glued
// together, which is why rows read like "check the review comments at
// https://github.com/meetsoci/soci/pul".
//
// This asks a model instead, and it produces two different texts per line
// because they have two different audiences:
//
//   summary — rich, for you, so a day still makes sense a month later
//   note    — barely a note, for Jira, where nobody wants the detail
//
// Plus the kind of attention the time went to, which is the thing a week of
// rows can actually be added up by.
//
// Transport is the `claude` CLI, matching initiativeSupervisor.js: no new
// dependency and no API key to manage, since it uses the Claude Code auth
// already on this machine.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const config = require('./workLogConfig');
const time = require('./workLogTime');

const NARRATE_TIMEOUT_MS = 120000;

// The kinds of attention a working day actually splits into. Deliberately
// finer than "coding vs meetings": reviewing your own work and reviewing
// someone else's are different jobs, and so are writing a test, running it,
// and building the environment it needs.
const DEFAULT_KINDS = [
  'prompting',
  'coding',
  'reviewing',
  're-review',
  'peer-review',
  'planning',
  'building',
  'testing',
  'functional-testing',
  'env-prep',
  'debugging',
  'discovery',
  'deployment',
  'meetings',
  'other',
];

function kinds(cfg) {
  const configured = cfg?.attentionKinds;
  return Array.isArray(configured) && configured.length ? configured : DEFAULT_KINDS;
}

// A model call from a scratch directory, never a project one: Claude writes a
// transcript per working directory, and writing ours into a repo would drop
// prompts into the very folders the sessions source later reads.
function narrateCwd() {
  const dir = path.join(os.tmpdir(), 'openorcha-worklog');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return os.tmpdir();
  }
}

function extractJson(text) {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced && fenced[1], raw];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

// A day carries hundreds of signals, most of them the same session prompt
// repeated once per message timestamp. The model needs the distinct evidence,
// not the volume.
function compactCandidate(candidate, tz) {
  const seen = new Set();
  const lines = [];

  for (const signal of candidate.signals || []) {
    const text = String(signal.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = `${signal.source}|${text.slice(0, 60).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A session's line is everything asked in it that day, already trimmed by
    // the collector; cutting it here would hide the day's later asks.
    lines.push(`    [${signal.source} ${signal.wall || ''}] ${signal.source === 'sessions' ? text : text.slice(0, 200)}`);
    if (lines.length === 18) break;
  }

  const counts = Object.entries(candidate.sourceCounts || {})
    .map(([source, n]) => `${source}×${n}`)
    .join(', ');

  return [
    `  key: ${candidate.candidateKey}`,
    `  ticket: ${candidate.ticket || '(none — needs a short effort name)'}`,
    `  window: ${candidate.startTime} for ${time.formatDuration(candidate.minutes)}`,
    `  signals: ${counts}`,
    '  evidence:',
    ...lines,
  ].join('\n');
}

// Your own posts from the days before, as saved in the Posted layer. What
// you actually sent is the best description there is of how these lines
// should read — the instructions below only approximate it.
function styleExamples(examples) {
  if (!examples || !examples.length) return [];
  return [
    'How this person actually writes these up. Below are end-of-day posts they',
    'sent on earlier days. Match their granularity, wording and what they choose',
    'to mention in "title", "context" and "eod" — but take every fact from the',
    'evidence for this day, never from these posts.',
    '',
    ...examples.map(e => e.text.replace(/```/g, '').trim()),
    '',
  ];
}

function buildPrompt(dayKey, candidates, cfg, examples = []) {
  const tz = cfg.workTimezone;
  const allowed = kinds(cfg);

  return [
    `Below is the raw evidence of one engineer's work on ${dayKey}, grouped into blocks.`,
    'Each block is one ticket (or one unattributed stretch) and carries the commits,',
    'Claude Code session prompts, and pull-request review activity recorded in that window.',
    '',
    'For each block, work out what the person was actually doing and return:',
    '',
    '  label   — the context. The ticket key if there is one. If there is no ticket,',
    '            a short name for the effort (3-6 words, e.g. "local 503 debugging",',
    '            "GA4 spreadsheet mapping"). Never leave it empty.',
    '  kind    — the kind of attention the time went to. Exactly one of:',
    `            ${allowed.join(', ')}`,
    '            Classify by what the work WAS, not how it was carried out. This',
    '            person does nearly everything by driving an AI agent, so the mere',
    '            presence of a Claude session is not evidence of "prompting" —',
    '            writing a feature is "coding" even when an agent typed it, and',
    '            chasing a bug is "debugging" even when an agent ran the commands.',
    '            Reserve "prompting" for stretches where steering the agent was',
    '            itself the work: drafting a spec with it, or iterating on',
    '            instructions with no underlying build or investigation.',
    '            Reviewing your own work is "reviewing"; reviewing a teammate\'s pull',
    '            request is "peer-review"; a second or later pass over the same PR is',
    '            "re-review".',
    '  summary — one or two plain sentences saying what was done, specific enough to',
    '            still make sense in a month. This is a private log, so name the',
    '            actual thing (what broke, what was built, what was checked).',
    '            Do not restate the ticket key, and do not paste URLs.',
    '  note    — a Jira worklog comment. Deliberately terse and unrevealing:',
    '            two to four words, e.g. "Code review.", "Implementation.",',
    '            "Debugging and fixes.". This goes on a shared ticket, so it must',
    '            carry no detail beyond the shape of the work.',
    '  title   — the ticket\'s own title as best you can tell from the evidence',
    '            (pull-request titles carry it). Not what was done today — the',
    '            name of the ticket itself. Empty string if you cannot tell.',
    '  status  — where the work stands at the end of the day, judged from the',
    '            evidence: "live" if a PR merged and deployed, "merged" if merged,',
    '            "in review" if a PR is open, "in progress" if there are commits',
    '            but no PR, "in discovery" if it was only reading and scoping,',
    '            or "" if none of these fit.',
    '  context — one short clause saying what the ticket itself is about, lower',
    '            case, no final stop, about ten words. The standing subject of the',
    '            ticket, not today\'s activity: "server-side child counts per',
    '            directory level", not "threaded the count through". Empty string',
    '            when the evidence does not say what the ticket is for.',
    '  eod     — one short clause for a standup post, lower case, no final stop,',
    '            about eight words. Not a sentence and not a repeat of the title:',
    '            the specific thing that moved, e.g. "mass linking through internal',
    '            page", "fix flaky spec", "dropped the backfill migration". Empty',
    '            string when the title and status already say everything.',
    '',
    'Judge only from the evidence. If a block is too thin to read, say so in the',
    'summary rather than inventing activity, and use kind "other".',
    '',
    ...styleExamples(examples),
    'Blocks:',
    '',
    candidates.map(c => compactCandidate(c, tz)).join('\n\n'),
    '',
    'Reply with JSON only, no prose and no code fence:',
    '{"blocks":[{"key":"<the key verbatim>","label":"...","kind":"...","title":"...",',
    '            "status":"...","context":"...","summary":"...","note":"...","eod":"..."}]}',
  ].join('\n');
}

function runClaude(prompt, cfg) {
  return new Promise(resolve => {
    const model = cfg.narrateModel || 'claude-opus-5';
    const child = spawn('claude', [
      '-p', prompt,
      '--output-format', 'json',
      '--model', model,
      // Reading the day is our job; the model only interprets what we hand it.
      '--disallowed-tools', 'Read', 'Grep', 'Glob', 'Bash', 'Task', 'WebFetch', 'WebSearch',
    ], { cwd: narrateCwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });

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
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ error: `no answer within ${Math.round(NARRATE_TIMEOUT_MS / 1000)}s` });
    }, NARRATE_TIMEOUT_MS);

    child.stdout.on('data', d => { if (stdout.length < 4e6) stdout += d; });
    child.stderr.on('data', d => { if (stderr.length < 20000) stderr += d; });
    child.on('error', e => finish({ error: `could not run claude: ${e.message}` }));

    child.on('close', code => {
      if (!stdout.trim()) {
        const tail = stderr.trim().split('\n').slice(-2).join(' ').slice(0, 200);
        return finish({ error: `claude exited ${code}${tail ? `: ${tail}` : ' with no output'}` });
      }
      // The CLI wraps the reply in a JSON envelope; the answer is in .result.
      const envelope = extractJson(stdout);
      const text = envelope && typeof envelope.result === 'string' ? envelope.result : stdout;
      const parsed = extractJson(text);
      if (!parsed || !Array.isArray(parsed.blocks)) {
        return finish({ error: `reply was not the expected JSON: ${String(text).trim().slice(0, 160)}` });
      }
      finish({ blocks: parsed.blocks });
    });
  });
}

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Narration for one day, keyed by candidate key. Returns {} when narration is
// off, unavailable, or fails — every caller falls back to the mechanical
// summary, so a missing model degrades the wording and nothing else.
async function narrateDay({ dayKey, candidates, cfg = config.read() }) {
  if (cfg.narrate === false) return { byKey: {}, error: null, skipped: 'disabled' };
  if (!candidates || !candidates.length) return { byKey: {}, error: null, skipped: 'empty' };

  // Required here rather than at the top: the store is a sibling, and keeping
  // this module's load free of it keeps the prompt builder testable alone.
  const examples = cfg.narrateFromPosted === false ? [] : require('./workLogStore').recentPosted(dayKey, 3);
  const result = await runClaude(buildPrompt(dayKey, candidates, cfg, examples), cfg);
  if (result.error) return { byKey: {}, error: result.error, skipped: null };

  const allowed = new Set(kinds(cfg));
  const known = new Set(candidates.map(c => c.candidateKey));
  const byKey = {};

  for (const block of result.blocks) {
    const key = clean(block.key, 200);
    if (!known.has(key)) continue;
    const kind = clean(block.kind, 40).toLowerCase();
    byKey[key] = {
      label: clean(block.label, 80),
      title: clean(block.title, 140),
      status: clean(block.status, 30).toLowerCase(),
      // What the ticket is, as distinct from what was done to it today.
      context: clean(block.context, 140),
      eod: clean(block.eod, 120),
      // An unrecognised kind is the model's invention, not a new category.
      kind: allowed.has(kind) ? kind : 'other',
      summary: clean(block.summary, 400),
      note: clean(block.note, 80),
    };
  }

  return { byKey, error: null, skipped: null, model: cfg.narrateModel || 'claude-opus-5' };
}

module.exports = { DEFAULT_KINDS, kinds, narrateDay, buildPrompt, compactCandidate, extractJson };
