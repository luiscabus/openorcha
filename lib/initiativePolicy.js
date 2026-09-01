// Decision policy for the initiative supervisor.
//
// Everything here is pure: it takes a snapshot of what an agent is doing and
// returns the action the supervisor should take. The impure parts (reading
// tmux, running checks, calling the LLM) live in initiativeSupervisor.js so
// this file stays directly testable.
//
// The rules encode the shape of a real session: agents stall far more often on
// "want me to X, or Y?" offers than on decisions that actually need a human.
// Offers get answered with a default and a note; genuine decisions get gated.

// ─── Autonomy profiles ───────────────────────────────────────────────────────

const PROFILES = {
  // Read, edit, test. Every commit is a checkpoint.
  conservative: { commit: false, push: false, draftPr: false },
  // Everything local. Anything that leaves the machine is a gate.
  standard: { commit: true, push: false, draftPr: false },
  // Also pushes the branch and opens draft PRs, so a run can finish overnight.
  ship: { commit: true, push: true, draftPr: true },
};

const DEFAULT_PROFILE = 'ship';

function profileFor(name) {
  return PROFILES[name] || PROFILES[DEFAULT_PROFILE];
}

// ─── Command classification ──────────────────────────────────────────────────

// Always a gate, whatever the profile says. Irreversible, outward-facing, or
// destructive enough that a wrong call costs more than the wait.
const NEVER_AUTO = [
  { re: /\bgh\s+pr\s+merge\b/i, why: 'merges a pull request' },
  { re: /\bgit\s+push\b[^\n]*--force(?!-with-lease)/i, why: 'force-pushes' },
  { re: /\bgit\s+push\b[^\n]*\b(origin\s+)?(master|main)\b/i, why: 'pushes to master/main' },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i, why: 'discards working tree state' },
  { re: /\bgh\s+pr\s+(comment|review)\b/i, why: 'posts to a pull request' },
  { re: /\bgh\s+api\b[^\n]*-X\s*(POST|PATCH|PUT|DELETE)/i, why: 'writes through the GitHub API' },
  { re: /\b(transitionJiraIssue|editJiraIssue|createJiraIssue|addWorklogToJiraIssue|addCommentToJiraIssue)\b/i, why: 'writes to Jira' },
  { re: /\brm\s+-[a-z]*r[a-z]*f?\s+\//i, why: 'recursive delete' },
  { re: /\bsudo\b/i, why: 'runs as root' },
  { re: /\bcurl\b[^\n]*\|\s*(sh|bash|zsh)\b/i, why: 'pipes a download into a shell' },
  { re: /\b(chmod\s+777|chown\s+-R)\b/i, why: 'broad permission change' },
  { re: /\.env\b|\bid_rsa\b|\bcredentials\b|\bsecrets?\.(json|ya?ml)\b/i, why: 'touches credentials' },
  { re: /\bnpm\s+publish\b|\bdocker\s+push\b|\bterraform\s+apply\b|\bkubectl\s+(apply|delete)\b/i, why: 'deploys or publishes' },
];

// Safe in any profile: reads, local edits, tests, builds.
const ALWAYS_SAFE = [
  /^(cat|ls|head|tail|sed\s+-n|grep|rg|find|wc|file|stat|which|pwd|echo|jq|tree|diff)\b/i,
  /^git\s+(status|diff|log|show|branch|remote|rev-parse|rev-list|blame|stash\s+list|worktree\s+list|fetch)\b/i,
  /^gh\s+(pr\s+(view|list|diff|checks|status)|run\s+(list|view|watch)|issue\s+(view|list))\b/i,
  /^(npm|yarn|pnpm)\s+(test|run|ci|install)\b/i,
  /^(pytest|phpunit|behat|jest|vitest|cypress|go\s+test|cargo\s+test|make)\b/i,
  /^docker\s+compose\b(?!.*\bdown\s+-v)/i,
  /^composer\s+(install|update|dump-autoload)\b/i,
  /^python3?\s+-/i,
];

// Guarded by profile.
const PROFILE_GATED = [
  { re: /^git\s+(add|commit)\b/i, flag: 'commit', why: 'creates a commit' },
  { re: /^git\s+(checkout\s+-b|switch\s+-c)\b/i, flag: 'commit', why: 'creates a branch' },
  { re: /^git\s+worktree\s+add\b/i, flag: 'commit', why: 'creates a worktree' },
  { re: /^git\s+merge\b/i, flag: 'commit', why: 'merges a local branch' },
  { re: /^git\s+cherry-pick\b/i, flag: 'commit', why: 'cherry-picks a commit' },
  { re: /^git\s+push\b/i, flag: 'push', why: 'pushes the branch' },
  { re: /^gh\s+pr\s+create\b[^\n]*--draft\b/i, flag: 'draftPr', why: 'opens a draft PR' },
  { re: /^gh\s+pr\s+create\b/i, flag: '__never__', why: 'opens a non-draft PR' },
];

