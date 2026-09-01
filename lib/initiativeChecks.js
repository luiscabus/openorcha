// Ground truth for stage completion.
//
// The supervisor never takes an agent's word for "done" — it runs the stage's
// check itself. "reported done" was one of the biggest sources of dead waiting
// in real sessions, and half of those claims are worth verifying cheaply.

const { execSync } = require('child_process');
const { shellEscape } = require('./multiplexer');

function sh(cmd, cwd, timeout = 15000) {
  return execSync(cmd, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryShell(cmd, cwd, timeout) {
  try {
    return { ok: true, out: sh(cmd, cwd, timeout) };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || ''), error: e.message };
  }
}

function currentBranch(cwd) {
  const r = tryShell('git rev-parse --abbrev-ref HEAD', cwd, 5000);
  return r.ok ? r.out : null;
}

function defaultBaseBranch(cwd) {
  const r = tryShell('git symbolic-ref --quiet --short refs/remotes/origin/HEAD', cwd, 5000);
  if (r.ok && r.out) return r.out.replace(/^origin\//, '');
  for (const candidate of ['master', 'main']) {
    if (tryShell(`git rev-parse --verify --quiet ${candidate}`, cwd, 5000).ok) return candidate;
  }
  return 'master';
}

/**
 * Run a stage check. Returns { passed: boolean|null, detail: string }.
 * `null` means the check could not be evaluated — the supervisor treats that
 * as "unknown" and falls through to its softer rules rather than guessing.
 */
function runCheck(check, cwd) {
  if (!check || !check.type) return { passed: null, detail: 'no check defined' };
  if (!cwd) return { passed: null, detail: 'no working directory' };

  switch (check.type) {
    case 'command': {
      if (!check.command) return { passed: null, detail: 'no command configured' };
      const r = tryShell(check.command, cwd, check.timeout || 300000);
      return {
        passed: r.ok,
        detail: r.ok
          ? `\`${check.command}\` exited 0`
          : `\`${check.command}\` failed: ${String(r.out || r.error).split('\n').slice(-6).join('\n').slice(0, 800)}`,
      };
    }

    case 'git-dirty': {
      const r = tryShell('git status --porcelain', cwd, 8000);
      if (!r.ok) return { passed: null, detail: 'not a git repository' };
      const files = r.out.split('\n').filter(Boolean);
      return { passed: files.length > 0, detail: files.length ? `${files.length} changed file(s)` : 'working tree is clean' };
    }

    case 'git-clean': {
      const r = tryShell('git status --porcelain', cwd, 8000);
      if (!r.ok) return { passed: null, detail: 'not a git repository' };
      const files = r.out.split('\n').filter(Boolean);
      return { passed: files.length === 0, detail: files.length ? `${files.length} uncommitted file(s)` : 'working tree is clean' };
    }

    case 'branch-created': {
      const branch = currentBranch(cwd);
      if (!branch) return { passed: null, detail: 'not a git repository' };
      const onBase = ['master', 'main', 'HEAD'].includes(branch);
      return { passed: !onBase, detail: onBase ? `still on ${branch}` : `on ${branch}` };
    }

    case 'commits-ahead': {
      const base = check.base || defaultBaseBranch(cwd);
      const branch = currentBranch(cwd);
      if (!branch) return { passed: null, detail: 'not a git repository' };
      const r = tryShell(`git rev-list --count ${shellEscape(base)}..HEAD`, cwd, 8000);
      if (!r.ok) return { passed: null, detail: `cannot compare against ${base}` };
      const n = parseInt(r.out, 10) || 0;
      return { passed: n > 0, detail: `${n} commit(s) ahead of ${base}` };
    }

    case 'pushed': {
      const upstream = tryShell('git rev-parse --abbrev-ref --symbolic-full-name @{u}', cwd, 8000);
      if (!upstream.ok) return { passed: false, detail: 'branch has no upstream yet' };
      const r = tryShell('git rev-list --count @{u}..HEAD', cwd, 8000);
      if (!r.ok) return { passed: null, detail: 'cannot compare with upstream' };
      const n = parseInt(r.out, 10) || 0;
      return { passed: n === 0, detail: n === 0 ? `in sync with ${upstream.out}` : `${n} unpushed commit(s)` };
    }

    case 'pr-exists': {
      const r = tryShell('gh pr view --json number,isDraft,url', cwd, 20000);
      if (!r.ok) return { passed: false, detail: 'no pull request for this branch yet' };
      try {
        const pr = JSON.parse(r.out);
        return { passed: true, detail: `PR #${pr.number}${pr.isDraft ? ' (draft)' : ''} ${pr.url}`, url: pr.url };
      } catch {
        return { passed: false, detail: 'could not read pull request state' };
      }
    }

    default:
      return { passed: null, detail: `unknown check type: ${check.type}` };
  }
}

/** Small git summary used by the digest and the UI. */
function repoSnapshot(cwd) {
  if (!cwd) return null;
  const branch = currentBranch(cwd);
  if (!branch) return null;
  const dirty = tryShell('git status --porcelain', cwd, 8000);
  const base = defaultBaseBranch(cwd);
  const ahead = tryShell(`git rev-list --count ${shellEscape(base)}..HEAD`, cwd, 8000);
  const lastCommit = tryShell('git log -1 --pretty=%s', cwd, 5000);
  return {
    branch,
    base,
    changedFiles: dirty.ok ? dirty.out.split('\n').filter(Boolean).length : 0,
    commitsAhead: ahead.ok ? parseInt(ahead.out, 10) || 0 : 0,
    lastCommit: lastCommit.ok ? lastCommit.out : null,
  };
}

module.exports = { runCheck, repoSnapshot, currentBranch, defaultBaseBranch };
