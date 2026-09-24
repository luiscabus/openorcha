// What an agent was launched to do.
//
// An agent process tells you almost nothing about its job: `ps` gives a pid, a
// binary and a working directory, and every agent on the machine looks alike
// from there. So an orchestrator deciding who should handle a piece of work saw
// a flat list of strangers, and the cheapest move available to it was to talk to
// whichever one was already running — which is how the agent doing ticket
// discovery got asked to fix something in another project entirely.
//
// The remit is recorded at launch, when it is the one moment the reason is
// actually known, and travels with the agent from then on.

const fs = require('fs');
const path = require('path');

const ASSIGNMENTS_DIR = process.env.OPENORCHA_ASSIGNMENTS_DIR
  || path.join(__dirname, '..', 'data', 'agents');

const FILE = () => path.join(ASSIGNMENTS_DIR, 'assignments.json');

// Enough history to explain an agent that is still running, and no more.
const KEEP = 400;

function ensureDir() {
  fs.mkdirSync(ASSIGNMENTS_DIR, { recursive: true });
}

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return Array.isArray(parsed?.assignments) ? parsed.assignments : [];
  } catch {
    return [];
  }
}

function writeAll(assignments) {
  ensureDir();
  fs.writeFileSync(FILE(), JSON.stringify({ assignments: assignments.slice(-KEEP) }, null, 2), 'utf8');
  return assignments;
}

function normalize(raw) {
  return {
    // The tmux session is the stable handle. A pid changes when a CLI restarts
    // inside its pane; the session it lives in does not.
    sessionName: String(raw?.sessionName || '').trim(),
    agentId: raw?.agentId || null,
    // The directory this agent is for. Work outside it belongs to someone else.
    cwd: raw?.cwd || null,
    // One line saying what it was started to do, in the words of whoever
    // started it.
    purpose: (raw?.purpose || '').trim() || null,
    // Who started it: 'operator', 'orchestrator', or `initiative:<id>`.
    launchedBy: (raw?.launchedBy || '').trim() || 'operator',
    initiativeId: raw?.initiativeId || null,
    workerId: raw?.workerId || null,
    // 'worker' does stage work, 'orchestrator' coordinates, 'delegate' was spun
    // off for something outside the run that started it.
    role: ['worker', 'orchestrator', 'delegate', 'operator'].includes(raw?.role) ? raw.role : 'operator',
    startedAt: raw?.startedAt || new Date().toISOString(),
  };
}

/** Write down why an agent exists. Replaces any record for the same session. */
function record(assignment) {
  const entry = normalize(assignment);
  if (!entry.sessionName) return null;
  writeAll([...readAll().filter(a => a.sessionName !== entry.sessionName), entry]);
  return entry;
}

function get(sessionName) {
  if (!sessionName) return null;
  return readAll().find(a => a.sessionName === sessionName) || null;
}

function list() {
  return readAll();
}

function forget(sessionName) {
  const before = readAll();
  const after = before.filter(a => a.sessionName !== sessionName);
  if (after.length === before.length) return false;
  writeAll(after);
  return true;
}

/** Drop records for sessions that no longer exist. */
function prune(liveSessionNames) {
  const live = new Set(liveSessionNames || []);
  const kept = readAll().filter(a => live.has(a.sessionName));
  writeAll(kept);
  return kept;
}

// Whether a piece of work belongs to this agent. Used to say why it does not,
// rather than to forbid anything: the operator can always talk to any agent,
// but an orchestrator should have to notice.
function covers(assignment, dir) {
  if (!assignment?.cwd || !dir) return false;
  const base = path.resolve(assignment.cwd);
  const target = path.resolve(dir);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

module.exports = { ASSIGNMENTS_DIR, record, get, list, forget, prune, covers, normalize };
