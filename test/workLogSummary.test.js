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
