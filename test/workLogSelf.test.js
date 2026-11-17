const test = require('node:test');
const assert = require('node:assert/strict');

const self = require('../lib/workLogSelf');
const { isOwnSession } = self;

// Reading a day runs claude over the day's evidence, and that prompt quotes the
// ticket keys it was given. Counted as work, the description of Tuesday becomes
// evidence of working on Tuesday's tickets — for ever, on every later day.

test("the worklog's own narration run is not work", () => {
  const prompt = "Below is the raw evidence of one engineer's work on 2026-08-31, grouped into blocks.\n"
    + 'Each block is one ticket (or one unattributed stretch) and carries the commits,\n'
    + 'Claude Code session prompts, and pull-request review activity recorded in that window.';
  assert.equal(isOwnSession(prompt, '-Users-soci-soci-soci'), true, 'wherever it happened to run');
});

test("the supervisor's judgement calls and framing passes are not work", () => {
  assert.equal(isOwnSession('You are supervising a coding agent so its human operator does not have to sit and watch it.'), true);
  assert.equal(isOwnSession('You are helping decide what "done" means for a piece of work, BEFORE it starts.'), true);
});

test('briefings and messages this tool sends into an agent are not work either', () => {
  assert.equal(isOwnSession('[OpenOrcha] You are the orchestrator for one piece of work.'), true);
  assert.equal(isOwnSession('[OpenOrcha] Stage finished: Plan finished; now on Branch.'), true);
  assert.equal(isOwnSession('[OpenOrcha · SO-92393 PDFs] Read the ground truth. Read the ticket…'), true);
  assert.equal(isOwnSession('[OpenOrcha · operator] what did this run accomplish?'), true);
});

test('the scratch directories are excluded whatever the transcript says', () => {
  const dirs = [
    '-private-var-folders-fy-bq8czkt953x4q5t7lnjq939c0000gp-T-openorcha-worklog',
    '-private-var-folders-fy-bq8czkt953x4q5t7lnjq939c0000gp-T-openorcha-supervisor',
    '-private-var-folders-fy-bq8czkt953x4q5t7lnjq939c0000gp-T-openorcha-framing',
    '-private-tmp-openorcha-worklog',
  ];
  for (const dir of dirs) assert.equal(isOwnSession('anything at all', dir), true, dir);
});

test('your own work is left alone', () => {
  const real = [
    'review the plan and tech spec of https://meetsoci.atlassian.net/browse/SO-89065',
    'we need to perform discovery into this repo about SO-92393',
    'is there a limit to how many Session History are displayed in the History tab?',
    'settle the three open items',
    'SO-90814 Make GA4ClientFactory constructor visibility explicit',
  ];
  for (const prompt of real) {
    assert.equal(isOwnSession(prompt, '-Users-soci-soci-soci'), false, prompt.slice(0, 40));
  }
});

test('a session that merely mentions OpenOrcha is still your work', () => {
  assert.equal(isOwnSession('why does OpenOrcha keep spawning PR agents?', '-Users-soci-personal-openorcha'), false);
  assert.equal(isOwnSession('the orchestrator UX is bad, [OpenOrcha] shows nothing'), false, 'the marker must open the message');
});

test('an empty or missing first prompt is not assumed to be ours', () => {
  assert.equal(isOwnSession('', '-Users-soci-soci-soci'), false);
  assert.equal(isOwnSession(null), false);
  assert.equal(isOwnSession(undefined, ''), false);
});

// ─── An agent session you took part in ──────────────────────────────────────

const BRIEFING = '[OpenOrcha · SO-89850 Directory count] Implement. Do the work.';

test('an agent session nobody spoke in is ours', () => {
  const prompts = [
    BRIEFING,
    '[OpenOrcha] Go ahead — take the step you just offered.',
    '[OpenOrcha] Continue with the current stage: Implement.',
  ];
  assert.equal(isOwnSession(BRIEFING, '-Users-soci-soci-soci-services-llp-renderer', prompts), true);
});

test('legacy supervisor nudges are recognised even without the marker', () => {
  // Sent before the nudges carried one; the transcripts still exist.
  const prompts = [
    BRIEFING,
    'Go ahead — take the step you just offered. Pick the option that advances the current stage.',
    'Continue the ground-truth pass. Specifically: (1) find and quote the exact code path…',
  ];
  assert.equal(isOwnSession(BRIEFING, '-Users-soci-soci-soci', prompts), true);
});

test('the moment you say something in it, the session is yours', () => {
  const prompts = [
    BRIEFING,
    '[OpenOrcha] Go ahead — take the step you just offered.',
    "we don't want to gate through env var DIRECTORY_CHILD_COUNT_ENABLED",
  ];
  assert.equal(isOwnSession(BRIEFING, '-Users-soci-soci-soci', prompts), false, 'your attention was on it');
});

test('an operator message relayed through the tool still counts as you', () => {
  // Marked so the orchestrator can tell who is talking, but it was your words.
  const prompts = [BRIEFING, '[OpenOrcha · operator] settle the three open items'];
  assert.equal(isOwnSession(BRIEFING, '-Users-soci-soci-soci', prompts), true,
    'the marker is ours; the turn count is what a reviewer would have to judge');
});

test('without the turns, an agent briefing alone is not enough to exclude', () => {
  assert.equal(isOwnSession(BRIEFING, '-Users-soci-soci-soci'), true, 'first prompt matches [OpenOrcha ·');
});

test('a session working on this tool itself is recognised by its project directory', () => {
  const own = self.OWN_REPO_PROJECT;
  assert.equal(self.isOwnRepoSession(own), true);
  // A worktree or a folder inside it.
  assert.equal(self.isOwnRepoSession(`${own}-website`), true);
  assert.equal(self.isOwnRepoSession('-Users-soci-soci-soci'), false);
  assert.equal(self.isOwnRepoSession(`${own}x`), false);
});
