import { api, escHtml, toast } from '../utils.js';

// The work log tab.
//
// One merged list per day: time already in Jira, entries you have kept, and
// candidates detection is offering. Nothing reaches Jira without a click.

const state = {
  date: null,
  mode: 'day',
  config: null,
  sources: [],
  day: null,
  week: null,
  expanded: new Set(),
  busy: new Set(),
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
    return `
      <button class="worklog-chip ${cls}" title="${escHtml(title)}"
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

  return `<div class="worklog-sources">${chips}${errors}${renderCacheNote(current?.cache)}</div>`;
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
  const busy = state.busy.has(row.id);
  const disabled = busy ? 'disabled' : '';
  const id = escHtml(row.id);

  if (row.kind === 'jira') {
    return `<button class="btn btn-ghost btn-sm" onclick="adoptWorkLogJiraRow('${id}')" ${disabled}>Track locally</button>`;
  }

  const push = row.push || {};
  const parts = [];

  if (row.kind === 'candidate') {
    parts.push(`<button class="btn btn-ghost btn-sm" onclick="keepWorkLogRow('${id}')" ${disabled}>Keep</button>`);
    parts.push(`<button class="btn btn-primary btn-sm" onclick="pushWorkLogRow('${id}')" ${disabled}>${busy ? '…' : 'Log to Jira'}</button>`);
    parts.push(`<button class="btn btn-ghost btn-sm" onclick="dismissWorkLogRow('${id}')" ${disabled} title="Hide this suggestion">✕</button>`);
    return parts.join('');
  }

  if (push.state === 'pushed') {
    parts.push('<span class="worklog-action-note">logged</span>');
  } else if (push.state === 'stale') {
    parts.push(`<button class="btn btn-primary btn-sm" onclick="pushWorkLogRow('${id}')" ${disabled}>${busy ? '…' : 'Update Jira'}</button>`);
  } else {
    parts.push(`<button class="btn btn-primary btn-sm" onclick="pushWorkLogRow('${id}')" ${disabled}>${busy ? '…' : 'Log to Jira'}</button>`);
  }
  parts.push(`<button class="btn btn-ghost btn-sm" onclick="deleteWorkLogRow('${id}')" ${disabled} title="Remove this line">✕</button>`);
  return parts.join('');
}

function renderEvidence(row) {
  if (!state.expanded.has(row.id)) return '';
  const signals = row.evidence || [];
  if (!signals.length) {
    return `<tr class="worklog-evidence-row"><td colspan="${WORKLOG_COLUMNS}"><div class="worklog-evidence"><em>No recorded signals — this line was entered by hand.</em></div></td></tr>`;
  }

  const items = signals.slice(0, 40).map(signal => `
    <li>
      <span class="worklog-evidence-time">${escHtml(signal.wall || '')}</span>
      <span class="worklog-evidence-src">${SOURCE_ICONS[signal.source] || '•'} ${escHtml(signal.source)}</span>
      <span class="worklog-evidence-text">${escHtml(signal.text || '')}</span>
      ${signal.ref ? `<code>${escHtml(signal.ref)}</code>` : ''}
    </li>`).join('');

  const total = row.evidenceTotal ?? signals.length;
  const hidden = total - Math.min(signals.length, 40);
  const more = hidden > 0 ? `<li><em>…and ${hidden} more</em></li>` : '';
  const scaled = row.scaledFrom
    ? `<p class="worklog-evidence-note">Estimated ${fmtDuration(row.scaledFrom)} from activity, scaled down to fit the day.</p>`
    : '';
  const covered = row.coveredByJiraMinutes
    ? `<p class="worklog-evidence-warn">${escHtml(row.ticket || '')} already has ${fmtDuration(row.coveredByJiraMinutes)} in Jira for this day. Logging this too would double-count.</p>`
    : '';

  return `<tr class="worklog-evidence-row"><td colspan="${WORKLOG_COLUMNS}"><div class="worklog-evidence">${covered}${scaled}<ul>${items}${more}</ul></div></td></tr>`;
}

function renderRow(row) {
  const id = escHtml(row.id);
  const readOnly = row.kind === 'jira';
  const sourceMarks = Object.keys(row.sourceCounts || {})
    .map(s => `<span title="${escHtml(s)}">${SOURCE_ICONS[s] || '•'}</span>`).join('');

  const warn = row.coveredByJiraMinutes ? ' worklog-row-warn' : '';

  // Two rows per entry. The facts are narrow by nature — a time, a ticket, a
  // duration — while what you did is the part you actually write, so it gets a
  // row of its own, shared only with the note that goes to Jira. Squeezed
  // between six fixed columns it had barely a third of the table.
  return `
    <tr class="worklog-row worklog-row-facts worklog-row-${row.kind}${warn}">
      <td class="worklog-cell-time">
        <button class="worklog-expand" onclick="toggleWorkLogEvidence('${id}')" title="Show what this came from">
          ${state.expanded.has(row.id) ? '▾' : '▸'}
        </button>
        ${escHtml(row.startTime || '—')}
      </td>
      <td class="worklog-cell-ticket">
        ${readOnly
          ? `<strong>${escHtml(row.ticket || '—')}</strong>`
          : `<input class="worklog-input worklog-input-ticket" value="${escHtml(row.ticket || '')}"
                    placeholder="TICKET" onchange="editWorkLogRow('${id}','ticket',this.value)">`}
        ${!row.ticket && row.label ? `<div class="worklog-effort-name">${escHtml(row.label)}</div>` : ''}
      </td>
      <td class="worklog-cell-attention">${attentionChip(row)}</td>
      <td class="worklog-cell-duration">
        ${readOnly
          ? fmtDuration(row.minutes)
          : `<input class="worklog-input worklog-input-duration" value="${fmtDuration(row.minutes)}"
                    onchange="editWorkLogRow('${id}','minutes',this.value)">`}
      </td>
      <td class="worklog-cell-status">${pushBadge(row)}</td>
      <td class="worklog-cell-actions">${rowActions(row)}</td>
    </tr>
    <tr class="worklog-row worklog-row-said worklog-row-${row.kind}${warn}">
      <td class="worklog-cell-summary" colspan="${WORKLOG_COLUMNS}">
        <div class="worklog-said">
          ${readOnly
            ? `<div class="worklog-said-text">${escHtml(row.summary || '')}</div>`
            : `<textarea class="worklog-input worklog-input-summary" rows="1" placeholder="What you did"
                         oninput="growWorkLogField(this)"
                         onkeydown="if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); this.blur(); }"
                         onchange="editWorkLogRow('${id}','summary',this.value)">${escHtml(row.summary || '')}</textarea>`}
          <div class="worklog-note-line">
            <span class="worklog-note-label" title="Only this reaches Jira — the description beside it stays local">to Jira</span>
            ${readOnly
              ? escHtml(row.note || '—')
              : `<input class="worklog-input worklog-input-note" value="${escHtml(row.note || '')}"
                        placeholder="brief note" onchange="editWorkLogRow('${id}','note',this.value)">`}
            <span class="worklog-row-sources">${sourceMarks}</span>
          </div>
        </div>
      </td>
    </tr>
    ${renderEvidence(row)}
  `;
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
    : `<tr><td colspan="${WORKLOG_COLUMNS}"><div class="empty-state"><p>Nothing found for this day</p>
        <small>No commits, sessions or Jira time. Add a line by hand below, or turn on more sources.</small></div></td></tr>`;

  container.innerHTML = rows;
  growAllWorkLogFields();
  document.getElementById('worklog-summary').innerHTML = renderTotals(day.totals, day.jira || {});
  document.getElementById('worklog-attention').innerHTML = renderAttention(day.byAttention);
  document.getElementById('worklog-source-bar').innerHTML = renderSourceBar();
  document.getElementById('worklog-message').value = day.message || '';

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

function renderWeek() {
  const week = state.week;
  const container = document.getElementById('worklog-body');
  if (!week) return;

  const rows = week.days.map(day => {
    const logged = day.rows.filter(r => r.kind !== 'candidate').reduce((s, r) => s + r.minutes, 0);
    const suggested = day.rows.filter(r => r.kind === 'candidate').reduce((s, r) => s + r.minutes, 0);
    const tickets = [...new Set(day.rows.filter(r => r.kind !== 'candidate' && r.ticket).map(r => r.ticket))];
    return `
      <tr class="worklog-row">
        <td class="worklog-cell-time"><a href="#" onclick="openWorkLogDay('${day.date}');return false;">${escHtml(prettyDate(day.date))}</a></td>
        <td colspan="2" class="worklog-cell-summary">${tickets.length ? tickets.map(t => `<code>${escHtml(t)}</code>`).join(' ') : '<em>nothing logged</em>'}</td>
        <td class="worklog-cell-duration">${fmtDuration(logged)}</td>
        <td class="worklog-cell-status">${suggested ? `<span class="worklog-badge worklog-badge-candidate">+${fmtDuration(suggested)} suggested</span>` : ''}</td>
        <td class="worklog-cell-actions"><button class="btn btn-ghost btn-sm" onclick="openWorkLogDay('${day.date}')">Open</button></td>
      </tr>`;
  }).join('');

  container.innerHTML = rows;
  growAllWorkLogFields();

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
  document.getElementById('worklog-summary').innerHTML = renderTotals(totals, week.jira || {});
  document.getElementById('worklog-attention').innerHTML = renderAttention(weekAttention);
  document.getElementById('worklog-source-bar').innerHTML = renderSourceBar();
  document.getElementById('worklog-message').value = week.message || '';
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

export async function loadWorkLog(options = {}) {
  const body = document.getElementById('worklog-body');

  // Paint the date you asked for straight away. A cold read takes a minute, and
  // leaving the previous day on screen the whole time reads as a dead button.
  if (state.date) {
    renderHeader();
    document.getElementById('worklog-summary').innerHTML = '';
    document.getElementById('worklog-attention').innerHTML = '';
    document.getElementById('worklog-message').value = '';
  }

  const scope = state.mode === 'week' ? 'week' : 'day';
  body.innerHTML = `<tr><td colspan="${WORKLOG_COLUMNS}"><div class="empty-state"><p>Reading your ${scope}…</p><small>Scanning git, sessions and Jira, then describing the work.</small></div></td></tr>`;

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

    const refresh = options.refresh ? '?refresh=1' : '';
    if (state.mode === 'week') {
      state.week = await api('GET', `/api/worklog/week/${state.date}${refresh}`);
      renderHeader();
      renderWeek();
    } else {
      state.day = await api('GET', `/api/worklog/day/${state.date}${refresh}`);
      renderHeader();
      renderDay();
    }
  } catch (err) {
    body.innerHTML = `<tr><td colspan="${WORKLOG_COLUMNS}"><div class="empty-state"><p>Could not build the log</p><small>${escHtml(err.message)}</small></div></td></tr>`;
  }
}

function findRow(id) {
  return (state.day?.rows || []).find(r => r.id === id) || null;
}

// A candidate is only a suggestion until it is saved. Anything that acts on
// one — editing, keeping, logging — makes it a real entry first.
async function materialize(row) {
  if (row.kind !== 'candidate') return row.id;
  const saved = await api('POST', `/api/worklog/day/${state.date}/entries`, {
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
  });
  return saved.id;
}

// --------------------------------------------------------------------- actions

export async function editWorkLogRow(id, field, value) {
  const row = findRow(id);
  if (!row) return;

  const patch = {};
  if (field === 'minutes') patch.minutes = parseDuration(value);
  else if (field === 'ticket') patch.ticket = value.trim().toUpperCase();
  else patch[field] = value;

  try {
    if (row.kind === 'candidate') {
      const entryId = await materialize({ ...row, ...patch });
      await api('PUT', `/api/worklog/day/${state.date}/entries/${entryId}`, patch);
    } else {
      await api('PUT', `/api/worklog/day/${state.date}/entries/${id}`, patch);
    }
    await loadWorkLog();
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function keepWorkLogRow(id) {
  const row = findRow(id);
  if (!row) return;
  try {
    await materialize(row);
    toast('Kept in your log');
    await loadWorkLog();
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function dismissWorkLogRow(id) {
  const row = findRow(id);
  if (!row?.candidateKey) return;
  try {
    await api('POST', `/api/worklog/day/${state.date}/dismiss`, { candidateKey: row.candidateKey });
    await loadWorkLog();
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function deleteWorkLogRow(id) {
  const row = findRow(id);
  if (!row) return;
  if (row.push?.state === 'pushed' && !confirm(
    `This line is logged in Jira as worklog ${row.push.worklogId}.\n\n`
    + 'Removing it here does NOT remove it from Jira — delete it there too if that is what you want.\n\nRemove the local line?')) {
    return;
  }
  try {
    await api('DELETE', `/api/worklog/day/${state.date}/entries/${id}`);
    await loadWorkLog();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// The only thing in this tab that writes to Jira, and it asks first.
export async function pushWorkLogRow(id) {
  const row = findRow(id);
  if (!row) return;

  if (!row.ticket) {
    toast('Give this line a ticket before logging it', 'error');
    return;
  }

  const updating = row.push?.state === 'stale' || row.push?.worklogId;
  const warning = row.coveredByJiraMinutes && !updating
    ? `\n\nNote: ${row.ticket} already has ${fmtDuration(row.coveredByJiraMinutes)} logged today.`
    : '';

  const note = (row.note || '').trim();
  const noteLine = `\n\nNote posted to the ticket: ${note ? `"${note}"` : '(none)'}`;
  const question = updating
    ? `Update the Jira worklog on ${row.ticket} to ${fmtDuration(row.minutes)}?${noteLine}`
    : `Log ${fmtDuration(row.minutes)} to ${row.ticket} on ${state.date}?${noteLine}${warning}`;

  if (!confirm(question)) return;

  state.busy.add(id);
  renderDay();

  try {
    const entryId = await materialize(row);
    const result = await api('POST', `/api/worklog/day/${state.date}/entries/${entryId}/push`, { confirm: true });
    toast(`${updating ? 'Updated' : 'Logged'} ${fmtDuration(result.jira.minutes)} on ${row.ticket}`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.busy.delete(id);
    await loadWorkLog();
  }
}

export async function adoptWorkLogJiraRow(id) {
  const row = findRow(id);
  if (!row?.jira) return;
  try {
    await api('POST', `/api/worklog/day/${state.date}/entries`, {
      date: state.date,
      ticket: row.ticket,
      minutes: row.minutes,
      summary: row.summary,
      startTime: row.startTime,
      origin: 'manual',
      push: { state: 'pushed', worklogId: row.jira.worklogId, pushedMinutes: row.minutes, pushedAt: row.jira.started },
    });
    await loadWorkLog();
  } catch (err) {
    toast(err.message, 'error');
  }
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

  try {
    await api('POST', `/api/worklog/day/${state.date}/entries`, {
      date: state.date,
      ticket: ticket.value.trim().toUpperCase() || null,
      summary: summaryField.value.trim(),
      // A hand-typed line still needs something terse for the ticket; fall
      // back to the description rather than pushing an empty comment.
      note: noteField.value.trim() || summaryField.value.trim().slice(0, 60),
      minutes,
      origin: 'manual',
    });
    ticket.value = '';
    summaryField.value = '';
    noteField.value = '';
    duration.value = '';
    await loadWorkLog();
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function toggleWorkLogEvidence(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  if (state.mode === 'day') renderDay();
}

export async function toggleWorkLogSource(sourceId) {
  const source = state.sources.find(s => s.id === sourceId);
  if (!source || !source.available) return;
  try {
    const result = await api('PUT', '/api/worklog/config', { sources: { [sourceId]: !source.enabled } });
    state.config = result.config;
    state.sources = result.sources;
    await loadWorkLog({ refresh: true });
  } catch (err) {
    toast(err.message, 'error');
  }
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
  loadWorkLog({ refresh: true });
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