/**
 * Decide whether a shell command may run unattended.
 * Returns { allow: boolean, why: string }.
 */
function classifyCommand(command, profileName, { protectedBranch = false } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return { allow: false, why: 'empty command' };

  for (const rule of NEVER_AUTO) {
    if (rule.re.test(cmd)) return { allow: false, why: rule.why };
  }

  // A compound command is only as safe as its least safe part.
  const parts = cmd.split(/&&|\|\||;|\n/).map(p => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const results = parts.map(p => classifyCommand(p, profileName, { protectedBranch }));
    const blocked = results.find(r => !r.allow);
    return blocked || { allow: true, why: 'all sub-commands are safe' };
  }

  const profile = profileFor(profileName);
  for (const rule of PROFILE_GATED) {
    if (rule.re.test(cmd)) {
      if (rule.flag === '__never__') return { allow: false, why: rule.why };
      // Writing history while sitting on master is never automatic, whatever
      // the profile says — a parallel worker on the wrong branch is exactly
      // the mistake worth stopping for.
      if (protectedBranch) return { allow: false, why: `${rule.why} while on master/main` };
      return profile[rule.flag]
        ? { allow: true, why: `${rule.why} (allowed by ${profileName} profile)` }
        : { allow: false, why: `${rule.why} (not allowed by ${profileName} profile)` };
    }
  }

  if (ALWAYS_SAFE.some(re => re.test(cmd))) return { allow: true, why: 'read-only or test command' };

  return { allow: false, why: 'unrecognized command' };
}

// ─── Permission prompts ──────────────────────────────────────────────────────

const SAFE_PROMPT_SUBJECTS = [
  /\b(read|view|open)\s+file\b/i,
  /\b(edit|write|create|update)\s+(this\s+)?file\b/i,
  /\bmake this edit\b/i,
  /\bcreate\s+.*\.(js|ts|json|md|css|html|php|py|yml|yaml)\b/i,
];

const AFFIRMATIVE = /\b(yes|allow|proceed|approve|accept|run|continue|do it)\b/i;
const REMEMBER = /\b(don't ask again|no, and|always allow|for the rest of this session)\b/i;

/**
 * Decide what to do with a parsed permission prompt.
 * `prompt` is the shape returned by multiplexer.parsePermissionPrompt().
 * Returns { action: 'approve'|'gate', optionKey, reason }.
 */
function classifyPrompt(prompt, profileName, { protectedBranch = false } = {}) {
  if (!prompt) return { action: 'gate', reason: 'no prompt to classify' };

  const blob = `${prompt.context || ''}\n${prompt.question || ''}`;
  const command = extractCommand(blob);

  let verdict;
  if (command) {
    verdict = classifyCommand(command, profileName, { protectedBranch });
  } else if (SAFE_PROMPT_SUBJECTS.some(re => re.test(blob))) {
    verdict = { allow: true, why: 'file read/edit' };
  } else {
    verdict = { allow: false, why: 'prompt subject not recognized' };
  }

  if (!verdict.allow) {
    return { action: 'gate', reason: verdict.why, command };
  }

  // Pick the plain affirmative option, never a "don't ask again" variant —
  // widening permissions for the whole session is the human's call.
  const options = prompt.options || [];
  const idx = options.findIndex(o => AFFIRMATIVE.test(o.label || '') && !REMEMBER.test(o.label || ''));
  if (idx === -1) return { action: 'gate', reason: 'no plain affirmative option', command };

  const option = options[idx];
  return {
    action: 'approve',
    optionKey: prompt.isNumbered ? (option.key || String(idx + 1)) : null,
    optionIndex: idx,
    selectedIdx: prompt.selectedIdx || 0,
    reason: verdict.why,
    command,
  };
}

// Pull the command out of a prompt's context block, e.g. "Bash(git status)"
// or a bare command line above the question.
function extractCommand(blob) {
  const bashCall = blob.match(/\bBash\(([^)]+)\)/);
  if (bashCall) return bashCall[1].trim();
  const lines = String(blob).split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].replace(/^[$>❯›»\s]+/, '');
    if (/^(git|gh|npm|yarn|pnpm|docker|composer|make|python3?|pytest|phpunit|behat|rm|sudo|curl|chmod|chown|kubectl|terraform)\b/.test(l)) {
      return l;
    }
  }
  return null;
}

