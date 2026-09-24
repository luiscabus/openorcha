const test = require('node:test');
const assert = require('node:assert/strict');

const summary = require('../lib/workLogSummary');

const cfg = {};

function entry(overrides = {}) {
  return { kind: 'entry', minutes: 60, ...overrides };
}

function body(message) {
  const lines = message.split('\n');
  return lines.slice(lines.indexOf('```') + 1, lines.lastIndexOf('```'));
}

test('the message is a fenced code block with the date on the first line', () => {
  const message = summary.buildDayMessage({
    date: '2026-08-31',
    cfg,
    rows: [entry({ ticket: 'SO-1', title: 'Do the thing', status: 'live' })],
  });

  assert.ok(message.startsWith('```\n'));
  assert.ok(message.endsWith('\n```'));
  assert.equal(body(message)[0], '2026-08-31');
  assert.equal(body(message)[1], '');
});

test('an item is the ticket, its title, and where it stands', () => {
  const message = summary.buildDayMessage({
    date: '2026-08-31',
    cfg,
    rows: [entry({
      ticket: 'SO-90637',
      title: 'GA4 — bulk-link SOCi-owned properties via migration',
      status: 'live',
      eod: 'mass linking through internal page',
    })],
  });

  assert.match(message, /^- SO-90637 GA4 — bulk-link SOCi-owned properties via migration \(live\)$/m);
  assert.match(message, /^ {2}- mass linking through internal page$/m);
});

test('a ticket with no title or status is just the key', () => {
  const message = summary.buildDayMessage({
    date: '2026-08-31', cfg, rows: [entry({ ticket: 'SO-1' })],
  });
  assert.match(message, /^- SO-1$/m);
  assert.doesNotMatch(message, /\(\)/);
});

test('an item with nothing extra to say carries no sub-bullet', () => {
  const message = summary.buildDayMessage({
    date: '2026-08-31', cfg, rows: [entry({ ticket: 'SO-1', title: 'Do the thing', status: 'live' })],
  });
  assert.doesNotMatch(message, /^ {2}- /m);
});

test('work with no ticket appears under the name of the effort', () => {
  const message = summary.buildDayMessage({
    date: '2026-08-31',
    cfg,
    rows: [entry({ ticket: null, label: 'GA4 property spreadsheet mapping', eod: 'checked the account-to-property linkage' })],
  });
  assert.match(message, /^- GA4 property spreadsheet mapping$/m);
  assert.match(message, /^ {2}- checked the account-to-property linkage$/m);
});

test("reviewing teammates' PRs collapses into one trailing line", () => {
  // Six reviews is one fact about the day, not six items.
  const message = summary.buildDayMessage({
    date: '2026-08-31',
    cfg,
    rows: [
      entry({ ticket: 'SO-1', title: 'Mine', status: 'in progress' }),
      entry({ ticket: 'SO-93675', attention: 'peer-review' }),
      entry({ ticket: 'SO-93677', attention: 'peer-review' }),
      entry({ ticket: 'SO-93677', attention: 'peer-review' }),
    ],
  });

  assert.match(message, /^reviewed PRs SO-93675, SO-93677$/m);
  assert.doesNotMatch(message, /^- SO-93675/m);
  assert.equal(body(message)[body(message).length - 1], 'reviewed PRs SO-93675, SO-93677');
});

test('re-reviewing your own ticket stays an item, not a review', () => {
  // "re-review" is a second pass over your own PR after feedback; only
  // "peer-review" means someone else's.
  const message = summary.buildDayMessage({
    date: '2026-08-31',
    cfg,
    rows: [entry({ ticket: 'SO-52569', title: 'Mine', attention: 're-review', eod: 'addressed review feedback' })],
  });
  assert.match(message, /^- SO-52569 Mine$/m);
  assert.doesNotMatch(message, /reviewed PRs/);
});

test('meetings are bare lines above the items', () => {
  const message = summary.buildDayMessage({
    date: '2026-08-31',
    cfg,
    rows: [
      entry({ ticket: 'SO-1', title: 'Work' }),
      entry({ attention: 'meetings', label: 'Meeting w/ Gideon' }),
    ],
  });
  const lines = body(message);
  assert.equal(lines[2], 'Meeting w/ Gideon');
  assert.ok(lines.indexOf('Meeting w/ Gideon') < lines.findIndex(l => l.startsWith('- SO-1')));
});

