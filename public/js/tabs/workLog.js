import { api, escHtml, toast } from '../utils.js';
import { morphInner } from '../morph.js';

// The work log tab.
//
// One merged list per day: time already in Jira, entries you have kept, and
// candidates detection is offering. Nothing reaches Jira without a click.
//
// It behaves like an app rather than a page: an action changes the row it was
// taken on, says so while it runs, and then re-reads the day quietly behind
// the screen. Nothing blanks, so the row you were on stays where it was.

const state = {
  date: null,
  mode: 'day',
  config: null,
  sources: [],
  day: null,
  week: null,
  // The date and mode the screen currently holds; null while switching.
  shown: null,
  // Rows are tracked by their screen key (see keyRows), not their id.
  expanded: new Set(),
  // Row key → what the row is doing, shown in place of its buttons.
  busy: new Map(),
  // `${row key}|${field}` → 'saving' or 'saved'.
  fields: new Map(),
  // Rows that appeared with the last re-read, briefly highlighted.
  fresh: new Set(),
  // Writes still running, and writes answered, per day. A read asked for
  // before a write was answered may predate it, so it is not drawn.
  pending: new Map(),
  writes: new Map(),
  // Row key → the tail of that row's writes, so they land in order.
  queues: new Map(),
  // Candidate key → the entry id it was saved as, until the screen catches up.
  materialized: new Map(),
  reads: 0,
  rescanning: false,
  togglingSource: null,
  switchTimer: null,
  // Which EOD text is on screen: 'posted', 'generated' or 'compare'.
  eodView: 'posted',
  // You have typed in the EOD box since it was last filled.
  eodDirty: false,
};

// Columns in the day table: Start, Ticket, Attention, Time, Status, Actions.
const WORKLOG_COLUMNS = 6;

const SOURCE_ICONS = {
  git: '◆', sessions: '◇', github: '⬡', jira: '▣',
  initiatives: '◈', reflog: '⤳', calendar: '▤', slack: '▧', shell: '❯',
};

function fmtDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function parseDuration(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return 0;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  let minutes = 0;
  const hours = value.match(/(\d+(?:\.\d+)?)\s*h/);
  const mins = value.match(/(\d+)\s*m/);
  if (hours) minutes += Math.round(parseFloat(hours[1]) * 60);
  if (mins) minutes += parseInt(mins[1], 10);
  return minutes || 0;
}

function shiftDay(dayKey, days) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

// Monday-first, mirroring workLogTime.weekStart on the server. Computing this
// locally is what lets the heading update the instant you press an arrow.
function weekStartOf(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return shiftDay(dayKey, dow === 0 ? -6 : 1 - dow);
}

