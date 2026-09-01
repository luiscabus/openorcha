// Worktree isolation for parallel workers.
//
// Two agents in one working tree fight over the branch and the index, so each
// parallel worker gets its own `git worktree`. This mirrors how this work is
// already done by hand — a worktree per ticket, several of them live at once.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { shellEscape } = require('./multiplexer');

function sh(cmd, cwd, timeout = 20000) {
  return execSync(cmd, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryShell(cmd, cwd, timeout) {
  try {
    return { ok: true, out: sh(cmd, cwd, timeout) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}`.trim(), error: e.message };
  }
}

function isGitRepo(cwd) {
  return tryShell('git rev-parse --is-inside-work-tree', cwd, 5000).out === 'true';
}

/** The main working tree, even when `cwd` is itself a linked worktree. */
function mainRepoRoot(cwd) {
  const r = tryShell('git rev-parse --path-format=absolute --git-common-dir', cwd, 5000);
  if (!r.ok || !r.out) return null;
  const gitDir = r.out;
  return path.basename(gitDir) === '.git' ? path.dirname(gitDir) : gitDir;
}

function slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'work';
}

function defaultWorktreeRoot(repoRoot) {
  return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-worktrees`);
}

/**
 * Create (or reuse) an isolated worktree for one worker.
 * Returns { path, branch, created } or null when isolation isn't possible —
 * the caller falls back to the shared directory and records why.
 */
function ensureWorktree(cwd, { name, branchPrefix, worktreeRoot, baseRef }) {
  if (!isGitRepo(cwd)) return null;
  const repoRoot = mainRepoRoot(cwd);
  if (!repoRoot) return null;

  const branch = `${branchPrefix || 'openorcha'}/${slug(name)}`;
  const root = worktreeRoot || defaultWorktreeRoot(repoRoot);
  const target = path.join(root, slug(`${path.basename(repoRoot)}-${name}`));

  // Already there from an earlier run — reuse it rather than fail.
  if (fs.existsSync(target)) {
    const existing = tryShell('git rev-parse --abbrev-ref HEAD', target, 5000);
    if (existing.ok) return { path: target, branch: existing.out, created: false };
    return null;
  }

  fs.mkdirSync(root, { recursive: true });

  const base = baseRef || 'HEAD';
  const branchExists = tryShell(`git rev-parse --verify --quiet ${shellEscape(branch)}`, repoRoot, 5000).ok;
  const cmd = branchExists
    ? `git worktree add ${shellEscape(target)} ${shellEscape(branch)}`
    : `git worktree add -b ${shellEscape(branch)} ${shellEscape(target)} ${shellEscape(base)}`;

  const result = tryShell(cmd, repoRoot, 60000);
  if (!result.ok) return null;
  return { path: target, branch, created: true };
}

/**
 * Remove a worktree once its worker is finished. The branch is left alone.
 *
 * Success is judged by what the repository looks like afterwards, not by the
 * exit code: `git worktree remove` can detach the tree and still complain, and
 * reporting a removal that happened as a failure sends you to look at a
 * directory that is no longer there.
 */
function removeWorktree(cwd, worktreePath) {
  const repoRoot = mainRepoRoot(cwd);
  if (!repoRoot || !worktreePath) return false;

  const known = listWorktrees(repoRoot).some(w => w.path === worktreePath);
  if (!known && !fs.existsSync(worktreePath)) return false; // nothing to remove

  tryShell(`git worktree remove ${shellEscape(worktreePath)} --force`, repoRoot, 30000);
  tryShell('git worktree prune', repoRoot, 10000);

  const stillRegistered = listWorktrees(repoRoot).some(w => w.path === worktreePath);
  return !stillRegistered && !fs.existsSync(worktreePath);
}

/** Branches produced by an initiative's workers, for the integration stage. */
function listWorktrees(cwd) {
  const repoRoot = mainRepoRoot(cwd);
  if (!repoRoot) return [];
  const r = tryShell('git worktree list --porcelain', repoRoot, 10000);
  if (!r.ok) return [];
  const out = [];
  let current = {};
  for (const line of r.out.split('\n')) {
    if (line.startsWith('worktree ')) current = { path: line.slice(9) };
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '');
    else if (!line.trim() && current.path) { out.push(current); current = {}; }
  }
  if (current.path) out.push(current);
  return out;
}

module.exports = { isGitRepo, mainRepoRoot, ensureWorktree, removeWorktree, listWorktrees, slug, defaultWorktreeRoot };