test('there are no durations and no totals anywhere', () => {
  const message = summary.buildDayMessage({
    date: '2026-08-31',
    cfg,
    rows: [
      entry({ ticket: 'SO-1', title: 'Built it', minutes: 120, attention: 'coding' }),
      entry({ ticket: 'SO-2', title: 'Reviewed it', minutes: 60, attention: 'reviewing' }),
    ],
  });
  assert.doesNotMatch(message, /Total/i);
  assert.doesNotMatch(message, /\b\d+h\b/);
  assert.doesNotMatch(message, /\b\d+m\b/);
});

test('suggestions never reach a message you are about to send', () => {
  const message = summary.buildDayMessage({
    date: '2026-08-31',
    cfg,
    rows: [
      entry({ ticket: 'SO-1', title: 'kept' }),
      { kind: 'candidate', ticket: 'SO-2', minutes: 60, title: 'only a guess' },
    ],
  });
  assert.match(message, /kept/);
  assert.doesNotMatch(message, /only a guess/);
});

test('the same item twice collapses to one line', () => {
  const message = summary.buildDayMessage({
    date: '2026-08-31',
    cfg,
    rows: [
      entry({ ticket: 'SO-1', title: 'Work', eod: 'shipped it' }),
      entry({ ticket: 'SO-1', title: 'Work', eod: 'Shipped it' }),
    ],
  });
  assert.equal(body(message).filter(l => l.startsWith('- SO-1')).length, 1);
});

test('a backtick in a summary cannot break out of the fence', () => {
  const message = summary.buildDayMessage({
    date: '2026-08-31',
    cfg,
    rows: [entry({ ticket: 'SO-1', title: 'Fix ```the``` thing', eod: 'used `ancestors[]`' })],
  });
  // Exactly two fences: the opening and the closing one.
  assert.equal(message.split('```').length - 1, 2);
});

test('an empty day says so rather than printing an empty block', () => {
  const message = summary.buildDayMessage({ date: '2026-08-31', cfg, rows: [] });
  assert.match(message, /nothing logged yet/);
  assert.ok(message.startsWith('```\n2026-08-31'));
});

test('a preamble sits above the fence, not inside it', () => {
  const message = summary.buildDayMessage({
    date: '2026-08-31',
    cfg: { slack: { preamble: 'Daily update:' } },
    rows: [entry({ ticket: 'SO-1', title: 'Work' })],
  });
  assert.ok(message.startsWith('Daily update:\n```\n'));
});

test('the week is one fence with a dated section per day', () => {
  const message = summary.buildWeekMessage({
    cfg,
    days: [
      { date: '2026-08-31', rows: [entry({ ticket: 'SO-1', title: 'Built it' })] },
      { date: '2026-09-01', rows: [entry({ ticket: 'SO-2', title: 'Reviewed it' })] },
      { date: '2026-09-02', rows: [] },
    ],
  });

  assert.equal(message.split('```').length - 1, 2);
  assert.match(message, /2026-08-31\n\n- SO-1 Built it/);
  assert.match(message, /2026-09-01\n\n- SO-2 Reviewed it/);
  // A day with nothing on it gets no section.
  assert.doesNotMatch(message, /2026-09-02/);
});

test('a week with nothing in it says so', () => {
  const message = summary.buildWeekMessage({
    cfg,
    days: [{ date: '2026-08-31', rows: [] }, { date: '2026-09-01', rows: [] }],
  });
  assert.match(message, /nothing logged yet/);
});

// ─── What the ticket is, and what moved on it ────────────────────────────────

test('an item reads as the ticket and its title, then two sub-lines', () => {
  const message = summary.buildDayMessage({
    date: '2026-09-09',
    cfg,
    rows: [entry({
      ticket: 'SO-89850',
      title: 'Server-side directory level count',
      status: 'in review',
      context: 'expose child counts at every directory level so pages can render them',
      eod: 'threaded a publish-time child count through the asset schema',
    })],
  });

  assert.deepEqual(body(message).slice(2), [
    '- SO-89850 Server-side directory level count (in review)',
    '  - expose child counts at every directory level so pages can render them',
    '  - threaded a publish-time child count through the asset schema',
  ]);
});

