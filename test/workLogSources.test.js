const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sources = require('../lib/workLogSources');

// Exercise the shipped default rather than a pattern invented for the test.
const cfg = {};

test('a ticket is recognised in a commit subject or a branch name', () => {
  assert.equal(sources.ticketFrom('SO-90816 Enqueue the backfill', cfg), 'SO-90816');
  assert.equal(sources.ticketFrom('mustangs/SO-88134/fix-preview-route', cfg), 'SO-88134');
  assert.equal(sources.ticketFrom('checkout: moving from master to mustangs/SO-1/x', cfg), 'SO-1');
});

test('prose with no ticket yields nothing rather than a false match', () => {
  assert.equal(sources.ticketFrom('fix the thing', cfg), null);
  assert.equal(sources.ticketFrom('', cfg), null);
  assert.equal(sources.ticketFrom('covid-19 dashboard', cfg), null);
});

test('a uuid never passes for a ticket', () => {
  // This is not hypothetical: a session id in a transcript produced "C295F-8"
  // and put an hour against a ticket that does not exist.
  assert.equal(sources.ticketFrom('399C295F-8BC3-4188-ABD9-AEB8C7783E38', cfg), null);
  assert.equal(sources.ticketFrom('artifact/566e3d3c-35c9-4e69-bec3-afdf0b08c681', cfg), null);
  assert.equal(sources.ticketFrom('see ABCD-1234-EFAB-5678', cfg), null);
});

test('a real ticket is still found next to punctuation', () => {
  assert.equal(sources.ticketFrom('Fixes SO-52569.', cfg), 'SO-52569');
  assert.equal(sources.ticketFrom('(SO-1)', cfg), 'SO-1');
  assert.equal(sources.ticketFrom('https://meetsoci.atlassian.net/browse/SO-92393', cfg), 'SO-92393');
});

test('a project key allowlist rejects keys from other projects', () => {
  const scoped = { projectKeys: ['SO'] };
  assert.equal(sources.ticketFrom('ABC-123 something', scoped), null);
  assert.equal(sources.ticketFrom('SO-123 something', scoped), 'SO-123');
});

test('every source declares whether it can run and why not', () => {
  for (const source of sources.describe()) {
    assert.ok(source.id && source.label, 'a source needs an id and a label');
    assert.equal(typeof source.available, 'boolean');
    if (!source.available) {
      assert.ok(source.reason && source.reason.length > 10, `${source.id} must explain why it is unavailable`);
    }
  }
});

