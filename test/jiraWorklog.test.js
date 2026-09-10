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