test('the context line is dropped when the title already says it', () => {
  const lines = summary.subLines({
    title: 'Asset Storage PDFs on the client domain',
    context: 'asset storage pdfs on the client domain',
  }, 'scoped the feature-flag refresh problem');

  assert.deepEqual(lines, ['scoped the feature-flag refresh problem'], 'a repeat costs a line and says nothing');
});

test('the context line is dropped when it just restates the work', () => {
  const clause = 'threaded a publish-time child count through the asset schema';
  const lines = summary.subLines({ title: 'Directory count', context: clause }, clause);
  assert.deepEqual(lines, [clause]);
});

test('a different context survives beside a similar-sounding title', () => {
  const lines = summary.subLines({
    title: 'Directory count',
    context: 'so brands with thousands of locations can page through them',
  }, 'threaded the count through the schema');

  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'so brands with thousands of locations can page through them');
});

test('work with no ticket still gets its sub-lines', () => {
  const message = summary.buildDayMessage({
    date: '2026-09-09',
    cfg,
    rows: [entry({
      label: 'worklog review and branch prep',
      context: 'keeping the local checkouts current',
      eod: 'brought each repo to latest master and cut the branches',
    })],
  });

  assert.deepEqual(body(message).slice(2), [
    '- worklog review and branch prep',
    '  - keeping the local checkouts current',
    '  - brought each repo to latest master and cut the branches',
  ]);
});

test('an item with neither context nor clause is just its heading', () => {
  const message = summary.buildDayMessage({
    date: '2026-09-09',
    cfg,
    rows: [entry({ ticket: 'SO-1', title: 'A thing' })],
  });
  assert.deepEqual(body(message).slice(2), ['- SO-1 A thing']);
});

test('a stray backtick in the context cannot break the fence', () => {
  const lines = summary.subLines({ context: 'uses ```json blocks``` in the payload' }, 'fixed it');
  assert.ok(!lines[0].includes('`'));
});

test('several rows for one ticket become one item with every line under it', () => {
  const message = summary.buildDayMessage({
    date: '2026-09-17',
    cfg,
    rows: [
      entry({ ticket: 'SO-97101', eod: 'preview drops spotlight section when client has no data' }),
      entry({ ticket: 'SO-97101', title: 'Content Spotlight template editor issues', status: 'in review', eod: 'preview now opens the edited template\'s own page' }),
    ],
  });
  const lines = body(message);
  assert.equal(lines.filter(l => l.startsWith('- SO-97101')).length, 1);
  assert.match(message, /^- SO-97101 Content Spotlight template editor issues \(in review\)$/m);
  assert.match(message, /^ {2}- preview drops spotlight section/m);
  assert.match(message, /^ {2}- preview now opens/m);
});

test('a line typed by hand prints what was typed rather than a bare key', () => {
  const message = summary.buildDayMessage({
    date: '2026-09-14',
    cfg,
    rows: [entry({ ticket: 'SO-97101', origin: 'manual', summary: 'spotlight not visible after save' })],
  });
  assert.match(message, /^ {2}- spotlight not visible after save$/m);
});

test('work with no ticket carries no status', () => {
  const message = summary.buildDayMessage({
    date: '2026-09-16',
    cfg,
    rows: [entry({ ticket: null, label: 'Cloudflare ticket and side questions', status: 'in discovery', eod: 'raised devops ticket' })],
  });
  assert.match(message, /^- Cloudflare ticket and side questions$/m);
});

test('a Slack post covering two days splits into one per date', () => {
  const days = summary.parsePosted('```2026-09-16\n\n- SO-1 A &amp; B```\n\n```2026-09-17\n\n- SO-2```');
  assert.deepEqual(days.map(d => d.date), ['2026-09-16', '2026-09-17']);
  assert.equal(days[0].text, '```\n2026-09-16\n\n- SO-1 A & B\n```');
});