function prettyDate(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

// ------------------------------------------------------------------ rendering

function renderTotals(totals, jiraState) {
  const pct = totals.dayTarget ? Math.min(100, Math.round((totals.logged / totals.dayTarget) * 100)) : 0;
  const jiraNote = !jiraState.configured
    ? 'Jira not configured'
    : jiraState.error ? 'Jira unreachable' : 'reconciled with Jira';

  return `
    <div class="worklog-stat">
      <span class="worklog-stat-label">Logged</span>
      <strong>${fmtDuration(totals.logged)}</strong>
      <small>${pct}% of a ${fmtDuration(totals.dayTarget)} day</small>
    </div>
    <div class="worklog-stat">
      <span class="worklog-stat-label">In Jira</span>
      <strong>${fmtDuration(totals.pushed)}</strong>
      <small>${escHtml(jiraNote)}</small>
    </div>
    <div class="worklog-stat">
      <span class="worklog-stat-label">Suggested</span>
      <strong>${fmtDuration(totals.suggested)}</strong>
      <small>detected, not yet kept</small>
    </div>
  `;
}

function relativeTime(iso) {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// A finished day is read once and kept, so it matters that the view says which
// read you are looking at rather than implying everything is live.
function renderCacheNote(info) {
  if (!info) return '';
  const when = relativeTime(info.collectedAt);
  if (!info.fromCache) {
    return `<span class="worklog-cache-note worklog-cache-live" title="Collected just now">read ${escHtml(when || 'now')}</span>`;
  }
  if (info.outdated) {
    return `<span class="worklog-cache-note" title="Settings or the collector changed since this was read. It is kept rather than re-read on every view — press Rescan to read it again with the current ones.">cached ${escHtml(when)} · read with older settings</span>`;
  }
  const label = info.sealed
    ? `cached ${escHtml(when)} · this day is finished`
    : `cached ${escHtml(when)}`;
  return `<span class="worklog-cache-note" title="Press Rescan to read it again">${label}</span>`;
}

// Where the day's attention went. This is the reason the log exists — the
// totals say how much, this says what kind.
function renderAttention(byAttention) {
  const entries = Object.entries(byAttention || {})
    .map(([kind, split]) => ({ kind, logged: split.logged || 0, suggested: split.suggested || 0 }))
    .filter(e => e.logged + e.suggested > 0)
    .sort((a, b) => (b.logged + b.suggested) - (a.logged + a.suggested));
  if (!entries.length) return '';

  const widest = Math.max(...entries.map(e => e.logged + e.suggested));
  const anySuggested = entries.some(e => e.suggested > 0);

  const bars = entries.map(e => {
    const total = e.logged + e.suggested;
    const label = e.suggested
      ? `${fmtDuration(e.logged)} logged · ${fmtDuration(e.suggested)} suggested`
      : `${fmtDuration(e.logged)} logged`;
    return `
      <div class="worklog-attention-row" title="${escHtml(e.kind)} — ${escHtml(label)}">
        <span class="worklog-attention-name">${escHtml(e.kind)}</span>
        <span class="worklog-attention-bar">
          <i style="width:${(e.logged / widest) * 100}%"></i><u style="width:${(e.suggested / widest) * 100}%"></u>
        </span>
        <span class="worklog-attention-value">${fmtDuration(total)}</span>
      </div>`;
  }).join('');

  const key = anySuggested
    ? '<span class="worklog-attention-key"><i></i> logged <u></u> suggested</span>'
    : '';

  return `<div class="worklog-attention">
    <div class="worklog-attention-head">Attention ${key}</div>${bars}</div>`;
}

function renderSourceBar() {
  const chips = state.sources.map(source => {
    const cls = !source.available ? 'worklog-chip-off'
      : source.enabled ? 'worklog-chip-on' : 'worklog-chip-idle';
    const title = source.available ? source.description : source.reason;
    const toggling = state.togglingSource === source.id ? ' worklog-chip-busy' : '';
    return `
      <button class="worklog-chip ${cls}${toggling}" title="${escHtml(title)}"
              onclick="toggleWorkLogSource('${source.id}')" ${source.available ? '' : 'disabled'}>
        <span class="worklog-chip-icon">${SOURCE_ICONS[source.id] || '•'}</span>${escHtml(source.label)}
      </button>`;
  }).join('');

  const current = state.mode === 'week' ? state.week : state.day;
  const errors = (current?.sources?.errors || []).map(e =>
    `<span class="worklog-source-error" title="${escHtml(e.error)}">${escHtml(e.source)} failed</span>`).join('')
    + (current?.narration?.error
      ? `<span class="worklog-source-error" title="${escHtml(current.narration.error)}">descriptions unavailable</span>`
      : '');

  const note = state.rescanning
    ? '<span class="worklog-cache-note worklog-cache-live"><span class="worklog-spinner"></span> reading git, sessions and Jira…</span>'
    : renderCacheNote(current?.cache);

  return `<div class="worklog-sources">${chips}${errors}${note}</div>`;
}

function renderSources() {
  morphInner(document.getElementById('worklog-source-bar'), renderSourceBar());
}

function pushBadge(row) {
  const push = row.push || {};
  if (row.kind === 'candidate') return '<span class="worklog-badge worklog-badge-candidate">suggested</span>';
  if (push.state === 'pushed') {
    return `<span class="worklog-badge worklog-badge-pushed" title="Jira worklog ${escHtml(push.worklogId || '')}">in Jira</span>`;
  }
  if (push.state === 'stale') {
    return `<span class="worklog-badge worklog-badge-stale" title="Jira holds ${fmtDuration(push.pushedMinutes)}">drifted</span>`;
  }
  if (push.state === 'failed') {
    return `<span class="worklog-badge worklog-badge-failed" title="${escHtml(push.error || '')}">failed</span>`;
  }
  return '<span class="worklog-badge worklog-badge-unpushed">not logged</span>';
}

function attentionChip(row) {
  if (!row.attention) return '<span class="worklog-attention-chip worklog-attention-none">—</span>';
  return `<span class="worklog-attention-chip">${escHtml(row.attention)}</span>`;
}

function rowActions(row) {
  const busy = state.busy.get(row.key);
  if (busy) return `<span class="worklog-busy"><span class="worklog-spinner"></span>${escHtml(busy)}</span>`;

  const key = escHtml(row.key);

  if (row.kind === 'jira') {
    return `<button class="btn btn-ghost btn-sm" onclick="adoptWorkLogJiraRow('${key}')">Track locally</button>`;
  }

  const push = row.push || {};
  const parts = [];

  if (row.kind === 'candidate') {
    parts.push(`<button class="btn btn-ghost btn-sm" onclick="keepWorkLogRow('${key}')">Keep</button>`);
    parts.push(`<button class="btn btn-primary btn-sm" onclick="pushWorkLogRow('${key}')">Log to Jira</button>`);
    parts.push(`<button class="btn btn-ghost btn-sm" onclick="dismissWorkLogRow('${key}')" title="Hide this suggestion">✕</button>`);
    return parts.join('');
  }

  if (push.state === 'pushed') {
    parts.push('<span class="worklog-action-note">logged</span>');
  } else if (push.state === 'stale' || push.worklogId) {
    parts.push(`<button class="btn btn-primary btn-sm" onclick="pushWorkLogRow('${key}')">Update Jira</button>`);
  } else {
    parts.push(`<button class="btn btn-primary btn-sm" onclick="pushWorkLogRow('${key}')">Log to Jira</button>`);
  }
  if (row.edited?.length) {
    parts.push(`<button class="btn btn-ghost btn-sm" onclick="revertWorkLogRow('${key}')"
      title="${escHtml(originalTitle(row))}">↺ original</button>`);
  }
  parts.push(`<button class="btn btn-ghost btn-sm" onclick="deleteWorkLogRow('${key}')" title="Remove this line">✕</button>`);
  return parts.join('');
}

// What the row said before you changed it, for the revert button's tooltip.
function originalTitle(row) {
  const original = row.original || {};
  const lines = row.edited.map(field => {
    const value = field === 'minutes' ? fmtDuration(original.minutes) : (original[field] || '(empty)');
    return `${field}: ${value}`;
  });
  return `You changed this line. Originally:\n${lines.join('\n')}`;
}

function renderEvidence(row) {
  if (!state.expanded.has(row.key)) return '';
  const key = escHtml(`${row.key}:evidence`);
  const signals = row.evidence || [];
  if (!signals.length) {
    return `<tr class="worklog-evidence-row" data-key="${key}"><td colspan="${WORKLOG_COLUMNS}"><div class="worklog-evidence"><em>No recorded signals — this line was entered by hand.</em></div></td></tr>`;
  }

  const items = signals.slice(0, 40).map(signal => `
    <li>
      <span class="worklog-evidence-time">${escHtml(signal.wall || '')}</span>
      <span class="worklog-evidence-src">${SOURCE_ICONS[signal.source] || '•'} ${escHtml(signal.source)}</span>
      <span class="worklog-evidence-text" title="${escHtml(signal.text || '')}">${escHtml(signal.text || '')}</span>
      ${signal.ref ? `<code>${escHtml(signal.ref)}</code>` : ''}
    </li>`).join('');

  const total = row.evidenceTotal ?? signals.length;
  const hidden = total - Math.min(signals.length, 40);
  const more = hidden > 0 ? `<li><em>…and ${hidden} more</em></li>` : '';
  const covered = row.coveredByJiraMinutes
    ? `<p class="worklog-evidence-warn">${escHtml(row.ticket || '')} already has ${fmtDuration(row.coveredByJiraMinutes)} in Jira for this day. Logging this too would double-count.</p>`
    : '';

  return `<tr class="worklog-evidence-row" data-key="${key}"><td colspan="${WORKLOG_COLUMNS}"><div class="worklog-evidence">${covered}<ul>${items}${more}</ul></div></td></tr>`;
}

// Which of the source names a row's evidence came from, in words — the glyphs
// alone meant nothing without hovering each one.
function sourceSummary(row) {
  const names = Object.keys(row.sourceCounts || {});
  if (!names.length) return '';
  const marks = names.map(s => SOURCE_ICONS[s] || '•').join('');
  return `<span class="worklog-block-sources" title="Show the evidence with ▸">${marks} ${escHtml(names.join(', '))}</span>`;
}

// Where this row lands in the EOD post, when it is not an item of its own.
function eodPlacement(row) {
  if (row.attention === 'peer-review' && row.ticket) return 'folded into the "reviewed PRs" line';
  if (row.attention === 'meetings' && !row.ticket) return 'printed as a bare line above the items';
  return '';
}

// The heading the EOD post prints for this row: ticket and title, or the name
// of the effort when there is no ticket.
function headingName(row) {
  if (row.ticket) return row.title || '';
  return row.label || '';
}

function renderRow(row) {
  const key = escHtml(row.key);
  const readOnly = row.kind === 'jira';
  const warn = row.coveredByJiraMinutes ? ' worklog-row-warn' : '';
  const busy = state.busy.has(row.key) ? ' worklog-row-busy' : '';
  const fresh = state.fresh.has(row.key) ? ' worklog-row-fresh' : '';
  const rowClass = `worklog-row-${row.kind}${warn}${busy}${fresh}`;
  const name = headingName(row);

  // Facts on the first line; below it, the three texts a row carries, each
  // under its audience: what you did (private), what the EOD post prints, and
  // what Jira receives. They used to share one unlabelled strip, which made it
  // impossible to tell which box went where.
  const said = readOnly
    ? `<div class="worklog-block worklog-block-did">
         <div class="worklog-block-head"><span>Jira comment</span></div>
         <div class="worklog-said-text">${escHtml(row.summary || '—')}</div>
       </div>`
    : `<div class="worklog-block worklog-block-did">
         <div class="worklog-block-head"><span>What you did</span><small>private</small>${sourceSummary(row)}</div>
         <textarea class="worklog-input worklog-input-summary${fieldClass(row, 'summary')}" rows="1" placeholder="What you did"
                   oninput="growWorkLogField(this)"
                   onkeydown="if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); this.blur(); }"
                   onchange="editWorkLogRow('${key}','summary',this.value)">${escHtml(row.summary || '')}</textarea>
       </div>
       <div class="worklog-block worklog-block-eod">
         <div class="worklog-block-head"><span>EOD post</span>${eodPlacement(row) ? `<small>${escHtml(eodPlacement(row))}</small>` : ''}</div>
         <label class="worklog-eod-line"><span>about</span>
           <input class="worklog-input${fieldClass(row, 'context')}" value="${escHtml(row.context || '')}"
                  placeholder="${row.ticket ? 'what the ticket is about' : 'what this effort is about'}" onchange="editWorkLogRow('${key}','context',this.value)"></label>
         <label class="worklog-eod-line"><span>today</span>
           <input class="worklog-input${fieldClass(row, 'eod')}" value="${escHtml(row.eod || '')}"
                  placeholder="what moved today" onchange="editWorkLogRow('${key}','eod',this.value)"></label>
       </div>
       <div class="worklog-block worklog-block-jira">
         <div class="worklog-block-head"><span>Jira note</span></div>
         <input class="worklog-input${fieldClass(row, 'note')}" value="${escHtml(row.note || '')}"
                placeholder="brief note" onchange="editWorkLogRow('${key}','note',this.value)">
       </div>`;

  return `
    <tr class="worklog-row worklog-row-facts ${rowClass}" data-key="${key}">
      <td class="worklog-cell-time">
        <button class="worklog-expand" onclick="toggleWorkLogEvidence('${key}')" title="Show what this came from">
          ${state.expanded.has(row.key) ? '▾' : '▸'}
        </button>
        ${escHtml(row.startTime || '—')}
      </td>
      <td class="worklog-cell-ticket"><div class="worklog-ticket-line">
        ${readOnly
          ? `<strong>${escHtml(row.ticket || '—')}</strong>`
          : `<input class="worklog-input worklog-input-ticket${savingClass(row, 'ticket')}" value="${escHtml(row.ticket || '')}"
                    placeholder="no ticket" onchange="editWorkLogRow('${key}','ticket',this.value)">`}
        ${name ? `<span class="worklog-row-name" title="${escHtml(name)}">${escHtml(name)}</span>` : ''}
      </div></td>
      <td class="worklog-cell-attention">${attentionChip(row)}</td>
      <td class="worklog-cell-duration">
        ${readOnly
          ? fmtDuration(row.minutes)
          : `<input class="worklog-input worklog-input-duration${savingClass(row, 'minutes')}" value="${fmtDuration(row.minutes)}"
                    onchange="editWorkLogRow('${key}','minutes',this.value)">`}
      </td>
      <td class="worklog-cell-status">${pushBadge(row)}</td>
      <td class="worklog-cell-actions"><div class="worklog-actions">${rowActions(row)}</div></td>
    </tr>
    <tr class="worklog-row worklog-row-said ${rowClass}" data-key="${escHtml(`${row.key}:said`)}">
      <td class="worklog-cell-summary" colspan="${WORKLOG_COLUMNS}">
        <div class="worklog-said${readOnly ? ' worklog-said-readonly' : ''}">${said}</div>
      </td>
    </tr>
    ${renderEvidence(row)}
  `;
}

function editedClass(row, field) {
  return row.edited?.includes(field) ? ' worklog-input-edited' : '';
}

// A field being saved, or just saved, says so on the field itself.
function savingClass(row, field) {
  const status = state.fields.get(`${row.key}|${field}`);
  return status ? ` worklog-input-${status}` : '';
}

function fieldClass(row, field) {
  return editedClass(row, field) + savingClass(row, field);
}

/** Size a description field to its content — these run to a sentence or two. */
export function growWorkLogField(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
}

function growAllWorkLogFields() {
  document.querySelectorAll('#worklog-body .worklog-input-summary').forEach(growWorkLogField);
}

function renderDay() {
  const day = state.day;
  const container = document.getElementById('worklog-body');
  if (!day) return;

  const rows = day.rows.length
    ? day.rows.map(renderRow).join('')
    : `<tr data-key="notice"><td colspan="${WORKLOG_COLUMNS}"><div class="empty-state"><p>Nothing found for this day</p>
        <small>No commits, sessions or Jira time. Add a line by hand below, or turn on more sources.</small></div></td></tr>`;

  morphInner(container, rows);
  growAllWorkLogFields();
  morphInner(document.getElementById('worklog-summary'), renderTotals(day.totals, day.jira || {}));
  morphInner(document.getElementById('worklog-attention'), renderAttention(day.byAttention));
  renderSources();
  renderEod();

  const jiraWarning = document.getElementById('worklog-jira-warning');
  if (day.jira?.error) {
    jiraWarning.style.display = '';
    jiraWarning.textContent = `Jira could not be read, so "in Jira" state may be out of date: ${day.jira.error}`;
  } else if (day.jira && !day.jira.configured) {
    jiraWarning.style.display = '';
    jiraWarning.textContent = 'Jira is not configured. Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN to log time from here.';
  } else {
    jiraWarning.style.display = 'none';
  }
}

// The EOD panel has two texts: what this tool generates from your rows, and
// what you posted. Yours is shown when you have one; the generated one is
// never thrown away and can be compared against it.
function renderEod() {
  const day = state.day;
  const field = document.getElementById('worklog-message');
  const meta = document.getElementById('worklog-eod-meta');
  const compare = document.getElementById('worklog-eod-compare');
  const posted = day?.posted;
  const showing = posted && state.eodView !== 'generated' ? 'posted' : 'generated';

  if (state.eodView === 'compare' && posted) {
    field.style.display = 'none';
    compare.style.display = '';
    compare.innerHTML = renderLineDiff(day.message || '', posted.text);
  } else {
    field.style.display = '';
    compare.style.display = 'none';
    // Text you are rewriting is yours until you save it or switch views; a
    // re-read after a row edit must not put the generated message back over it.
    const text = showing === 'posted' ? posted.text : (day?.message || '');
    if (!state.eodDirty && field.value !== text) field.value = text;
  }

  const views = posted
    ? ['posted', 'generated', 'compare'].map(view => `
        <button class="btn btn-ghost btn-sm${(state.eodView || 'posted') === view ? ' active' : ''}"
                onclick="setWorkLogEodView('${view}')">${view === 'posted' ? 'Yours' : view === 'generated' ? 'Generated' : 'Compare'}</button>`).join('')
    : '';
  const note = state.eodDirty
    ? '<span class="worklog-cache-note worklog-eod-unsaved">edited · not saved</span>'
    : posted
    ? `<span class="worklog-cache-note">yours · ${posted.source === 'slack' ? 'from Slack' : 'saved'} ${escHtml(relativeTime(posted.savedAt))}${posted.history?.length ? ` · ${posted.history.length} earlier version${posted.history.length === 1 ? '' : 's'}` : ''}</span>`
    : '<span class="worklog-cache-note">generated from your kept lines · edit it and save to keep your version</span>';
  const reset = posted
    ? '<button class="btn btn-ghost btn-sm" onclick="clearWorkLogPosted()" title="Go back to the generated text. Yours is kept in history.">Use generated</button>'
    : '';
  morphInner(meta, `${views}${note}${reset}`);
}

/** The EOD box was typed in: keep the text over re-reads until it is saved. */
export function markWorkLogEodEdited() {
  if (state.eodDirty) return;
  state.eodDirty = true;
  render();
}

// A line-level comparison: what only the generated text has, and what only
// yours has. Enough to see how your rewrite differs without a diff library.
function renderLineDiff(generated, posted) {
  const strip = text => text.split('\n').filter(l => l.trim() && l.trim() !== '```');
  const left = strip(generated);
  const right = strip(posted);
  const rightSet = new Set(right.map(l => l.trim()));
  const leftSet = new Set(left.map(l => l.trim()));
  const onlyGenerated = left.filter(l => !rightSet.has(l.trim()));
  const lines = right.map(l => rightSet.has(l.trim()) && leftSet.has(l.trim())
    ? `<div class="worklog-diff-same">  ${escHtml(l)}</div>`
    : `<div class="worklog-diff-add" title="Only in yours">+ ${escHtml(l)}</div>`);
  const removed = onlyGenerated.map(l => `<div class="worklog-diff-del" title="Only in the generated text">− ${escHtml(l)}</div>`);
  return `<div class="worklog-diff">${lines.join('')}${removed.length ? `<div class="worklog-diff-sep">only in the generated text</div>${removed.join('')}` : ''}</div>`;
}

function renderWeek() {
  const week = state.week;
  const container = document.getElementById('worklog-body');
  if (!week) return;

  const rows = week.days.map(day => {
    const logged = day.rows.filter(r => r.kind !== 'candidate').reduce((s, r) => s + r.minutes, 0);
    const suggested = day.rows.filter(r => r.kind === 'candidate').reduce((s, r) => s + r.minutes, 0);
    const tickets = [...new Set(day.rows.filter(r => r.kind !== 'candidate' && r.ticket).map(r => r.ticket))];
    return `
      <tr class="worklog-row" data-key="week|${day.date}">
        <td class="worklog-cell-time"><a href="#" onclick="openWorkLogDay('${day.date}');return false;">${escHtml(prettyDate(day.date))}</a></td>
        <td colspan="2" class="worklog-cell-summary">${tickets.length ? tickets.map(t => `<code>${escHtml(t)}</code>`).join(' ') : '<em>nothing logged</em>'}</td>
        <td class="worklog-cell-duration">${fmtDuration(logged)}</td>
        <td class="worklog-cell-status">${suggested ? `<span class="worklog-badge worklog-badge-candidate">+${fmtDuration(suggested)} suggested</span>` : ''}</td>
        <td class="worklog-cell-actions"><button class="btn btn-ghost btn-sm" onclick="openWorkLogDay('${day.date}')">Open</button></td>
      </tr>`;
  }).join('');

  morphInner(container, rows);

  const totals = week.days.reduce((acc, day) => {
    acc.logged += day.totals.logged;
    acc.pushed += day.totals.pushed;
    acc.suggested += day.totals.suggested;
    return acc;
  }, { logged: 0, pushed: 0, suggested: 0, dayTarget: (state.config?.dayMinutes || 420) * 5 });

  const weekAttention = {};
  for (const day of week.days) {
    for (const [kind, split] of Object.entries(day.byAttention || {})) {
      if (!weekAttention[kind]) weekAttention[kind] = { logged: 0, suggested: 0 };
      weekAttention[kind].logged += split.logged || 0;
      weekAttention[kind].suggested += split.suggested || 0;
    }
  }
  morphInner(document.getElementById('worklog-summary'), renderTotals(totals, week.jira || {}));
  morphInner(document.getElementById('worklog-attention'), renderAttention(weekAttention));
  renderSources();
  const field = document.getElementById('worklog-message');
  field.style.display = '';
  document.getElementById('worklog-eod-compare').style.display = 'none';
  morphInner(document.getElementById('worklog-eod-meta'), state.eodDirty
    ? '<span class="worklog-cache-note worklog-eod-unsaved">edited · not saved</span>'
    : '');
  if (!state.eodDirty && field.value !== (week.message || '')) field.value = week.message || '';
}

function isShown() {
  return state.shown?.date === state.date && state.shown?.mode === state.mode;
}

// Draws what is in state, but only when it is what the screen should hold —
// mid-switch it still describes the day you just left.
function render() {
  if (!isShown()) return;
  if (state.mode === 'week') renderWeek();
  else renderDay();
}

// A thin bar along the top while anything is read or saved, so work happening
// behind the screen is visible without blanking it.
function renderActivity() {
  const active = state.reads > 0 || [...state.pending.values()].some(n => n > 0);
  document.getElementById('worklog-activity')?.classList.toggle('active', active);
}

function renderRescanButton() {
  const button = document.getElementById('worklog-rescan');
  if (!button) return;
  button.disabled = state.rescanning;
  button.textContent = state.rescanning ? 'Rescanning…' : 'Rescan';
}

function renderHeader() {
  document.getElementById('worklog-date-label').textContent = state.mode === 'week'
    ? `Week of ${prettyDate(weekStartOf(state.date))}`
    : prettyDate(state.date);
  document.querySelectorAll('[data-worklog-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.worklogMode === state.mode);
  });
}

// -------------------------------------------------------------------- loading

function countFor(counts, date) {
  return counts.get(date) || 0;
}

function bump(counts, date, by) {
  counts.set(date, countFor(counts, date) + by);
}

// A row's identity on screen. A suggestion and the entry it becomes share the
// candidate key, so keeping or editing one keeps its place, its focus and its
// open evidence rather than being swapped for a new row.
function keyRows(rows) {
  const seen = new Set();
  for (const row of rows) {
    let key = row.candidateKey || row.id;
    if (seen.has(key)) key = row.id;
    seen.add(key);
    row.key = key;
  }
}

// What is on screen belongs to another day. It stops being editable at once,
// and gives way to the reading notice only if the new one is slow to come — a
// cached day simply replaces it, without a flash of empty page.
function beginSwitch() {
  state.shown = null;
  state.eodDirty = false;
  document.getElementById('tab-worklog').classList.add('worklog-switching');
  clearTimeout(state.switchTimer);
  state.switchTimer = setTimeout(showReading, 180);
}

function showNotice(title, detail) {
  clearTimeout(state.switchTimer);
  document.getElementById('tab-worklog').classList.remove('worklog-switching');
  morphInner(document.getElementById('worklog-body'),
    `<tr data-key="notice"><td colspan="${WORKLOG_COLUMNS}"><div class="empty-state"><p>${escHtml(title)}</p><small>${escHtml(detail)}</small></div></td></tr>`);
  document.getElementById('worklog-summary').innerHTML = '';
  document.getElementById('worklog-attention').innerHTML = '';
  document.getElementById('worklog-message').value = '';
  document.getElementById('worklog-eod-meta').innerHTML = '';
}

function showReading() {
  const scope = state.mode === 'week' ? 'week' : 'day';
  showNotice(`Reading your ${scope}…`, 'Scanning git, sessions and Jira, then describing the work.');
}

function applyView(data) {
  clearTimeout(state.switchTimer);
  document.getElementById('tab-worklog').classList.remove('worklog-switching');

  if (state.mode === 'week') {
    state.week = data;
    state.fresh = new Set();
  } else {
    keyRows(data.rows);
    const before = isShown() && state.day ? new Set(state.day.rows.map(r => r.key)) : null;
    state.fresh = new Set(before ? data.rows.filter(r => !before.has(r.key)).map(r => r.key) : []);
    state.day = data;
  }
  state.shown = { date: state.date, mode: state.mode };

  // Only drawn with nothing in flight for this day, so whatever a row was
  // doing has finished and the read already shows the result.
  state.busy.clear();
  state.materialized.clear();

  renderHeader();
  render();
}

// Every read of the view goes through here, and a response is drawn only
// while it still describes the screen: the same day and mode, no write in
// flight, and none answered since it was asked for. A read a write overtook
// is followed by a quick one from the cache it has just filled, rather than
// painting back what you had just changed.
async function readView({ refresh = false, reuse = false } = {}) {
  const { date, mode } = state;
  const writes = countFor(state.writes, date);
  const query = refresh ? '?refresh=1' : reuse ? '?reuse=1' : '';
  const current = () => date === state.date && mode === state.mode;

  state.reads += 1;
  renderActivity();
  try {
    const data = await api('GET', `/api/worklog/${mode}/${date}${query}`);
    if (!current() || countFor(state.pending, date)) return;
    if (writes !== countFor(state.writes, date)) {
      await readView({ reuse: true });
      return;
    }
    applyView(data);
  } catch (err) {
    // A day you have already moved away from has nothing to report.
    if (current()) throw err;
  } finally {
    state.reads -= 1;
    renderActivity();
  }
}

function readFailed(err) {
  if (isShown()) toast(err.message, 'error');
  else showNotice('Could not build the log', err.message);
}

export async function loadWorkLog(options = {}) {
  // Paint the date you asked for straight away. A cold read takes a minute, and
  // leaving the previous day on screen the whole time reads as a dead button.
  if (state.date) renderHeader();
  if (!isShown()) beginSwitch();

  try {
    if (!state.config) {
      const meta = await api('GET', '/api/worklog/config');
      state.config = meta.config;
      state.sources = meta.sources;
      // Open on yesterday: today is still being worked, and the day you want
      // to review or report on is the one that finished.
      if (!state.date) {
        state.date = shiftDay(meta.today, -1);
        renderHeader();
      }
    }
  } catch (err) {
    readFailed(err);
    return;
  }

  if (options.refresh) {
    await rescan();
    return;
  }
  // Coming back to a view already on screen re-reads it behind what you see.
  try {
    await readView();
  } catch (err) {
    readFailed(err);
  }
}

// Reads every source again, with the current view left in place and usable
// while it runs — it takes about a minute.
async function rescan() {
  state.rescanning = true;
  renderRescanButton();
  renderSources();
  try {
    await readView({ refresh: true });
  } catch (err) {
    readFailed(err);
  } finally {
    state.rescanning = false;
    renderRescanButton();
    renderSources();
  }
}

function findRow(key) {
  return (state.day?.rows || []).find(r => r.key === key) || null;
}

// A candidate is only a suggestion until it is saved. Anything that acts on
// one — editing, keeping, logging — makes it a real entry first, and only
// once: a second action taken before the screen catches up must not save the
// same suggestion twice.
function materialize(row, date) {
  if (row.kind !== 'candidate') return Promise.resolve(row.id);
  if (!state.materialized.has(row.candidateKey)) {
    const saving = api('POST', `/api/worklog/day/${date}/entries`, {
      date: row.date,
      ticket: row.ticket,
      label: row.label,
      attention: row.attention,
      note: row.note,
      minutes: row.minutes,
      summary: row.summary,
      // What the ticket is, its name, where it stands and the clause the EOD post
      // prints. Detection worked all four out; dropping them here meant a kept
      // row went back to the day cache for them, and lost them when it was pruned.
      context: row.context,
      title: row.title,
      status: row.status,
      eod: row.eod,
      startTime: row.startTime,
      origin: 'detected',
      candidateKey: row.candidateKey,
      sources: row.evidence,
    }).then(saved => saved.id);
    saving.catch(() => state.materialized.delete(row.candidateKey));
    state.materialized.set(row.candidateKey, saving);
  }
  return state.materialized.get(row.candidateKey);
}

// Runs one write. Writes to the same row queue behind each other; the row or
// field says what is happening while they run; and once the day has nothing
// left in flight it is re-read quietly, from the read already on screen, so
// the totals and the EOD text catch up in a moment rather than a minute.
// Resolves to whether the write worked.
function write({ date, key = null, label = null, field = null }, work) {
  const fieldId = field ? `${key}|${field}` : null;
  if (label) state.busy.set(key, label);
  if (fieldId) state.fields.set(fieldId, 'saving');
  bump(state.pending, date, 1);
  renderActivity();
  render();

  const previous = (key && state.queues.get(key)) || Promise.resolve();
  const run = previous
    .then(work)
    .then(() => {
      if (fieldId) flashSaved(fieldId);
      return true;
    }, err => {
      if (fieldId) state.fields.delete(fieldId);
      toast(err.message, 'error');
      return false;
    })
    .finally(() => {
      if (key && state.queues.get(key) === run) state.queues.delete(key);
      bump(state.pending, date, -1);
      bump(state.writes, date, 1);
      renderActivity();
      settle(date);
    });
  if (key) state.queues.set(key, run);
  return run;
}

function settle(date) {
  if (countFor(state.pending, date) || date !== state.date) return;
  readView({ reuse: true }).catch(err => {
    state.busy.clear();
    render();
    toast(err.message, 'error');
  });
}

function flashSaved(fieldId) {
  state.fields.set(fieldId, 'saved');
  render();
  setTimeout(() => {
    if (state.fields.get(fieldId) !== 'saved') return;
    state.fields.delete(fieldId);
    render();
  }, 1400);
}

// A static button that says what it is doing until the work is done.
function holdButton(button, label) {
  if (!button) return () => {};
  const text = button.textContent;
  button.disabled = true;
  button.textContent = label;
  return () => {
    button.disabled = false;
    button.textContent = text;
  };
}

// --------------------------------------------------------------------- actions

export function editWorkLogRow(key, field, value) {
  const row = findRow(key);
  if (!row) return;

  const patch = {};
  if (field === 'minutes') patch.minutes = parseDuration(value);
  else if (field === 'ticket') patch.ticket = value.trim().toUpperCase();
  else patch[field] = value;

  // A candidate is saved as offered first, then edited, so the entry's
  // original is the suggestion rather than your rewrite of it.
  const offered = { ...row };
  const date = state.day.date;
  // Shown at once; the re-read after the save confirms it.
  Object.assign(row, patch);

  write({ date, key: row.key, field }, async () => {
    const entryId = await materialize(offered, date);
    await api('PUT', `/api/worklog/day/${date}/entries/${entryId}`, patch);
  });
}

export function keepWorkLogRow(key) {
  const row = findRow(key);
  if (!row) return;
  const date = state.day.date;
  write({ date, key: row.key, label: 'Keeping…' }, async () => {
    await materialize(row, date);
    toast('Kept in your log');
  });
}

export function dismissWorkLogRow(key) {
  const row = findRow(key);
  if (!row?.candidateKey) return;
  const date = state.day.date;
  write({ date, key: row.key, label: 'Hiding…' }, () =>
    api('POST', `/api/worklog/day/${date}/dismiss`, { candidateKey: row.candidateKey }));
}

export function deleteWorkLogRow(key) {
  const row = findRow(key);
  if (!row) return;
  if (row.push?.state === 'pushed' && !confirm(
    `This line is logged in Jira as worklog ${row.push.worklogId}.\n\n`
    + 'Removing it here does NOT remove it from Jira — delete it there too if that is what you want.\n\nRemove the local line?')) {
    return;
  }
  const date = state.day.date;
  write({ date, key: row.key, label: 'Removing…' }, () =>
    api('DELETE', `/api/worklog/day/${date}/entries/${row.id}`));
}

// The only thing in this tab that writes to Jira, and it asks first.
export function pushWorkLogRow(key) {
  const row = findRow(key);
  if (!row) return;

  if (!row.ticket) {
    toast('Give this line a ticket before logging it', 'error');
    return;
  }

  const date = state.day.date;
  const updating = row.push?.state === 'stale' || row.push?.worklogId;
  const warning = row.coveredByJiraMinutes && !updating
    ? `\n\nNote: ${row.ticket} already has ${fmtDuration(row.coveredByJiraMinutes)} logged today.`
    : '';

  const note = (row.note || '').trim();
  const noteLine = `\n\nNote posted to the ticket: ${note ? `"${note}"` : '(none)'}`;
  const question = updating
    ? `Update the Jira worklog on ${row.ticket} to ${fmtDuration(row.minutes)}?${noteLine}`
    : `Log ${fmtDuration(row.minutes)} to ${row.ticket} on ${date}?${noteLine}${warning}`;

  if (!confirm(question)) return;

  write({ date, key: row.key, label: updating ? 'Updating Jira…' : 'Logging to Jira…' }, async () => {
    const entryId = await materialize(row, date);
    const result = await api('POST', `/api/worklog/day/${date}/entries/${entryId}/push`, { confirm: true });
    toast(`${updating ? 'Updated' : 'Logged'} ${fmtDuration(result.jira.minutes)} on ${row.ticket}`);
  });
}

export function adoptWorkLogJiraRow(key) {
  const row = findRow(key);
  if (!row?.jira) return;
  const date = state.day.date;
  write({ date, key: row.key, label: 'Tracking…' }, () =>
    api('POST', `/api/worklog/day/${date}/entries`, {
      date,
      ticket: row.ticket,
      minutes: row.minutes,
      summary: row.summary,
      startTime: row.startTime,
      origin: 'manual',
      push: { state: 'pushed', worklogId: row.jira.worklogId, pushedMinutes: row.minutes, pushedAt: row.jira.started },
    }));
}

export async function addWorkLogLine(event) {
  event.preventDefault();
  const ticket = document.getElementById('worklog-new-ticket');
  const summaryField = document.getElementById('worklog-new-summary');
  const noteField = document.getElementById('worklog-new-note');
  const duration = document.getElementById('worklog-new-duration');

  const minutes = parseDuration(duration.value);
  if (!minutes) {
    toast('Give the line a duration, like 45m or 1h 30m', 'error');
    return;
  }

  const date = state.date;
  const release = holdButton(event.submitter || event.target.querySelector('[type="submit"]'), 'Adding…');
  const added = await write({ date }, () => api('POST', `/api/worklog/day/${date}/entries`, {
    date,
    ticket: ticket.value.trim().toUpperCase() || null,
    summary: summaryField.value.trim(),
    // A hand-typed line still needs something terse for the ticket; fall
    // back to the description rather than pushing an empty comment.
    note: noteField.value.trim() || summaryField.value.trim().slice(0, 60),
    minutes,
    origin: 'manual',
  }));
  release();

  if (added) {
    ticket.value = '';
    summaryField.value = '';
    noteField.value = '';
    duration.value = '';
    // Ready for the next one.
    ticket.focus();
  }
}

export function toggleWorkLogEvidence(key) {
  if (state.expanded.has(key)) state.expanded.delete(key);
  else state.expanded.add(key);
  render();
}

export async function toggleWorkLogSource(sourceId) {
  const source = state.sources.find(s => s.id === sourceId);
  if (!source || !source.available || state.togglingSource) return;

  state.togglingSource = sourceId;
  renderSources();
  try {
    const result = await api('PUT', '/api/worklog/config', { sources: { [sourceId]: !source.enabled } });
    state.config = result.config;
    state.sources = result.sources;
  } catch (err) {
    toast(err.message, 'error');
    return;
  } finally {
    state.togglingSource = null;
    renderSources();
  }
  await rescan();
}

export function shiftWorkLogDate(days) {
  state.date = shiftDay(state.date, state.mode === 'week' ? days * 7 : days);
  loadWorkLog();
}

export function openWorkLogDay(dayKey) {
  state.date = dayKey;
  state.mode = 'day';
  loadWorkLog();
}

export function setWorkLogMode(mode) {
  state.mode = mode;
  loadWorkLog();
}

export async function goToWorkLogToday() {
  const meta = await api('GET', '/api/worklog/config');
  state.date = meta.today;
  loadWorkLog();
}

export async function goToWorkLogYesterday() {
  const meta = await api('GET', '/api/worklog/config');
  state.date = shiftDay(meta.today, -1);
  loadWorkLog();
}

export function rescanWorkLog() {
  return rescan();
}

export function revertWorkLogRow(key) {
  const row = findRow(key);
  if (!row) return;
  const date = state.day.date;
  write({ date, key: row.key, label: 'Reverting…' }, async () => {
    await api('POST', `/api/worklog/day/${date}/entries/${row.id}/revert`, {});
    toast('Back to the original text');
  });
}

export function setWorkLogEodView(view) {
  state.eodView = view;
  state.eodDirty = false;
  renderEod();
}

// Saves what is in the box as the day's posted EOD. A paste covering other
// days — one Slack message often carries two — is filed under each date.
export async function saveWorkLogPosted(button) {
  const text = document.getElementById('worklog-message').value;
  const date = state.date;
  const dates = [...text.matchAll(/(?:^|```\s*)(\d{4}-\d{2}-\d{2})/gm)].map(m => m[1]);
  const otherDays = dates.some(d => d !== date);

  const release = holdButton(button, 'Saving…');
  await write({ date }, async () => {
    let posted;
    if (otherDays) {
      const result = await api('POST', '/api/worklog/eod/import', { text });
      posted = result.saved.find(s => s.date === date)?.eod;
      toast(`Saved yours for ${result.saved.map(s => s.date).join(', ')}`);
    } else {
      posted = await api('PUT', `/api/worklog/day/${date}/eod`, {
        text,
        drafted: state.day?.message || null,
        source: 'typed',
      });
      toast('Saved as what you posted — the generated text is kept too');
    }
    // Shown as saved now, so the box does not fall back to the generated
    // text for the moment before the re-read lands.
    if (posted && state.day?.date === date) state.day.posted = posted;
    state.eodView = 'posted';
    state.eodDirty = false;
    render();
  });
  release();
}

export async function clearWorkLogPosted() {
  if (!confirm('Go back to the generated EOD text? Your version is kept in the day\'s history.')) return;
  const date = state.date;
  await write({ date }, async () => {
    await api('DELETE', `/api/worklog/day/${date}/eod`);
    if (state.day?.date === date) state.day.posted = null;
    state.eodView = 'posted';
    state.eodDirty = false;
    render();
  });
}

export async function copyWorkLogMessage() {
  const field = document.getElementById('worklog-message');
  try {
    await navigator.clipboard.writeText(field.value);
    toast('EOD message copied — paste it into Slack');
  } catch {
    field.select();
    document.execCommand('copy');
    toast('EOD message copied');
  }
}
