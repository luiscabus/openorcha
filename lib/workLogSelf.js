// This tool's own sessions are not work.
//
// Reading a day runs `claude` to describe the evidence, and the initiative
// supervisor runs it to make decisions. Those runs leave transcripts like any
// other, and the transcripts quote the very ticket keys they were given — so
// the sessions source picked them up as evidence, invented a row for the ticket
// they mentioned, and the same tickets resurfaced day after day as work nobody
// did. Analysing Tuesday would manufacture Tuesday's tickets into Wednesday.
//
// Identified by what they say rather than where they ran: the scratch
// directories only cover sessions started after we moved them there, and there
// are already two dozen in ordinary project directories from before.

const path = require('path');

// Prompts only this tool ever sends, to a model, with nobody present. A
// transcript that opens with one of these is machine talking to machine from
// beginning to end.
const OWN_PROMPTS = [
  /^Below is the raw evidence of one engineer's work on \d{4}-\d{2}-\d{2}/, // worklog narration
  /^You are supervising a coding agent so its human operator/,             // supervisor decider
  /^You are helping decide what "done" means for a piece of work/,         // initiative framing
];

// What this tool says to an agent it launched: briefings, updates, nudges, and
// the operator's own words relayed with a marker. Marked from now on; the
// literal openings cover the transcripts that already exist.
const OWN_AGENT_TRAFFIC = [
  /^\[OpenOrcha/,
  /^Go ahead — take the step you just offered/,
  /^Continue with the current stage:/,
  /^Continue with [A-Z]/,
  /^You hit an error\. Diagnose the root cause/,
  /^You reported this as done, but the stage check/,
  /^The stages are done but the definition of done/,
  /^Continue the ground-truth pass/,
];

// Scratch directories this tool runs its own sessions in. Belt to the braces
// above: cheap to check, and correct for anything started from now on.
const OWN_PROJECT_DIRS = [
  /openorcha-worklog$/,
  /openorcha-supervisor$/,
  /openorcha-framing$/,
];

/**
 * Is this transcript one of ours?
 *
 * @param firstPrompt  the session's first human-side message
 * @param projectName  the ~/.claude/projects directory it lives in
 * @param prompts      every human-side turn, when the caller has them
 */
function isOwnSession(firstPrompt, projectName = '', prompts = null) {
  if (OWN_PROJECT_DIRS.some(re => re.test(String(projectName)))) return true;

  const opening = String(firstPrompt || '').trim();
  if (!opening) return false;

  if (OWN_PROMPTS.some(re => re.test(opening))) return true;

  // An agent this tool launched and briefed. Its output shows up as commits
  // and through the initiatives source, so the session itself is ours — unless
  // you spoke in it, in which case your attention was on it and it stays.
  if (OWN_AGENT_TRAFFIC.some(re => re.test(opening))) {
    if (!Array.isArray(prompts) || !prompts.length) return true;
    return prompts.every(p => OWN_AGENT_TRAFFIC.some(re => re.test(String(p).trim())));
  }

  return false;
}

// This tool's own repository, as ~/.claude/projects names a directory: every
// character outside [A-Za-z0-9] becomes a hyphen.
const OWN_REPO_PROJECT = path.resolve(__dirname, '..').replace(/[^A-Za-z0-9]/g, '-');

/**
 * Is this a session working on this tool itself? Such a session is your time
 * like any other, but the ticket keys in it are the data the tool shows — ask
 * why a row is there and you have typed its ticket — not work on the ticket.
 */
function isOwnRepoSession(projectName) {
  const name = String(projectName || '');
  return name === OWN_REPO_PROJECT || name.startsWith(`${OWN_REPO_PROJECT}-`);
}

module.exports = { isOwnSession, isOwnRepoSession, OWN_PROMPTS, OWN_AGENT_TRAFFIC, OWN_PROJECT_DIRS, OWN_REPO_PROJECT };