// ─── Why the agent stopped ───────────────────────────────────────────────────

// An offer is a question the agent could have answered itself: it already has
// a safe next step and is asking for permission to take it.
const OFFER_MARKERS = [
  /\bwant me to\b/i,
  /\bshould i\b/i,
  /\bshall i\b/i,
  /\bwould you like me to\b/i,
  /\blet me know (if|when|whether)\b/i,
  /\bor (hold off|keep refining|leave it)\b/i,
  /\bready (to|for) (proceed|go|continue)\b/i,
];

// A decision needs product/scope judgement the agent cannot source from code.
const DECISION_MARKERS = [
  /\bwhich (one|option|approach|would you prefer)\b/i,
  /\byour call\b/i,
  /\bdo you (want|prefer|think)\b.*\?/i,
  /\b(option a|option b)\b/i,
  /\bnaming\b.*\?/i,
];

const BLOCKED_MARKERS = /\b(failed|failing|error|cannot|can't|could not|unable to|blocked|denied|permission denied|not found)\b/i;
const DONE_MARKERS = /\b(done|complete|completed|finished|created|pushed|committed|merged|added|fixed|updated|ready)\b/i;

/**
 * Classify the agent's last assistant message.
 * Mirrors the buckets measured across real sessions:
 *   question-offer | question-decision | reported-done | blocked | other
 */
function classifyStop(text) {
  const t = String(text || '').trim();
  if (!t) return 'other';
  const tail = t.slice(-600);

  if (tail.includes('?')) {
    if (DECISION_MARKERS.some(re => re.test(tail)) && !OFFER_MARKERS.some(re => re.test(tail))) {
      return 'question-decision';
    }
    if (OFFER_MARKERS.some(re => re.test(tail))) return 'question-offer';
    return 'question-decision';
  }
  if (BLOCKED_MARKERS.test(tail)) return 'blocked';
  if (DONE_MARKERS.test(tail)) return 'reported-done';
  return 'other';
}

// ─── The tick decision ───────────────────────────────────────────────────────

/**
 * Given a snapshot of one initiative's agent, return the supervisor's action.
 *
 * ctx = {
 *   status:            'thinking' | 'idle' | 'waiting_input' | 'process_exited',
 *   prompt:            parsed permission prompt or null,
 *   stopText:          last assistant message,
 *   stage:             { name, instruction, check, maxNudges },
 *   checkPassed:       true | false | null (null = no check defined / not run),
 *   nudges:            nudges already spent on this stage,
 *   consecutiveFailures: failed checks in a row on this stage,
 *   profile:           autonomy profile name,
 *   isLastStage:       boolean,
 * }
 *
 * Returns one of:
 *   { action: 'wait' }
 *   { action: 'approve', optionKey, optionIndex, selectedIdx, reason }
 *   { action: 'nudge', message, reason }
 *   { action: 'advance', reason }
 *   { action: 'complete', reason }
 *   { action: 'gate', kind, question, options, defaultOption, reason }
 *   { action: 'ask-llm', reason }
 */
function decide(ctx) {
  const {
    status, prompt, stopText, stage, checkPassed,
    nudges = 0, consecutiveFailures = 0, profile = DEFAULT_PROFILE, isLastStage = false,
    protectedBranch = false,
  } = ctx;

  if (status === 'process_exited') {
    return { action: 'gate', kind: 'agent-exited', reason: 'the agent process is gone', question: 'The agent exited. Relaunch and continue, or stop here?', options: ['Relaunch', 'Stop'], defaultOption: 'Relaunch' };
  }

  if (status === 'thinking') return { action: 'wait' };

  // A permission prompt is the cheapest thing to resolve — do it first.
  if (status === 'waiting_input' && prompt) {
    const verdict = classifyPrompt(prompt, profile, { protectedBranch });
    if (verdict.action === 'approve') return { ...verdict, action: 'approve' };
    return {
      action: 'gate',
      kind: 'permission',
      reason: verdict.reason,
      question: prompt.question || 'The agent is asking for permission.',
      options: (prompt.options || []).map(o => o.label),
      defaultOption: null,
      command: verdict.command || null,
    };
  }

  // Repeated failure means the plan is wrong, not the attempt. Stop guessing.
  const maxNudges = stage?.maxNudges ?? 5;
  if (consecutiveFailures >= 3) {
    return {
      action: 'gate',
      kind: 'stuck',
      reason: `stage check failed ${consecutiveFailures} times in a row`,
      question: `"${stage?.name || 'stage'}" has failed its check ${consecutiveFailures} times. How should it proceed?`,
      options: ['Retry once more', 'Skip this stage', 'Stop the run'],
      defaultOption: null,
    };
  }
  if (nudges >= maxNudges) {
    return {
      action: 'gate',
      kind: 'nudge-limit',
      reason: `spent ${nudges} nudges on this stage without passing its check`,
      question: `"${stage?.name || 'stage'}" has taken ${nudges} nudges and still isn't done. Take a look?`,
      options: ['Keep going', 'Skip this stage', 'Stop the run'],
      defaultOption: null,
    };
  }

  // The agent is idle. The stage check is ground truth about whether the work
  // actually landed — the agent's own claim is not.
  if (checkPassed === true) {
    return isLastStage
      ? { action: 'complete', reason: 'final stage check passed' }
      : { action: 'advance', reason: 'stage check passed' };
  }

  const stop = classifyStop(stopText);

  if (stop === 'question-decision') {
    return {
      action: 'gate',
      kind: 'decision',
      reason: 'the agent asked for a judgement call',
      question: lastQuestion(stopText),
      options: [],
      defaultOption: null,
    };
  }

  if (stop === 'blocked') {
    // One self-repair attempt before spending the human's attention: blocked
    // stalls are the longest ones, but most of them are ordinary failures.
    if (nudges === 0) {
      return {
        action: 'nudge',
        reason: 'agent reported a failure; asking it to diagnose once',
        message: 'You hit an error. Diagnose the root cause and fix it, then re-run the check. If it is genuinely blocked on something only I can decide, say exactly what you need and stop.',
      };
    }
    return { action: 'ask-llm', reason: 'still blocked after a self-repair attempt' };
  }

  if (stop === 'question-offer') {
    return {
      action: 'nudge',
      reason: 'agent offered a next step instead of taking it',
      message: offerNudge(stage),
    };
  }

  if (stop === 'reported-done' && checkPassed === false) {
    return {
      action: 'nudge',
      reason: 'agent reported done but the stage check still fails',
      message: `You reported this as done, but the stage check for "${stage?.name || 'this stage'}" still fails. Re-check your work against it and finish the gap: ${describeCheck(stage?.check)}`,
    };
  }

  if (checkPassed === null && stop === 'reported-done') {
    // Nothing objective to verify against — this is exactly the ambiguity the
    // LLM decider is for.
    return { action: 'ask-llm', reason: 'no stage check to verify a completion claim' };
  }

  if (stop === 'other') {
    if (nudges === 0) {
      return {
        action: 'nudge',
        reason: 'agent went idle mid-stage',
        message: stageNudge(stage),
      };
    }
    return { action: 'ask-llm', reason: 'agent idle again after a nudge' };
  }

  return { action: 'ask-llm', reason: 'no rule matched' };
}

function offerNudge(stage) {
  return [
    'Go ahead — take the step you just offered.',
    'Pick the option that advances the current stage. If two are reasonable, choose the reversible one, do it, and note the assumption in one line rather than stopping to ask.',
    stage?.instruction ? `Stage goal: ${stage.instruction}` : '',
    'Only stop if the choice is genuinely irreversible or outward-facing.',
  ].filter(Boolean).join(' ');
}

function stageNudge(stage) {
  return [
    `Continue with the current stage: ${stage?.name || 'in progress'}.`,
    stage?.instruction || '',
    stage?.check ? `Done when: ${describeCheck(stage.check)}` : '',
    'Work through it without checking in; report when the stage is actually done.',
  ].filter(Boolean).join(' ');
}

function describeCheck(check) {
  if (!check || !check.type) return 'the stage goal is met';
  switch (check.type) {
    case 'command': return `\`${check.command}\` exits 0`;
    case 'git-dirty': return 'there are uncommitted changes in the working tree';
    case 'git-clean': return 'the working tree is clean';
    case 'commits-ahead': return 'the branch has at least one commit that master does not';
    case 'branch-created': return 'the current branch is not master/main';
    case 'pushed': return 'the branch is pushed and up to date with its upstream';
    case 'pr-exists': return 'a pull request exists for this branch';
    default: return 'the stage goal is met';
  }
}

function lastQuestion(text) {
  const t = String(text || '').trim();
  if (!t) return 'The agent is waiting on you.';
  const sentences = t.split(/(?<=[.?!])\s+/);
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (sentences[i].includes('?')) return sentences[i].trim().slice(0, 400);
  }
  return t.slice(-400);
}

module.exports = {
  PROFILES,
  DEFAULT_PROFILE,
  profileFor,
  classifyCommand,
  classifyPrompt,
  classifyStop,
  extractCommand,
  describeCheck,
  lastQuestion,
  decide,
};