test('a transcript yields its timestamps and what the operator actually said', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', timestamp: '2026-08-13T17:00:00Z', message: { content: 'code review PR 36272 for SO-93678' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-13T17:01:00Z', message: { content: 'ok' } }),
    JSON.stringify({ type: 'user', timestamp: '2026-08-13T17:05:00Z', message: { content: '<tool result noise>' } }),
    'not json at all',
  ].join('\n'));

  const parsed = sources.readTranscript(file);
  assert.equal(parsed.stamps.length, 3);
  assert.match(parsed.firstPrompt, /code review PR 36272/);
  // Harness noise is not something the operator said.
  assert.doesNotMatch(parsed.text, /tool result noise/);
  assert.equal(sources.ticketFrom(parsed.text, cfg), 'SO-93678');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('text Claude Code inserted, like a loaded skill, is not something you said', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', timestamp: '2026-10-30T20:45:00Z', message: { content: 'regarding work on GA4, the customer facing flag' } }),
    JSON.stringify({ type: 'user', isMeta: true, timestamp: '2026-11-01T21:26:16Z', message: { content: [{ type: 'text', text: 'Base directory for this skill: ~/.claude/skills/jira-adf\n\nIt happened on 2026-09-02 (SO-96611).' }] } }),
  ].join('\n'));

  const parsed = sources.readTranscript(file);
  assert.equal(parsed.prompts.length, 1);
  assert.equal(sources.ticketFrom(parsed.text, cfg), null);

  // A subagent reporting back is about this session's work, so it counts.
  fs.appendFileSync(file, '\n' + JSON.stringify({ type: 'user', isMeta: true, origin: { kind: 'peer' }, timestamp: '2026-11-01T21:40:00Z', message: { content: 'Another Claude session sent a message: created SO-98317 and opened the PR' } }));
  assert.equal(sources.ticketFrom(sources.readTranscript(file).text, cfg), 'SO-98317');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a stretch nobody spoke in is not time, but harness records inside a sitting still are', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', timestamp: '2026-10-21T17:17:00Z', message: { content: 'debug account 3805' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-21T17:40:00Z', message: { content: 'found it' } }),
    // Written after the last reply, within the sitting: it stays.
    JSON.stringify({ type: 'system', subtype: 'away_summary', timestamp: '2026-10-21T18:05:00Z', content: 'recap' }),
    // The next day, nobody there: it goes.
    JSON.stringify({ type: 'system', subtype: 'informational', timestamp: '2026-10-22T15:20:00Z', content: 'Remote Control disconnected' }),
    // A slash command is the operator at the keyboard: it stays.
    JSON.stringify({ type: 'system', subtype: 'local_command', timestamp: '2026-10-23T12:00:00Z', content: '/model' }),
  ].join('\n'));

  const parsed = sources.readTranscript(file, { idleGapMinutes: 30 });
  assert.deepEqual(parsed.stamps, [
    '2026-10-21T17:17:00Z',
    '2026-10-21T17:40:00Z',
    '2026-10-21T18:05:00Z',
    '2026-10-23T12:00:00Z',
  ]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a session is described by what was asked in it that day, not by its first prompt', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-home-'));
  const dir = path.join(home, '.claude', 'projects', '-Users-me-work-soci');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '35eb0198-91b1-4429-ac72-fda49b8ae1aa.jsonl'), [
    // Opened before midnight, first ask after it: the evening before is not work.
    JSON.stringify({ type: 'attachment', timestamp: '2026-11-02T05:57:41Z', attachment: { type: 'hook_success' } }),
    JSON.stringify({ type: 'user', timestamp: '2026-11-02T06:00:18Z', message: { content: 'regarding SO-101422 do discovery and prepare a tech spec' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-02T06:09:00Z', message: { content: 'spec published' } }),
    JSON.stringify({ type: 'user', timestamp: '2026-11-02T06:10:00Z', message: { content: 'add the estimate table' } }),
    // Still answering that past the next midnight, with nothing new asked.
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-03T06:05:00Z', message: { content: 'still going' } }),
    // Resumed a day later with a new ask.
    JSON.stringify({ type: 'user', timestamp: '2026-11-04T15:16:06Z', message: { content: 'the ticket was re-scoped, adjust our spec' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T15:20:00Z', message: { content: 'adjusted' } }),
  ].join('\n'));

  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const signals = sources.byId('sessions').collect({
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-11-05T00:00:00Z'),
      cfg: { workTimezone: 'America/Chicago' },
    });
    const byDay = {};
    for (const s of signals) (byDay[s.at.slice(0, 10)] ||= new Set()).add(s.text);

    assert.ok(signals.every(s => s.ticket === 'SO-101422'));
    // 05:57Z is 23:57 on Nov 1 in Chicago, before anything was asked.
    assert.ok(!signals.some(s => s.at.startsWith('2026-11-02T05:57')));
    assert.deepEqual([...byDay['2026-11-02']], ['regarding SO-101422 do discovery and prepare a tech spec · add the estimate table']);
    assert.deepEqual([...byDay['2026-11-03']], ['add the estimate table']);
    assert.deepEqual([...byDay['2026-11-04']], ['the ticket was re-scoped, adjust our spec']);
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the edits Jira makes when you log time are not work on that ticket', async () => {
  const jira = require('../lib/jiraWorklog');
  const stubbed = { currentUser: jira.currentUser, search: jira.search };
  const by = { accountId: 'me' };
  jira.currentUser = async () => by;
  jira.search = async () => [{
    key: 'SO-101422',
    fields: { comment: { comments: [] } },
    changelog: {
      histories: [
        { author: by, created: '2026-11-03T11:51:20Z', items: [{ field: 'timeestimate' }, { field: 'timespent' }, { field: 'WorklogId' }] },
        { author: by, created: '2026-11-03T15:18:57Z', items: [{ field: 'timespent' }, { field: 'WorklogTimeSpent' }] },
        { author: by, created: '2026-11-03T16:00:00Z', items: [{ field: 'status' }] },
        { author: by, created: '2026-11-03T16:30:00Z', items: [{ field: 'timeoriginalestimate' }] },
      ],
    },
  }];
  try {
    const signals = await sources.byId('jira').collect({
      from: new Date('2026-11-03T00:00:00Z'),
      to: new Date('2026-11-04T00:00:00Z'),
      cfg,
    });
    assert.deepEqual(signals.map(s => s.text), [
      'Updated SO-101422 (status)',
      // Estimating a ticket is planning it, not logging time to it.
      'Updated SO-101422 (timeoriginalestimate)',
    ]);
  } finally {
    Object.assign(jira, stubbed);
  }
});

test('an unreadable transcript degrades to nothing instead of throwing', () => {
  const parsed = sources.readTranscript('/definitely/not/here.jsonl');
  assert.deepEqual(parsed.stamps, []);
});

test('collecting from a source that is switched off produces nothing', async () => {
  const result = await sources.collectAll({
    from: new Date('2026-08-13T00:00:00Z'),
    to: new Date('2026-08-14T00:00:00Z'),
    cfg: { ...cfg, sources: { git: false, sessions: false, github: false } },
    only: ['git', 'sessions', 'github'],
  });
  assert.deepEqual(result.signals, []);
  assert.deepEqual(result.used, []);
});
