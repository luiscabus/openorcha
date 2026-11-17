// What a run has actually produced.
//
// The event log says what the supervisor did — nudged, approved, gated. That is
// not the same as what came out of the run, which is what you actually want to
// see when you open an initiative: the commits, the files, the branches, the
// pull request, the deliverables the definition of done asked for, and what
// each agent last said for itself.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { shellEscape } = require('./multiplexer');
const { runCheck, defaultBaseBranch, currentBranch } = require('./initiativeChecks');

function sh(cmd, cwd, timeout = 10000) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

/**
 * Commits this run added, and the files it touched, in one working tree.
 *
 * Scoped to the run: from the recorded baseline where there is one, and from
 * the default branch only for a worktree, whose branch the run created. Diffing
 * against master in a checkout that already sat on someone else's feature
 * branch reports their work as this run's.
 */
function repoWork(cwd, baselineSha, baselineBranch) {
  const branch = currentBranch(cwd);
  if (!branch) return null;
  const base = baselineSha && sh(`git cat-file -e ${shellEscape(baselineSha)}^{commit} && echo ok`, cwd)
    ? baselineSha
    : defaultBaseBranch(cwd);

  const log = sh(`git log --no-merges --pretty=format:%h%x1f%s%x1f%ar ${shellEscape(base)}..HEAD`, cwd);
  const commits = log
    ? log.split('\n').filter(Boolean).map(line => {
      const [sha, subject, when] = line.split('\x1f');
      return { sha, subject, when };
    })
    : [];

  const committed = sh(`git diff --numstat ${shellEscape(base)}..HEAD`, cwd)
    .split('\n').filter(Boolean)
    .map(l => {
      const [added, removed, file] = l.split(/\t/);
      return { file, added: parseInt(added, 10) || 0, removed: parseInt(removed, 10) || 0 };
    });

  const uncommitted = sh('git status --porcelain', cwd)
    .split('\n').filter(Boolean)
    .map(l => ({ state: l.slice(0, 2).trim(), file: l.slice(3) }));

  // `gh pr view` answers for whatever branch is checked out, which is not the
  // same as a PR this run produced. Only claim it when the run made the branch
  // or the commits on it.
  let pr = null;
  const ownsBranch = !baselineBranch || branch !== baselineBranch;
  if (ownsBranch || commits.length) {
    const prJson = sh('gh pr view --json number,url,isDraft,title,state', cwd, 20000);
    if (prJson) {
      try { pr = JSON.parse(prJson); } catch {}
    }
  }

  return { branch, base, scopedTo: base === baselineSha ? 'run baseline' : `branch ${base}`, commits, committed, uncommitted, pr };
}

/** The deliverables the definition of done names, and whether they exist yet. */
function deliverables(initiative) {
  const out = [];
  const seen = new Set();
  for (const criterion of initiative.acceptance || []) {
    const p = criterion.check?.path;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    const full = path.resolve(initiative.cwd, p);
    const exists = fs.existsSync(full);
    out.push({
      path: p,
      exists,
      bytes: exists ? fs.statSync(full).size : 0,
      result: runCheck(criterion.check, initiative.cwd),
    });
  }
  return out;
}

/**
 * Build the summary. `readWorker` is injected so this file stays free of
 * process inspection: the caller supplies how to read a worker's messages.
 */
function build(initiative, readWorker) {
  const workers = (initiative.workers || []).map(worker => {
    const messages = readWorker ? readWorker(worker) : [];
    const said = [...messages].reverse().find(m => m.role === 'assistant' && (m.text || '').trim());
    const toolCount = messages.reduce((n, m) => n + (Array.isArray(m.tools) ? m.tools.length : 0), 0);
    return {
      workerId: worker.id,
      name: worker.name,
      role: worker.role || 'worker',
      status: worker.status,
      branch: worker.worktree?.branch || null,
      cwd: worker.cwd || initiative.cwd,
      turns: messages.length,
      toolCalls: toolCount,
      hasTranscript: messages.length > 0,
      lastSaid: said ? String(said.text).slice(0, 600) : null,
      lastAt: said?.timestamp || null,
    };
  });

  // The main tree, plus any worktree a worker produced work in.
  const trees = [{ label: 'main', cwd: initiative.cwd }];
  for (const worker of initiative.workers || []) {
    if (worker.worktree?.path && fs.existsSync(worker.worktree.path)) {
      trees.push({ label: worker.name, cwd: worker.worktree.path });
    }
  }

  const repos = trees
    // The baseline applies to the main tree; a worktree's own branch is new,
    // so its whole history is this run's work.
    .map(t => ({ ...t, work: repoWork(
      t.cwd,
      t.label === 'main' ? initiative.baseline?.sha : null,
      t.label === 'main' ? initiative.baseline?.branch : null,
    ) }))
    .filter(t => t.work);

  const totals = repos.reduce((acc, t) => ({
    commits: acc.commits + t.work.commits.length,
    files: acc.files + t.work.committed.length,
    uncommitted: acc.uncommitted + t.work.uncommitted.length,
  }), { commits: 0, files: 0, uncommitted: 0 });

  return {
    totals,
    repos,
    workers,
    deliverables: deliverables(initiative),
    prs: repos.map(r => r.work.pr).filter(Boolean),
    stagesDone: (initiative.stages || []).filter(s => s.status === 'done').map(s => s.name),
    criteriaMet: (initiative.acceptance || []).filter(c => c.status === 'met' || c.status === 'waived').length,
    criteriaTotal: (initiative.acceptance || []).length,
  };
}

module.exports = { build, repoWork, deliverables };
