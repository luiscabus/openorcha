const test = require('node:test');
const assert = require('node:assert/strict');

const jira = require('../lib/jiraWorklog');

test('a comment becomes Atlassian Document Format, which the v3 API requires', () => {
  assert.deepEqual(jira.toAdf('Code review.'), {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Code review.' }] }],
  });
});

test('an empty comment is omitted rather than sent as an empty document', () => {
  assert.equal(jira.toAdf(''), undefined);
  assert.equal(jira.toAdf('   '), undefined);
});

test('a comment survives the round trip', () => {
  const text = 'Rebase, continue working';
  assert.equal(jira.fromAdf(jira.toAdf(text)), text);
});

test('reading a document Jira wrote does not throw on unexpected nodes', () => {
  assert.equal(jira.fromAdf(null), '');
  assert.equal(jira.fromAdf({ content: [{ type: 'rule' }] }), '');
  assert.equal(jira.fromAdf('already a string'), 'already a string');
});

test('an unconfigured Jira fails loudly and says what is missing', () => {
  const saved = { ...process.env };
  delete process.env.JIRA_BASE_URL;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_API_TOKEN;

  assert.throws(() => jira.requireConfigured(), /Missing: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN/);

  process.env = saved;
});

// ─── What a ticket is about ──────────────────────────────────────────────────

test('a description is trimmed to its opening, at a sentence where it can', () => {
  const long = '## Summary / JTBD\n\nWhen a Local Pages client publishes a downloadable PDF, they want it to '
    + 'open on their own domain. There is a second problem in the self-serve path, where the platform renames the file.';
  const trimmed = jira.firstSentences(long, 160);

  assert.ok(trimmed.length <= 161, `got ${trimmed.length} chars`);
  assert.ok(!trimmed.includes('#'), 'headings add nothing to a one-line subject');
  assert.match(trimmed, /^Summary \/ JTBD When a Local Pages client/);
  assert.ok(trimmed.endsWith('…'), 'and says it was cut');
});

test('a short description is left exactly as it is', () => {
  assert.equal(jira.firstSentences('Remove the flag after rollout.', 160), 'Remove the flag after rollout.');
});

test('nothing in, nothing out', () => {
  assert.equal(jira.firstSentences('', 160), '');
  assert.equal(jira.firstSentences(null, 160), '');
  assert.equal(jira.firstSentences(undefined, 160), '');
});

test('only worklogs inside the window are kept, though Jira returns a ticket whole', () => {
  const logs = [
    { worklogId: '1', ticket: 'SO-1', startedDate: '2026-10-26' },
    { worklogId: '2', ticket: 'SO-1', startedDate: '2026-10-27' },
    { worklogId: '3', ticket: 'SO-1', startedDate: '2026-10-28' },
    { worklogId: '4', ticket: 'SO-1', startedDate: '2026-10-29' },
  ];
  assert.deepEqual(jira.withinDays(logs, '2026-10-28', '2026-10-28').map(w => w.worklogId), ['3']);
  assert.deepEqual(jira.withinDays(logs, '2026-10-27', '2026-10-28').map(w => w.worklogId), ['2', '3']);
});
