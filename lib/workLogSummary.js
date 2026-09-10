// The end-of-day post.
//
// Shaped to match how these actually get written in #team-horses-eod: a fenced
// code block, the date on the first line, one item per thing that moved, and a
// short clause underneath saying what moved about it. No durations and no
// totals — the numbers are Jira's business.
//
// Because it is a code block, Slack renders none of its markup: no bold, no
// <url|text> links. Ticket keys go in bare, which is what the channel does.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function prettyDate(dayKey) {
  const [y, m, d] = String(dayKey).split('-').map(Number);
  const date = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  return `${DAY_NAMES[date.getUTCDay()]} ${d} ${MONTH_NAMES[(m || 1) - 1]}`;
}

// A stray triple backtick in a summary would end the fence early and spill the
// rest of the post as raw text.
function fenceSafe(text) {
  return String(text || '').replace(/`/g, "'").replace(/\s+/g, ' ').trim();
}

// Rows that represent real, claimed time. Candidates are still suggestions, so
// they never appear in a message you are about to send to a person.
function claimedRows(rows) {
  return (rows || []).filter(row => row.kind !== 'candidate' && (row.minutes || 0) > 0);
}

// "SO-52569 Give access to Admins to edit Default Values (in review)"
function itemHeading(row) {
  const parts = [];
  if (row.ticket) {
    parts.push(row.ticket);
    if (row.title) parts.push(fenceSafe(row.title));
  } else {
    parts.push(fenceSafe(row.label || 'untitled'));
  }
  const line = parts.join(' ');
  return row.status ? `${line} (${fenceSafe(row.status)})` : line;
}

/**
 * What goes under an item: the ticket's standing subject, then today's work.
 *
 * The context line is dropped when the title already says the same thing —
 * repeating it costs a line and tells the reader nothing.
 */
function subLines(row, clause) {
  const lines = [];
  const context = fenceSafe(row.context);
  if (context && !saysTheSame(context, row.title) && !saysTheSame(context, clause)) {
    lines.push(context);
  }
  if (clause) lines.push(clause);
  return lines;
}

function saysTheSame(a, b) {
  const words = text => new Set(
    String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter(w => w.length > 3),
  );
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const w of left) if (right.has(w)) shared += 1;
  return shared / Math.min(left.size, right.size) >= 0.7;
}

// The body of one day: meetings first as bare lines, then the items, then the
// PRs reviewed for other people folded into a single trailing line — reviewing
// six teammates' pull requests is one fact, not six.
function dayBody(rows) {
  const claimed = claimedRows(rows);
  const meetings = [];
  const items = [];
  const reviewed = [];
  const seen = new Set();

  for (const row of claimed) {
    if (row.attention === 'meetings') {
      const name = fenceSafe(row.label || row.ticket);
      if (name && !meetings.includes(name)) meetings.push(name);
      continue;
    }

    if (row.attention === 'peer-review' && row.ticket) {
      if (!reviewed.includes(row.ticket)) reviewed.push(row.ticket);
      continue;
    }

    const heading = itemHeading(row);
    const clause = fenceSafe(row.eod);
    const key = `${heading}|${clause.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push(`- ${heading}`);
    // Two sub-lines, because they answer different questions: what the ticket
    // is, and what moved on it today. Run together they read as one vague
    // clause, and the standing subject is what a reader who does not know the
    // ticket actually needs.
    for (const line of subLines(row, clause)) items.push(`  - ${line}`);
  }

  const blocks = [];
  if (meetings.length) blocks.push(meetings.join('\n'));
  if (items.length) blocks.push(items.join('\n'));
  if (reviewed.length) blocks.push(`reviewed PRs ${reviewed.join(', ')}`);
  return blocks;
}

function wrap(lines, cfg) {
  const preamble = String(cfg?.slack?.preamble || '').trim();
  // The preamble is a greeting, so it sits outside the fence.
  return (preamble ? `${preamble}\n` : '') + '```\n' + lines.join('\n') + '\n```';
}

function buildDayMessage({ date, rows, cfg }) {
  const blocks = dayBody(rows);
  if (!blocks.length) return wrap([date, '', 'nothing logged yet'], cfg);
  return wrap([date, '', ...blocks.join('\n\n').split('\n')], cfg);
}

// The same shape, one dated section per day, all inside one fence.
function buildWeekMessage({ days, cfg }) {
  const sections = [];

  for (const day of days) {
    const blocks = dayBody(day.rows);
    if (!blocks.length) continue;
    sections.push([day.date, '', ...blocks.join('\n\n').split('\n')].join('\n'));
  }

  if (!sections.length) {
    const span = `${days[0]?.date || ''} .. ${days[days.length - 1]?.date || ''}`;
    return wrap([span, '', 'nothing logged yet'], cfg);
  }
  return wrap(sections.join('\n\n').split('\n'), cfg);
}

module.exports = { buildDayMessage, buildWeekMessage, prettyDate, claimedRows, dayBody, itemHeading, subLines };
