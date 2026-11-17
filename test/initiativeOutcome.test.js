const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const outcome = require('../lib/initiativeOutcome');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-outcome-test-'));
process.env.OPENORCHA_INITIATIVES_DIR = dir;
process.env.OPENORCHA_NO_LAUNCH = '1';
const store = require('../lib/initiativeStore');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function repoWith(featureCommits = []) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-outcome-repo-'));
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: repo });
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  execSync('git add -A && git commit -qm base', { cwd: repo });
  // Someone else's feature branch, already ahead of main — the situation that
  // made a run report 58 commits and 321 files it had nothing to do with.
  if (featureCommits.length) {
    execSync('git checkout -q -b mustangs/SO-1/theirs', { cwd: repo });
    for (const subject of featureCommits) {
      fs.appendFileSync(path.join(repo, 'base.txt'), `${subject}\n`);
      execSync(`git add -A && git commit -qm ${JSON.stringify(subject)}`, { cwd: repo });
    }
  }
  return { repo };
}

test('work is scoped to the run, not to whatever branch was checked out', () => {
  const { repo } = repoWith(['someone else did this', 'and this']);
  try {
    // With no baseline it falls back to the default branch, and someone else's
    // feature work counts as this run's.
    const unscoped = outcome.repoWork(repo, null);
    assert.equal(unscoped.commits.length, 2);
    assert.match(unscoped.scopedTo, /^branch /);

    // A baseline taken when the run began scopes it honestly.
    const head = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
    const scoped = outcome.repoWork(repo, head);
    assert.equal(scoped.commits.length, 0, "work that predates the run is not the run's");
    assert.equal(scoped.scopedTo, 'run baseline');

    // And what happens after the baseline is.
    fs.appendFileSync(path.join(repo, 'base.txt'), 'the run did this\n');
    execSync('git add -A && git commit -qm "the run did this"', { cwd: repo });
    const after = outcome.repoWork(repo, head);
    assert.equal(after.commits.length, 1);
    assert.equal(after.commits[0].subject, 'the run did this');
    assert.equal(after.committed[0].file, 'base.txt');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a pull request is only claimed when the run made the branch or the commits', () => {
  const { repo } = repoWith(['theirs']);
  try {
    const head = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repo, encoding: 'utf8' }).trim();

    // Same branch the run started on, and no commits from the run: whatever PR
    // that branch has belongs to whoever made it.
    const notOurs = outcome.repoWork(repo, head, branch);
    assert.equal(notOurs.pr, null);

    // A branch the run created is the run's, so its PR is fair to report.
    const ours = outcome.repoWork(repo, head, 'some/other-branch');
    assert.equal(ours.pr, null, 'no gh PR exists for a local temp repo, but the lookup was allowed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('uncommitted work is reported separately from commits', () => {
  const { repo } = repoWith();
  try {
    const head = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(repo, 'scratch.md'), 'wip\n');
    const work = outcome.repoWork(repo, head);
    assert.equal(work.commits.length, 0);
    assert.equal(work.uncommitted.length, 1);
    assert.equal(work.uncommitted[0].file, 'scratch.md');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('deliverables come from the definition of done and say whether they exist', () => {
  const initiative = store.create({ name: 'Deliverables', cwd: dir, notifyOnGate: false });
  store.setAcceptance(initiative, [
    { text: 'the review', check: { type: 'file-contains', path: 'review.md', patterns: ['Risks'] } },
    { text: 'the breakdown', check: { type: 'file-exists', path: 'breakdown.md' } },
    { text: 'your judgement', check: { type: 'human' } },
  ]);
  fs.writeFileSync(path.join(dir, 'review.md'), '# Review\n\nRisks: none\n');

  const list = outcome.deliverables(initiative);
  assert.equal(list.length, 2, 'a human criterion names no file');
  const review = list.find(d => d.path === 'review.md');
  assert.equal(review.exists, true);
  assert.equal(review.result.passed, true);
  const breakdown = list.find(d => d.path === 'breakdown.md');
  assert.equal(breakdown.exists, false);
  assert.match(breakdown.result.detail, /does not exist/);
});

test('the summary counts turns and tool calls per worker, and keeps its last words', () => {
  const initiative = store.create({ name: 'Summary', cwd: dir, notifyOnGate: false });
  initiative.workers = [
    store.normalizeWorker({ id: 'w1', name: 'Read', sessionName: 's1', status: 'done' }, 0),
    store.normalizeWorker({ id: 'o1', name: 'Orchestrator', role: 'orchestrator', sessionName: 's2', status: 'working' }, 1),
  ];
  store.save(initiative);

  const built = outcome.build(initiative, worker => (worker.id === 'w1'
    ? [
      { role: 'assistant', text: '', tools: [{ name: 'Bash' }, { name: 'Read' }], timestamp: '2026-09-02T10:00:00Z' },
      { role: 'assistant', text: 'Ground truth done for all three.', tools: [], timestamp: '2026-09-02T10:05:00Z' },
    ]
    : []));

  const read = built.workers.find(w => w.workerId === 'w1');
  assert.equal(read.turns, 2);
  assert.equal(read.toolCalls, 2);
  assert.equal(read.hasTranscript, true);
  assert.match(read.lastSaid, /Ground truth done/);

  const boss = built.workers.find(w => w.role === 'orchestrator');
  assert.equal(boss.hasTranscript, false, 'and an agent with no transcript says so');
});

test('a worker remembers its transcript so a finished run stays readable', () => {
  const initiative = store.create({ name: 'Readable later', cwd: dir, notifyOnGate: false });
  initiative.workers = [store.normalizeWorker({
    id: 'w', name: 'Read', sessionName: 'gone', status: 'gone', sessionFile: '/tmp/some/transcript.jsonl',
  }, 0)];
  const saved = store.save(initiative);
  assert.equal(saved.workers[0].sessionFile, '/tmp/some/transcript.jsonl');
});
