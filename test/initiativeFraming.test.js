const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const framing = require('../lib/initiativeFraming');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-framing-test-'));
process.env.OPENORCHA_INITIATIVES_DIR = dir;
// Never start a real agent from a test run.
process.env.OPENORCHA_NO_LAUNCH = '1';
const store = require('../lib/initiativeStore');
const { runCheck } = require('../lib/initiativeChecks');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// ─── The proposal ────────────────────────────────────────────────────────────

test('the prompt carries the goal, the kind of work and the real project', () => {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo project\n');
  const prompt = framing.buildPrompt({ goal: 'Autosave drafts', cwd: dir, template: 'ticket-to-pr' });

  assert.match(prompt, /Autosave drafts/);
  assert.match(prompt, /Ticket → PR/);
  assert.match(prompt, /jest/, 'the project scripts should be in the context');
  assert.match(prompt, /Demo project/);
});

test('unusable proposals are rejected rather than half-applied', () => {
  assert.equal(framing.sanitizeProposal(null), null);
  assert.equal(framing.sanitizeProposal({ criteria: [] }), null);
  assert.equal(framing.sanitizeProposal({ criteria: [{ text: '   ' }] }), null);
});

test('an unknown check type degrades to "your call" instead of being trusted', () => {
  const p = framing.sanitizeProposal({ criteria: [{ text: 'ship it', check: { type: 'rm -rf /' } }] });
  assert.equal(p.criteria[0].check.type, 'human');
});

test('"everything is committed" is git-clean, not its inverse', () => {
  const p = framing.sanitizeProposal({
    criteria: [
      { text: 'All changes are committed, no uncommitted work remains', check: { type: 'git-dirty' } },
      { text: 'Work has started and files are modified', check: { type: 'git-dirty' } },
    ],
  });
  assert.equal(p.criteria[0].check.type, 'git-clean', 'an inverted check would strand the run at the finish line');
  assert.equal(p.criteria[1].check.type, 'git-dirty');
});

test('a suggested template that does not exist is dropped', () => {
  const p = framing.sanitizeProposal({ criteria: [{ text: 'x', check: { type: 'human' } }], suggestedTemplate: 'invented' });
  assert.equal(p.suggestedTemplate, null);
});

// ─── Criteria as the finish line ─────────────────────────────────────────────

test('document work becomes checkable: the file has to exist and say the thing', () => {
  const docs = path.join(dir, 'docs');
  fs.mkdirSync(docs, { recursive: true });

  const check = { type: 'file-contains', path: 'docs/breakdown.md', patterns: ['Phase', 'Depends on'] };
  assert.equal(runCheck(check, dir).passed, false, 'nothing written yet');

  fs.writeFileSync(path.join(docs, 'breakdown.md'), '# Breakdown\n\n## Phase 1\nDepends on: SO-1\n');
  assert.equal(runCheck(check, dir).passed, true);

  fs.writeFileSync(path.join(docs, 'breakdown.md'), '# Breakdown\n\nsome prose\n');
  const partial = runCheck(check, dir);
  assert.equal(partial.passed, false);
  assert.match(partial.detail, /missing: Phase, Depends on/);
});

test('a criterion that needs a person says so rather than pretending', () => {
  const result = runCheck({ type: 'human', detail: 'the breakdown reads right to you' }, dir);
  assert.equal(result.passed, null);
  assert.match(result.detail, /reads right to you/);
});

test('the supervisor settles what it can and leaves the rest to you', () => {
  const supervisor = require('../lib/initiativeSupervisor');
  fs.writeFileSync(path.join(dir, 'findings.md'), 'Risks and Open questions covered.\n');

  const initiative = store.create({ name: 'DoD run', cwd: dir, notifyOnGate: false });
  store.setAcceptance(initiative, [
    { text: 'findings written', check: { type: 'file-exists', path: 'findings.md' } },
    { text: 'covers the risks', check: { type: 'file-contains', path: 'findings.md', patterns: ['Risks', 'Open questions'] } },
    { text: 'plan is missing', check: { type: 'file-exists', path: 'plan.md' } },
    { text: 'reads right to you', check: { type: 'human' } },
  ]);
  store.save(initiative);

  const { met, unmet, human } = supervisor.evaluateAcceptance(initiative);
  assert.equal(met.length, 2);
  assert.equal(unmet.length, 1);
  assert.equal(unmet[0].text, 'plan is missing');
  assert.equal(human.length, 1);

  // evaluateAcceptance records the verdict; persisting is the caller's job,
  // which is what both the supervisor and the route do.
  assert.equal(initiative.acceptance[0].status, 'met');
  store.save(initiative);
  assert.equal(store.get(initiative.id).acceptance[0].status, 'met');
});

test('criteria can be waived, and a waived one stops holding the run', () => {
  const initiative = store.create({ name: 'Waiver', cwd: dir, notifyOnGate: false });
  store.setAcceptance(initiative, [{ text: 'unreachable', check: { type: 'file-exists', path: 'nope.md' } }]);
  store.save(initiative);

  const supervisor = require('../lib/initiativeSupervisor');
  assert.equal(supervisor.evaluateAcceptance(initiative).unmet.length, 1);

  store.setCriterionStatus(initiative, initiative.acceptance[0].id, 'waived', 'not needed after all');
  assert.equal(supervisor.evaluateAcceptance(initiative).unmet.length, 0);
});
