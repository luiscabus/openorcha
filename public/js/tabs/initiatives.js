import { api, toast, escHtml, escAttr } from '../utils.js';
import { simpleMarkdown } from './agentShared.js';

let initiatives = [];
let templates = [];
let selectedTemplate = 'ticket-to-pr';
let pendingCriteria = null;
let outcomeCache = {};
let openTranscript = null;   // { workerId, messages, worker, total }
let stream = null;           // { id, entries, talkingTo, sending, waitingSince }
let streamPoll = null;
let showSupervisorDetail = false;
let detailsOpen = false;
let atBottom = true;
let selectedId = null;
let refreshTimer = null;

const STATUS_LABELS = {
  draft: 'Draft',
  running: 'Running',
  blocked: 'Needs you',
  paused: 'Paused',
  cancelled: 'Stopped',
  done: 'Done',
  failed: 'Failed',
};

// ─── Loading ─────────────────────────────────────────────────────────────────

export async function loadInitiatives({ background = false } = {}) {
  const list = document.getElementById('initiatives-list');
  try {
    const data = await api('GET', '/api/initiatives');
    initiatives = data.initiatives || [];
    templates = data.templates || templates;
    if (!initiatives.some(i => i.id === selectedId)) {
      selectedId = initiatives.find(i => i.status === 'blocked')?.id || initiatives[0]?.id || null;
    }
    renderList(list);
    if (background && isBusyInDetail()) {
      // You are typing or have text in a field. Re-rendering the panel would
      // throw it away, and no refresh is worth that.
      renderNeedsYou();
      return;
    }
    renderDetail();
    renderNeedsYou();
    renderTrash();
    if (selectedId && (!stream || stream.id !== selectedId)) loadStream(selectedId, { first: true });
  } catch (err) {
    list.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

export function startInitiativesAutoRefresh() {
  clearInitiativesAutoRefresh();
  refreshTimer = setInterval(() => loadInitiatives({ background: true }), 8000);
}

export function clearInitiativesAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  stopStreamPoll();
}

// ─── List ────────────────────────────────────────────────────────────────────

function renderList(container) {
  if (!initiatives.length) {
    container.innerHTML = `<div class="drawer-empty">
      No initiatives yet.<br><small>An initiative is a piece of work the supervisor drives on its own — it approves safe prompts, keeps the agent moving through stages, and only stops you for decisions that matter.</small>
    </div>`;
    return;
  }

  container.innerHTML = initiatives.map(i => {
    const done = i.stages.filter(s => s.status === 'done').length;
    const gates = (i.openGates || []).length;
    const stage = i.currentStage;
    return `<div class="initiative-item${i.id === selectedId ? ' is-selected' : ''}" onclick="selectInitiative('${escAttr(i.id)}')">
      <div class="initiative-item-top">
        <span class="initiative-status initiative-status-${escAttr(i.status)}">${escHtml(STATUS_LABELS[i.status] || i.status)}</span>
        <span class="initiative-item-name">${escHtml(i.name)}</span>
        ${gates ? `<span class="initiative-gate-count">${gates}</span>` : ''}
      </div>
      <div class="initiative-item-meta">
        <span>${escHtml(stage?.name || '—')}</span>
        <span class="initiative-progress"><span style="width:${Math.round((done / i.stages.length) * 100)}%"></span></span>
        <span>${done}/${i.stages.length}</span>
        ${i.liveWorkers ? `<span class="initiative-worker-count" title="agents working in parallel">${i.liveWorkers}×</span>` : ''}
      </div>
      <div class="initiative-item-path">${escHtml(tildefy(i.cwd))}</div>
    </div>`;
  }).join('');
}

function renderNeedsYou() {
  const el = document.getElementById('initiatives-needs-you');
  const gates = initiatives.flatMap(i => (i.openGates || []).map(g => ({ ...g, initiative: i })));
  if (!gates.length) {
    el.innerHTML = '<span class="initiatives-clear">Nothing waiting on you</span>';
    return;
  }
  el.innerHTML = `<button class="btn btn-sm initiatives-needs-btn" onclick="selectInitiative('${escAttr(gates[0].initiative.id)}')">
    ${gates.length} decision${gates.length === 1 ? '' : 's'} waiting
  </button>`;
}

function renderTrash() {
  const el = document.getElementById('initiatives-trash');
  if (!el || el.dataset.rendered === '1') return;
  el.dataset.rendered = '1';
  el.innerHTML = `<details class="initiatives-trash" ontoggle="if(this.open)window.loadTrash()">
    <summary>Recently removed</summary>
    <div id="trash-body"></div>
  </details>`;
}

let trashLoading = false;

/** Fetched when you open it, not every eight seconds to render a number. */
export async function loadTrash() {
  const body = document.getElementById('trash-body');
  if (!body || trashLoading) return;
  trashLoading = true;
  body.innerHTML = '<div class="drawer-loading">Loading…</div>';
  try {
    const trash = (await api('GET', '/api/initiatives/trash')).trash || [];
    body.innerHTML = trash.length
      ? trash.map(t => `<div class="trash-row">
          <span class="trash-name">${escHtml(t.name)}</span>
          <span class="trash-meta">${escHtml(t.stage || '')} · removed ${escHtml(timeAgo(t.deletedAt))}</span>
          <button class="btn btn-ghost btn-sm" onclick="restoreInitiative('${escAttr(t.file)}')">Restore</button>
        </div>`).join('')
      : '<div class="drawer-empty">Nothing removed recently.</div>';
  } catch (err) {
    body.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  } finally {
    trashLoading = false;
  }
}

export async function restoreInitiative(file) {
  try {
    const data = await api('POST', `/api/initiatives/trash/${encodeURIComponent(file)}/restore`);
    selectedId = data.initiative.id;
    toast(`Restored "${data.initiative.name}"`);
    await loadInitiatives();
    if (document.getElementById('trash-body')) loadTrash();
  } catch (err) { toast(err.message, 'error'); }
}

// ─── Detail ──────────────────────────────────────────────────────────────────

/** True while a text field in the panel is focused or holds unsent text. */
function isBusyInDetail() {
  const panel = document.getElementById('initiative-detail');
  if (!panel) return false;
  const active = document.activeElement;
  if (active && panel.contains(active) && /^(INPUT|TEXTAREA)$/.test(active.tagName)) return true;
  return [...panel.querySelectorAll('input[type="text"], textarea')].some(el => el.value.trim());
}

/**
 * What the panel looked like before a re-render: typed text, where the caret
 * was, and how far things were scrolled. innerHTML throws all of that away.
 */
function captureDetailState() {
  const panel = document.getElementById('initiative-detail');
  if (!panel) return null;
  const active = document.activeElement;
  const fields = [];
  panel.querySelectorAll('input, textarea').forEach((el, index) => {
    const key = el.id || `${el.tagName}:${index}`;
    fields.push({
      key,
      value: el.value,
      focused: el === active,
      start: el.selectionStart,
      end: el.selectionEnd,
    });
  });
  const scrolls = [];
  panel.querySelectorAll('.transcript, .initiative-timeline, .stream').forEach((el, index) => {
    scrolls.push({ key: `${el.className}:${index}`, top: el.scrollTop });
  });
  return { fields, scrolls, panelTop: panel.scrollTop };
}

function restoreDetailState(state) {
  if (!state) return;
  const panel = document.getElementById('initiative-detail');
  if (!panel) return;

  const inputs = [...panel.querySelectorAll('input, textarea')];
  inputs.forEach((el, index) => {
    const key = el.id || `${el.tagName}:${index}`;
    const saved = state.fields.find(f => f.key === key);
    if (!saved || !saved.value) return;
    el.value = saved.value;
    if (saved.focused) {
      el.focus();
      try { el.setSelectionRange(saved.start ?? el.value.length, saved.end ?? el.value.length); } catch {}
    }
  });

  panel.querySelectorAll('.transcript, .initiative-timeline, .stream').forEach((el, index) => {
    const saved = state.scrolls.find(sc => sc.key === `${el.className}:${index}`);
    if (saved) el.scrollTop = saved.top;
  });
  panel.scrollTop = state.panelTop;
}

function renderDetail() {
  const state = captureDetailState();
  renderDetailInner();
  restoreDetailState(state);
  watchStreamScroll();
  // A rebuilt panel starts at scrollTop 0. If you were following the newest
  // message, keep following it.
  if (atBottom) scrollStreamToBottom();
  if (selectedId && !streamPoll) startStreamPoll(selectedId);
}

function renderDetailInner() {
  const el = document.getElementById('initiative-detail');
  const i = initiatives.find(x => x.id === selectedId);
  if (!i) {
    el.innerHTML = '<div class="drawer-empty">Select an initiative.</div>';
    return;
  }

  const live = i.liveWorkers
    ? `<span class="initiative-live initiative-live-${escAttr(i.live.status)}">${i.liveWorkers} agent${i.liveWorkers === 1 ? '' : 's'} working</span>`
    : '<span class="initiative-live initiative-live-none">no live agent</span>';

  el.innerHTML = `
    <div class="initiative-detail-header">
      <div>
        <h3>${escHtml(i.name)}</h3>
        <div class="initiative-detail-sub">
          <span class="initiative-status initiative-status-${escAttr(i.status)}">${escHtml(STATUS_LABELS[i.status] || i.status)}</span>
          ${live}
          <span class="initiative-detail-path">${escHtml(tildefy(i.cwd))}</span>
          <span class="badge badge-sm">${escHtml(i.profile)}</span>
          ${i.template ? `<span class="badge badge-sm">${escHtml(i.template)}</span>` : ''}
        </div>
      </div>
      <div class="initiative-detail-actions">
        ${['running', 'blocked'].includes(i.status)
          ? `<button class="btn btn-ghost btn-sm" onclick="pauseInitiative('${escAttr(i.id)}')" title="Stop supervising, leave the agents running">Pause</button>`
          : `<button class="btn btn-primary btn-sm" onclick="startInitiative('${escAttr(i.id)}')">${(i.workers || []).length ? 'Resume' : 'Start'}</button>`}
        ${i.liveWorkers || ['running', 'blocked', 'paused'].includes(i.status)
          ? `<button class="btn btn-ghost btn-sm" onclick="stopInitiative('${escAttr(i.id)}')" title="End the run and kill its agents">Stop</button>`
          : ''}
        <button class="btn btn-ghost btn-sm" onclick="openSplitStage('${escAttr(i.id)}')">Split stage</button>
        <button class="btn btn-ghost btn-sm" onclick="runInitiativeCheck('${escAttr(i.id)}')">Run check</button>
        <button class="btn btn-ghost btn-sm" onclick="advanceInitiative('${escAttr(i.id)}')">Skip stage</button>
        <button class="btn btn-ghost btn-sm" onclick="deleteInitiative('${escAttr(i.id)}')">Delete</button>
      </div>
    </div>

    ${i.goal ? `<p class="initiative-goal">${escHtml(i.goal)}</p>` : ''}

    ${renderStatusStrip(i)}

    <div class="stream" id="initiative-stream">${renderStream(i)}</div>

    ${renderComposer(i)}

    <details class="initiative-details"${detailsOpen ? ' open' : ''} ontoggle="window.setDetailsOpen(this.open)">
      <summary>Plan, definition of done, and what it produced</summary>
      <div class="initiative-details-body">
        ${renderAcceptance(i)}
        ${renderStages(i)}
        ${renderStats(i)}
        <div id="initiative-outcome">${renderOutcome(i)}</div>
      </div>
    </details>

  `;

  // Refetch only when the run has moved on: churning this while you read is
  // as disruptive as clearing an input.
  if (detailsOpen && outcomeCache[i.id]?.forVersion !== i.updatedAt) loadOutcome(i.id, i.updatedAt);
}

export function setDetailsOpen(open) {
  detailsOpen = open;
  if (!open) return;
  const i = initiatives.find(x => x.id === selectedId);
  if (i && outcomeCache[i.id]?.forVersion !== i.updatedAt) loadOutcome(i.id, i.updatedAt);
}

export function toggleSupervisorDetail() {
  showSupervisorDetail = !showSupervisorDetail;
  loadStream(selectedId, { force: true });
}

async function loadOutcome(id, forVersion) {
  if (outcomeCache[id]?.loading) return;
  outcomeCache[id] = { ...(outcomeCache[id] || {}), loading: true };
  try {
    const { outcome } = await api('GET', `/api/initiatives/${id}/outcome`);
    outcomeCache[id] = { ...outcome, forVersion, loading: false };
    if (selectedId === id && detailsOpen) {
      const el = document.getElementById('initiative-outcome');
      if (el) el.innerHTML = renderOutcome(initiatives.find(x => x.id === id));
    }
  } catch (err) {
    outcomeCache[id] = { loading: false, forVersion, error: err.message };
    const el = document.getElementById('initiative-outcome');
    if (el) el.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

// ─── The run, as one live stream ─────────────────────────────────────────────

function renderStatusStrip(i) {
  const done = i.stages.filter(x => x.status === 'done').length;
  const pct = Math.round((done / i.stages.length) * 100);
  const met = (i.acceptance || []).filter(c => c.status === 'met' || c.status === 'waived').length;
  const who = stream?.talkingTo;
  const gates = (i.openGates || []).length;

  return `<div class="strip">
    <div class="strip-progress" title="${escAttr(i.stages.map(x => x.name).join(' → '))}">
      <div class="strip-bar"><span style="width:${pct}%"></span></div>
      <div class="strip-stage">${escHtml(i.currentStage?.name || '—')} <em>${done}/${i.stages.length}</em></div>
    </div>
    ${(i.acceptance || []).length ? `<div class="strip-item"><strong>${met}/${i.acceptance.length}</strong> criteria</div>` : ''}
    <div class="strip-item"><strong>${i.liveWorkers || 0}</strong> agent${i.liveWorkers === 1 ? '' : 's'} live</div>
    ${who ? `<div class="strip-item strip-who">talking to <strong>${escHtml(who.name)}</strong>
      <span class="chat-status chat-status-${escAttr(who.live ? who.status : 'gone')}">${escHtml(who.live ? who.status : 'not running')}</span></div>` : ''}
    ${gates ? `<div class="strip-item strip-gates">${gates} waiting on you</div>` : ''}
    <button class="btn btn-ghost btn-sm strip-detail" onclick="toggleSupervisorDetail()">${showSupervisorDetail ? 'Less' : 'More'} detail</button>
  </div>`;
}

function renderStream(i) {
  if (!stream || stream.id !== i.id) return '<div class="drawer-loading">Loading the run…</div>';

  const entries = stream.entries || [];
  return `${entries.length ? entries.map(e => renderStreamEntry(i, e)).join('') : '<div class="drawer-empty">Nothing has happened yet.</div>'}
    ${stream.sending ? `<div class="stream-turn stream-you stream-optimistic">
        <div class="chat-bubble">${escHtml(stream.sending)}</div>
        <div class="chat-meta">sending…</div>
      </div>` : ''}
    ${stream.waitingSince ? `<div class="chat-waiting">${escHtml(stream.talkingTo?.name || 'it')} is thinking<span class="chat-elapsed">${Math.round((Date.now() - stream.waitingSince) / 1000)}s</span></div>` : ''}`;
}

function renderStreamEntry(i, e) {
  if (e.kind === 'you' || e.kind === 'agent') {
    return `<div class="stream-turn stream-${e.kind === 'you' ? 'you' : 'them'}">
      <div class="chat-bubble">${e.text ? simpleMarkdown(e.text) : ''}
        ${e.tools?.length ? `<div class="transcript-tools">${e.tools.map(x => `<code>${escHtml(x)}</code>`).join(' ')}</div>` : ''}
      </div>
      <div class="chat-meta">${e.kind === 'you' ? 'you' : escHtml(e.who || 'agent')}${e.at ? ` · ${escHtml(shortTime(e.at))}` : ''}</div>
    </div>`;
  }

  if (e.kind === 'gate') {
    return e.open ? renderOpenGate(i, e) : `<div class="stream-event stream-event-answered">
      <span class="stream-dot"></span>
      <span class="stream-event-label">Answered</span>
      <span class="stream-event-text">${escHtml(e.answer || '')}${e.answeredBy === 'auto' ? ' (taken automatically)' : ''}</span>
      <span class="stream-event-time">${escHtml(shortTime(e.resolvedAt || e.at))}</span>
    </div>`;
  }

  if (e.kind === 'plumbing') {
    return `<div class="stream-event stream-event-plumbing">
      <span class="stream-dot"></span>
      <span class="stream-event-text">${escHtml((e.text || '').slice(0, 220))}</span>
      <span class="stream-event-time">${escHtml(shortTime(e.at))}</span>
    </div>`;
  }

  return `<div class="stream-event stream-event-${escAttr(e.severity || 'normal')}">
    <span class="stream-dot"></span>
    <span class="stream-event-label">${escHtml(e.label)}${e.count > 1 ? ` ×${e.count}` : ''}</span>
    ${e.stage ? `<span class="stream-event-stage">${escHtml(e.stage)}</span>` : ''}
    <span class="stream-event-text">${escHtml((e.text || '').slice(0, 200))}</span>
    <span class="stream-event-time">${escHtml(shortTime(e.at))}</span>
  </div>`;
}

/** A gate is a moment in the story, answered where it happened. */
function renderOpenGate(i, e) {
  return `<div class="stream-gate">
    <div class="stream-gate-head">
      <span>${escHtml(e.gateKind)} · needs you</span>
      <span>${escHtml(timeAgo(e.at))}</span>
    </div>
    <div class="stream-gate-question">${escHtml(e.question)}</div>
    ${e.reason ? `<div class="stream-gate-reason">${escHtml(e.reason)}</div>` : ''}
    ${e.command ? `<pre class="initiative-gate-command">${escHtml(e.command)}</pre>` : ''}
    ${e.context ? `<div class="initiative-gate-context">${escHtml(e.context)}</div>` : ''}
    <div class="initiative-gate-options">
      ${(e.options || []).map(o => `<button class="btn btn-sm${o === e.defaultOption ? ' btn-primary' : ''}" onclick="answerGate('${escAttr(i.id)}','${escAttr(e.gateId)}','${escAttr(o)}')">${escHtml(o)}</button>`).join('')}
    </div>
    <form class="initiative-gate-free" onsubmit="answerGateFree(event, '${escAttr(i.id)}','${escAttr(e.gateId)}')">
      <input type="text" placeholder="…or answer in your own words" />
      <button type="submit" class="btn btn-ghost btn-sm">Answer</button>
    </form>
    ${e.defaultOption ? `<div class="initiative-gate-default">Unanswered, it takes "${escHtml(e.defaultOption)}".</div>` : ''}
  </div>`;
}

function renderComposer(i) {
  const who = stream?.talkingTo;
  return `<form class="chat-compose" onsubmit="sendChat(event, '${escAttr(i.id)}')">
      <textarea id="chat-input" rows="2" placeholder="${escAttr(who ? `Message ${who.name}…` : 'Nothing is running — this will be held for the next agent')}" onkeydown="chatKeydown(event, '${escAttr(i.id)}')"></textarea>
      <button type="submit" class="btn btn-primary btn-sm">Send</button>
    </form>
    ${(i.pendingMessages || []).length ? `<div class="initiative-pending">${(i.pendingMessages || []).length} message(s) waiting for the next agent</div>` : ''}
    <div class="chat-hint">Enter sends · Shift+Enter for a new line</div>`;
}

async function loadStream(id, { first = false, force = false } = {}) {
  if (!id) return;
  try {
    const data = await api('GET', `/api/initiatives/${id}/timeline${showSupervisorDetail ? '?detail=all' : ''}`);
    const before = stream?.id === id ? (stream.entries || []).filter(e => e.kind === 'agent').length : 0;
    const answered = data.entries.filter(e => e.kind === 'agent').length > before;

    stream = {
      id,
      entries: data.entries,
      talkingTo: data.talkingTo,
      pending: data.pending,
      sending: stream?.id === id ? stream.sending : null,
      waitingSince: answered ? null : (stream?.id === id ? stream.waitingSince : null),
    };

    if (selectedId !== id) return;
    const el = document.getElementById('initiative-stream');
    if (!el) return;
    const goToBottom = first || force || atBottom;
    const i = initiatives.find(x => x.id === id);
    if (i) el.innerHTML = renderStream(i);
    watchStreamScroll();
    if (goToBottom) scrollStreamToBottom();
  } catch (err) {
    if (!first) return;
    const el = document.getElementById('initiative-stream');
    if (el) el.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

/**
 * Scroll once the browser has laid the content out. Setting scrollTop in the
 * same frame as innerHTML lands on a stale height, which is why the stream did
 * not reliably open at the newest message.
 */
function scrollStreamToBottom() {
  const el = document.getElementById('initiative-stream');
  if (!el) return;
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; atBottom = true; });
  });
}

function watchStreamScroll() {
  const el = document.getElementById('initiative-stream');
  if (!el || el.dataset.watching === '1') return;
  el.dataset.watching = '1';
  el.addEventListener('scroll', () => {
    atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
  });
}

/** While you are looking at a run it keeps up on its own. */
function startStreamPoll(id) {
  stopStreamPoll();
  streamPoll = setInterval(() => loadStream(id), 5000);
}

function stopStreamPoll() {
  if (streamPoll) clearInterval(streamPoll);
  streamPoll = null;
}

export function chatKeydown(event, id) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendChat(event, id);
  }
}

export async function sendChat(event, id) {
  if (event?.preventDefault) event.preventDefault();
  const input = document.getElementById('chat-input');
  const message = (input?.value || '').trim();
  if (!message) return;

  input.value = '';
  if (stream?.id === id) {
    stream.sending = message;
    const i = initiatives.find(x => x.id === id);
    const el = document.getElementById('initiative-stream');
    if (el && i) el.innerHTML = renderStream(i);
    atBottom = true;
    scrollStreamToBottom();
  }

  try {
    const data = await api('POST', `/api/initiatives/${id}/chat`, { message });
    if (stream?.id === id) {
      stream.sending = null;
      stream.waitingSince = data.delivered ? Date.now() : null;
    }
    if (!data.delivered) toast(data.note, 'error');
  } catch (err) {
    if (stream?.id === id) stream.sending = null;
    toast(err.message, 'error');
  }
  await loadStream(id, { force: true });
}

function renderOutcome(i) {
  const o = outcomeCache[i.id];
  if (!o || o.loading || !o.workers) {
    return o?.error
      ? `<div class="drawer-empty" style="color:var(--danger)">${escHtml(o.error)}</div>`
      : '<div class="drawer-loading">Reading what the run has produced…</div>';
  }

  const commits = o.repos.flatMap(r => r.work.commits.map(c => ({ ...c, tree: r.label })));
  const files = o.repos.flatMap(r => r.work.committed.map(f => ({ ...f, tree: r.label })));
  const dirty = o.repos.flatMap(r => r.work.uncommitted.map(f => ({ ...f, tree: r.label })));

  return `
    <div class="outcome-tiles">
      <div class="outcome-tile"><strong>${o.stagesDone.length}</strong><span>stages done</span></div>
      <div class="outcome-tile"><strong>${o.criteriaMet}/${o.criteriaTotal}</strong><span>criteria met</span></div>
      <div class="outcome-tile"><strong>${o.totals.commits}</strong><span>commits</span></div>
      <div class="outcome-tile"><strong>${o.totals.files}</strong><span>files changed</span></div>
      <div class="outcome-tile"><strong>${o.workers.reduce((n, w) => n + w.turns, 0)}</strong><span>agent turns</span></div>
    </div>

    ${o.prs.length ? `<div class="outcome-block">
      <div class="outcome-head">Pull requests</div>
      ${o.prs.map(pr => `<div class="outcome-row"><a href="${escAttr(pr.url)}" target="_blank" rel="noreferrer">#${pr.number}${pr.isDraft ? ' (draft)' : ''}</a> <span>${escHtml(pr.title || '')}</span></div>`).join('')}
    </div>` : ''}

    ${o.deliverables.length ? `<div class="outcome-block">
      <div class="outcome-head">Deliverables the definition of done asks for</div>
      ${o.deliverables.map(d => `<div class="outcome-row outcome-${d.exists ? 'present' : 'missing'}">
        <code>${escHtml(d.path)}</code>
        <span>${d.exists ? `${d.bytes} bytes` : 'not written yet'}</span>
      </div>`).join('')}
    </div>` : ''}

    ${commits.length ? `<div class="outcome-block">
      <div class="outcome-head">Commits from this run</div>
      ${commits.slice(0, 12).map(c => `<div class="outcome-row"><code>${escHtml(c.sha)}</code> <span>${escHtml(c.subject)}</span> <em>${escHtml(c.when)}</em></div>`).join('')}
      ${commits.length > 12 ? `<div class="outcome-more">…and ${commits.length - 12} more</div>` : ''}
    </div>` : ''}

    ${files.length ? `<div class="outcome-block">
      <div class="outcome-head">Files it changed</div>
      ${files.slice(0, 14).map(f => `<div class="outcome-row"><code>${escHtml(f.file)}</code> <span class="outcome-diffstat">+${f.added} −${f.removed}</span></div>`).join('')}
      ${files.length > 14 ? `<div class="outcome-more">…and ${files.length - 14} more</div>` : ''}
    </div>` : ''}

    ${dirty.length ? `<div class="outcome-block">
      <div class="outcome-head">Uncommitted, still in the working tree</div>
      ${dirty.slice(0, 10).map(f => `<div class="outcome-row"><code>${escHtml(f.file)}</code> <span>${escHtml(f.state)}</span></div>`).join('')}
    </div>` : ''}

    <div class="outcome-block">
      <div class="outcome-head">
        Agents &amp; conversations
        <button class="btn btn-ghost btn-sm" onclick="toggleOrchestrator('${escAttr(i.id)}', ${hasOrchestrator(i) ? 'false' : 'true'})">${hasOrchestrator(i) ? 'Turn off orchestrator' : 'Add orchestrator'}</button>
      </div>
      ${i.useOrchestrator && !hasOrchestrator(i) ? `<div class="outcome-agent outcome-agent-pending">
        <div class="outcome-agent-head">
          <span class="initiative-worker-dot initiative-worker-starting"></span>
          <span class="outcome-agent-name">Orchestrator</span>
          <span class="outcome-agent-meta">${escHtml(orchestratorWaitReason(i))}</span>
        </div>
      </div>` : ''}
      ${o.workers.length ? o.workers.map(w => `<div class="outcome-agent">
        <div class="outcome-agent-head">
          <span class="outcome-agent-name">${escHtml(w.name)}</span>
          ${w.role === 'orchestrator' ? '<span class="initiative-worker-role">orchestrator</span>' : ''}
          ${w.branch ? `<span class="initiative-worker-branch">${escHtml(w.branch)}</span>` : ''}
          <span class="outcome-agent-meta">${w.turns} turns · ${w.toolCalls} tool calls · ${escHtml(liveLabel(i, w))}</span>
          ${w.hasTranscript
            ? `<button class="btn btn-ghost btn-sm" onclick="toggleTranscript('${escAttr(i.id)}','${escAttr(w.workerId)}')">${openTranscript?.workerId === w.workerId ? 'Hide' : 'Read'}</button>`
            : '<span class="outcome-agent-meta">no transcript</span>'}
        </div>
        ${w.lastSaid ? `<div class="outcome-agent-last">${simpleMarkdown(w.lastSaid)}</div>` : ''}
        ${openTranscript?.workerId === w.workerId ? renderTranscript() : ''}
      </div>`).join('') : '<div class="drawer-empty">No agents have run yet.</div>'}
    </div>`;
}

function hasOrchestrator(i) {
  return (i.workers || []).some(w => w.role === 'orchestrator' && w.status !== 'gone');
}

/** Why it is not here yet — the last thing the run recorded about it. */
function orchestratorWaitReason(i) {
  const note = [...(i.events || [])].reverse()
    .find(e => /orchestrator/i.test(e.detail || '') && ['error', 'warning'].includes(e.type));
  if (note) return note.detail;
  if (['draft'].includes(i.status)) return 'starts when you start the run';
  if (['cancelled', 'failed'].includes(i.status)) return 'the run is stopped';
  return 'starting…';
}

function liveLabel(i, w) {
  const worker = (i.workers || []).find(x => x.id === w.workerId);
  if (worker?.live) return worker.live.status;
  return w.status === 'working' ? 'no agent' : w.status;
}

function renderTranscript() {
  const t = openTranscript;
  if (!t) return '';
  if (!t.messages) return '<div class="drawer-loading">Loading the conversation…</div>';

  // Consecutive turns that only ran tools are folded together: six separate
  // "agent · Bash" blocks with nothing in them is not a conversation.
  const blocks = [];
  for (const m of t.messages) {
    const toolOnly = !String(m.text || '').trim() && (m.tools || []).length;
    const last = blocks[blocks.length - 1];
    if (toolOnly && last?.kind === 'tools' && last.role === m.role) {
      last.tools.push(...m.tools);
      last.until = m.timestamp || last.until;
      continue;
    }
    if (toolOnly) {
      blocks.push({ kind: 'tools', role: m.role, tools: [...m.tools], at: m.timestamp, until: m.timestamp });
      continue;
    }
    blocks.push({ kind: 'say', role: m.role, text: m.text, tools: m.tools || [], at: m.timestamp });
  }

  return `<div class="transcript">
    <div class="transcript-head">${t.messages.length} of ${t.total} turns${t.worker?.live ? ' · live' : ''}</div>
    ${blocks.map(b => b.kind === 'tools'
      ? `<details class="transcript-work">
          <summary>${escHtml(toolSummary(b.tools))}${b.at ? ` · ${escHtml(shortTime(b.at))}` : ''}</summary>
          ${b.tools.slice(0, 40).map(x => `<div class="transcript-tool-row"><code>${escHtml(x.name)}</code><span>${escHtml(x.detail || '')}</span></div>`).join('')}
        </details>`
      : `<div class="transcript-turn transcript-${escAttr(b.role)}">
          <div class="transcript-role">${b.role === 'assistant' ? 'agent' : 'sent to it'}${b.at ? ` · ${escHtml(shortTime(b.at))}` : ''}</div>
          ${b.text ? `<div class="transcript-text">${simpleMarkdown(b.text.slice(0, 2500))}</div>` : ''}
          ${b.tools.length ? `<div class="transcript-tools">${b.tools.map(x => `<code title="${escAttr(x.detail || '')}">${escHtml(x.name)}</code>`).join(' ')}</div>` : ''}
        </div>`).join('')}
  </div>`;
}

function toolSummary(tools) {
  const counts = {};
  for (const t of tools) counts[t.name] = (counts[t.name] || 0) + 1;
  const parts = Object.entries(counts).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
  const first = tools.find(t => t.detail)?.detail;
  return `worked: ${parts.join(', ')}${first ? ` — ${first.slice(0, 90)}` : ''}`;
}

export async function toggleTranscript(id, workerId) {
  if (openTranscript?.workerId === workerId) {
    openTranscript = null;
    renderDetail();
    return;
  }
  openTranscript = { workerId, messages: null };
  renderDetail();
  try {
    const data = await api('GET', `/api/initiatives/${id}/transcript?workerId=${encodeURIComponent(workerId)}`);
    openTranscript = { workerId, messages: data.messages, worker: data.worker, total: data.total };
  } catch (err) {
    openTranscript = { workerId, messages: [], total: 0 };
    toast(err.message, 'error');
  }
  renderDetail();
}

function renderGates(i) {
  const gates = i.openGates || [];
  if (!gates.length) return '';
  return `<div class="initiative-gates">
    ${gates.map(g => `<div class="initiative-gate">
      <div class="initiative-gate-head">
        <span class="initiative-gate-kind">${escHtml(g.kind)}</span>
        <span class="initiative-gate-age">${escHtml(timeAgo(g.createdAt))}</span>
      </div>
      <div class="initiative-gate-question">${escHtml(g.question)}</div>
      ${g.reason ? `<div class="initiative-gate-reason">${escHtml(g.reason)}</div>` : ''}
      ${g.command ? `<pre class="initiative-gate-command">${escHtml(g.command)}</pre>` : ''}
      ${g.context ? `<div class="initiative-gate-context">${escHtml(g.context)}</div>` : ''}
      <div class="initiative-gate-options">
        ${(g.options || []).map(o => `<button class="btn btn-sm${o === g.defaultOption ? ' btn-primary' : ''}" onclick="answerGate('${escAttr(i.id)}','${escAttr(g.id)}','${escAttr(o)}')">${escHtml(o)}</button>`).join('')}
      </div>
      <form class="initiative-gate-free" onsubmit="answerGateFree(event, '${escAttr(i.id)}','${escAttr(g.id)}')">
        <input type="text" placeholder="…or answer in your own words" />
        <button type="submit" class="btn btn-ghost btn-sm">Answer</button>
      </form>
      ${g.defaultOption ? `<div class="initiative-gate-default">If you don't answer, it takes "${escHtml(g.defaultOption)}" automatically.</div>` : ''}
    </div>`).join('')}
  </div>`;
}

function renderAcceptance(i) {
  const criteria = i.acceptance || [];
  if (!criteria.length) {
    return `<div class="initiative-dod initiative-dod-empty">
      <div class="initiative-dod-head">Definition of done <span>not set</span></div>
      <p>Without one, the supervisor has nothing to verify against and will stop to ask you instead.</p>
      <button class="btn btn-sm" onclick="frameInitiative('${escAttr(i.id)}')">Work one out</button>
    </div>`;
  }
  const met = criteria.filter(c => c.status === 'met' || c.status === 'waived').length;
  return `<div class="initiative-dod">
    <div class="initiative-dod-head">
      Definition of done <span>${met}/${criteria.length} met</span>
      <button class="btn btn-ghost btn-sm" onclick="checkAcceptance('${escAttr(i.id)}')">Check now</button>
    </div>
    ${criteria.map(c => `<div class="initiative-criterion initiative-criterion-${escAttr(c.status)}">
      <button class="initiative-criterion-box" onclick="toggleCriterion('${escAttr(i.id)}','${escAttr(c.id)}','${c.status === 'met' ? 'unmet' : 'met'}')"
        title="${c.status === 'met' ? 'Mark as not met' : 'Mark as met'}">${c.status === 'met' ? '✓' : c.status === 'waived' ? '–' : ''}</button>
      <div class="initiative-criterion-body">
        <div class="initiative-criterion-text">${escHtml(c.text)}</div>
        <div class="initiative-criterion-check">
          ${c.check?.type === 'human'
            ? `<span class="initiative-criterion-human">your call</span>`
            : `<code>${escHtml(describeCheck(c.check))}</code>`}
          ${c.detail ? `<span class="initiative-criterion-detail">${escHtml(c.detail)}</span>` : ''}
        </div>
      </div>
    </div>`).join('')}
  </div>`;
}

function describeCheck(check) {
  if (!check) return '';
  switch (check.type) {
    case 'command': return check.command;
    case 'file-exists': return `${check.path} exists`;
    case 'file-contains': return `${check.path} covers ${(check.patterns || []).join(', ')}`;
    case 'git-dirty': return 'there are changes';
    case 'commits-ahead': return 'commits exist';
    case 'pushed': return 'branch is pushed';
    case 'pr-exists': return 'a PR exists';
    case 'branch-created': return 'off master';
    default: return check.type;
  }
}

function renderWorkers(i) {
  const all = (i.workers || []).filter(w => w.status !== 'gone' && w.status !== 'done');
  const boss = all.find(w => w.role === 'orchestrator');
  const workers = all.filter(w => w.role !== 'orchestrator');

  const bossRow = boss
    ? `<div class="initiative-worker initiative-worker-boss">
        <span class="initiative-worker-dot initiative-worker-${escAttr(boss.live ? boss.live.status : 'starting')}"></span>
        <span class="initiative-worker-name">${escHtml(boss.name)}</span>
        <span class="initiative-worker-role">owns this run · answers you</span>
        <span class="initiative-worker-status${boss.live ? '' : ' initiative-worker-stale'}">${escHtml(boss.live ? boss.live.status : 'no agent')}</span>
      </div>`
    : '';

  if (!all.length) return '';
  return `<div class="initiative-workers">
    <div class="initiative-workers-head">
      ${boss ? 'Orchestrator &amp; workers' : 'Workers'}
      <span>&nbsp;${workers.length} of ${i.maxParallel} slots</span>
      <button class="btn btn-ghost btn-sm" onclick="toggleOrchestrator('${escAttr(i.id)}', ${boss ? 'false' : 'true'})">${boss ? 'Turn off orchestrator' : 'Add orchestrator'}</button>
    </div>
    ${bossRow}
    ${workers.map(w => `<div class="initiative-worker">
      <span class="initiative-worker-dot initiative-worker-${escAttr(w.live ? w.live.status : 'starting')}"></span>
      <span class="initiative-worker-name">${escHtml(w.name)}</span>
      ${w.worktree ? `<span class="initiative-worker-branch" title="${escAttr(w.worktree.path)}">${escHtml(w.worktree.branch)}</span>` : ''}
      <span class="initiative-worker-status${w.live ? '' : ' initiative-worker-stale'}">${escHtml(w.live ? w.live.status : (w.status === 'working' ? 'no agent' : w.status))}</span>
      ${w.live ? `<span class="initiative-worker-pid">pid ${escHtml(w.live.pid)}</span>` : ''}
    </div>`).join('')}
  </div>`;
}

function renderTasks(stage) {
  const tasks = stage.tasks || [];
  if (!tasks.length) return '';
  return `<div class="initiative-tasks">
    ${tasks.map(t => `<div class="initiative-task initiative-task-${escAttr(t.status)}">
      <span class="initiative-task-dot"></span>
      <span class="initiative-task-name">${escHtml(t.name)}</span>
      ${t.branch ? `<span class="initiative-worker-branch">${escHtml(t.branch)}</span>` : ''}
      <span class="initiative-task-status">${escHtml(t.status)}</span>
    </div>`).join('')}
  </div>`;
}

function renderStages(i) {
  return `<div class="initiative-stages">
    ${i.stages.map((s, idx) => {
      const state = idx === i.stageIndex && !['done', 'skipped'].includes(s.status) ? 'active' : s.status;
      const parallel = (s.tasks || []).length;
      return `<div class="initiative-stage initiative-stage-${escAttr(state)}">
        <div class="initiative-stage-dot"></div>
        <div class="initiative-stage-body">
          <div class="initiative-stage-name">${escHtml(s.name)}${parallel ? `<span class="initiative-stage-parallel">${parallel} in parallel</span>` : ''}${s.nudges ? `<span class="initiative-stage-nudges">${s.nudges} nudge${s.nudges === 1 ? '' : 's'}</span>` : ''}</div>
          ${state === 'active' ? `<div class="initiative-stage-instruction">${escHtml(s.instruction)}</div>` : ''}
          ${renderTasks(s)}
        </div>
      </div>`;
    }).join('')}
    ${i.integration?.branches?.length ? `<div class="initiative-integration">Parallel branches ready to merge: ${i.integration.branches.map(b => `<code>${escHtml(b)}</code>`).join(' ')}</div>` : ''}
  </div>`;
}

function renderStats(i) {
  const s = i.stats || {};
  const saved = (s.autoApprovals || 0) + (s.nudges || 0) + (s.autoDecided || 0);
  return `<div class="initiative-stats">
    <span title="Permission prompts answered without you"><strong>${s.autoApprovals || 0}</strong> auto-approved</span>
    <span title="Times the agent was kept moving instead of idling"><strong>${s.nudges || 0}</strong> nudges</span>
    <span title="Judgement calls made by the supervisor's LLM pass"><strong>${s.llmDecisions || 0}</strong> judgements</span>
    <span title="Questions parked for you"><strong>${s.gates || 0}</strong> gates</span>
    <span class="initiative-stats-saved" title="Handoffs that would have waited for you">${saved} handoff${saved === 1 ? '' : 's'} you didn't have to make</span>
  </div>`;
}

const EVENT_ICONS = {
  'auto-approved': '✓',
  nudge: '→',
  'llm-continue': '→',
  'stage-done': '●',
  'stage-start': '○',
  'gate-opened': '!',
  'gate-resolved': '✓',
  'run-started': '▶',
  completed: '★',
  error: '✕',
};

function renderEvent(e) {
  return `<div class="initiative-event initiative-event-${escAttr(e.type)}">
    <span class="initiative-event-icon">${escHtml(EVENT_ICONS[e.type] || '·')}</span>
    <span class="initiative-event-time">${escHtml(shortTime(e.ts))}</span>
    ${e.stageName ? `<span class="initiative-event-stage">${escHtml(e.stageName)}</span>` : ''}
    <span class="initiative-event-detail">${escHtml(e.detail)}</span>
  </div>`;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export function selectInitiative(id) {
  if (id !== selectedId) {
    stopStreamPoll();
    stream = null;
    atBottom = true;
  }
  selectedId = id;
  renderList(document.getElementById('initiatives-list'));
  renderDetail();
  if (id) {
    loadStream(id, { first: true });
    startStreamPoll(id);
  }
}

export async function startInitiative(id) {
  try {
    await api('POST', `/api/initiatives/${id}/start`);
    toast('Supervisor is driving this initiative');
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

export async function pauseInitiative(id) {
  try {
    await api('POST', `/api/initiatives/${id}/pause`);
    toast('Paused');
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

export async function advanceInitiative(id) {
  if (!window.confirm('Skip the current stage and move to the next one?')) return;
  try {
    const data = await api('POST', `/api/initiatives/${id}/advance`);
    toast(data.next ? `Now on ${data.next}` : 'Initiative complete');
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

export async function runInitiativeCheck(id) {
  try {
    const data = await api('POST', `/api/initiatives/${id}/check`);
    const r = data.result || {};
    const verdict = r.passed === true ? 'passes' : r.passed === false ? 'fails' : 'is inconclusive';
    toast(`${data.stage || 'Stage'} ${verdict}: ${r.detail || ''}`, r.passed === false ? 'error' : 'success');
  } catch (err) { toast(err.message, 'error'); }
}

export async function stopInitiative(id) {
  const i = initiatives.find(x => x.id === id);
  const live = i?.liveWorkers || 0;
  const message = live
    ? `Stop "${i.name}" and kill ${live} running agent${live === 1 ? '' : 's'}?\n\nCommits, branches and worktrees are left exactly as they are.`
    : `Stop "${i?.name || id}"?`;
  if (!window.confirm(message)) return;
  try {
    const data = await api('POST', `/api/initiatives/${id}/stop`);
    toast(data.stopped.length ? `Stopped — killed ${data.stopped.length} agent session(s)` : 'Stopped');
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

export async function deleteInitiative(id) {
  const i = initiatives.find(x => x.id === id);
  const live = i?.liveWorkers || 0;
  const worktrees = (i?.workers || []).filter(w => w.worktree).length;

  if (!window.confirm(
    `Remove "${i?.name || id}"?\n\n`
    + `The record goes to the trash and can be restored.\n`
    + (live ? `• ${live} running agent${live === 1 ? '' : 's'} will be killed\n` : '')
    + `• Commits and branches are kept\n`
    + (worktrees ? `• ${worktrees} worktree${worktrees === 1 ? '' : 's'} stay on disk unless you choose to clean them next\n` : ''),
  )) return;

  const prune = worktrees
    ? window.confirm('Also remove the worktree directories?\n\nOnly clean ones are removed — anything with uncommitted changes is left alone, and every branch survives.')
    : false;

  try {
    const data = await api('DELETE', `/api/initiatives/${id}?pruneWorktrees=${prune}`);
    const bits = [];
    if (data.stopped?.length) bits.push(`${data.stopped.length} agent(s) stopped`);
    if (data.removedWorktrees?.length) bits.push(`${data.removedWorktrees.length} worktree(s) removed`);
    if (data.keptWorktrees?.length) bits.push(`${data.keptWorktrees.length} kept (uncommitted work)`);
    toast(bits.length ? `Removed — ${bits.join(', ')}` : 'Removed');
    selectedId = null;
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

export async function answerGate(id, gateId, answer) {
  try {
    await api('POST', `/api/initiatives/${id}/gates/${gateId}`, { answer });
    toast('Answered — the run continues');
    await loadInitiatives();
    loadStream(id, { force: true });
  } catch (err) { toast(err.message, 'error'); }
}

export async function answerGateFree(event, id, gateId) {
  event.preventDefault();
  const input = event.target.querySelector('input');
  const answer = input.value.trim();
  if (!answer) return;
  input.value = '';
  await answerGate(id, gateId, answer);
}

export async function sendInitiativeMessage(event, id) {
  // Kept for anything still wired to the old box: send through the same path.
  return sendChat(event, id);
}

export async function openSplitStage(id) {
  const i = initiatives.find(x => x.id === id);
  const stage = i?.currentStage;
  if (!stage) return;
  const raw = window.prompt(
    `Split "${stage.name}" into parallel tasks — one per line.\n`
    + 'Each gets its own agent and its own git worktree.\n'
    + 'Use "name: instruction" to say what each one should do.',
    (stage.tasks || []).map(t => (t.instruction ? `${t.name}: ${t.instruction}` : t.name)).join('\n'),
  );
  if (raw === null) return;

  const tasks = raw.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const idx = line.indexOf(':');
    return idx === -1
      ? { name: line, instruction: '' }
      : { name: line.slice(0, idx).trim(), instruction: line.slice(idx + 1).trim() };
  });
  if (!tasks.length) return;

  try {
    await api('POST', `/api/initiatives/${id}/split`, { stageId: stage.id, tasks });
    toast(`${stage.name} split into ${tasks.length} parallel task${tasks.length === 1 ? '' : 's'}`);
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

export async function checkAcceptance(id) {
  try {
    const data = await api('POST', `/api/initiatives/${id}/acceptance/check`);
    const met = data.results.filter(r => r.passed === true).length;
    const open = data.results.filter(r => r.passed === false);
    toast(open.length ? `${met} met — still open: ${open[0].text}` : `All ${met} checkable criteria met`, open.length ? 'error' : 'success');
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

export async function toggleCriterion(id, criterionId, status) {
  try {
    await api('POST', `/api/initiatives/${id}/acceptance/${criterionId}`, { status });
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

/** Work out a definition of done for an initiative that has none. */
export async function frameInitiative(id) {
  const i = initiatives.find(x => x.id === id);
  if (!i) return;
  toast('Working out what done means — about a minute…');
  try {
    const { proposal } = await api('POST', '/api/initiatives/frame', {
      goal: i.goal || i.name, cwd: i.cwd, template: i.template,
    });
    if (!confirmProposal(proposal)) return;
    await api('PUT', `/api/initiatives/${id}/acceptance`, { criteria: proposal.criteria });
    toast(`Definition of done set — ${proposal.criteria.length} criteria`);
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

function confirmProposal(proposal) {
  const lines = proposal.criteria.map((c, n) => `${n + 1}. ${c.text}\n     checked by: ${c.check.type === 'human' ? 'you' : describeCheck(c.check)}`);
  const questions = proposal.openQuestions?.length
    ? `\n\nWorth settling first:\n${proposal.openQuestions.map(q => `• ${q}`).join('\n')}`
    : '';
  return window.confirm(`${proposal.summary}\n\n${lines.join('\n')}${questions}\n\nUse this as the definition of done?`);
}

export async function toggleOrchestrator(id, enabled) {
  if (enabled && !window.confirm(
    'Start an orchestrator for this initiative?\n\n'
    + 'It is one more standing agent: it owns the run, decides what happens next,\n'
    + 'and is who you talk to. It never touches files or runs commands.',
  )) return;
  try {
    await api('POST', `/api/initiatives/${id}/orchestrator`, { enabled });
    toast(enabled ? 'Orchestrator starting — it takes a few seconds' : 'Orchestrator stopped');
    outcomeCache[id] = null;
    await loadInitiatives();
    // It launches in the background; look again once it should be up.
    if (enabled) setTimeout(() => { outcomeCache[id] = null; loadInitiatives(); }, 12000);
  } catch (err) { toast(err.message, 'error'); }
}

// ─── Create ──────────────────────────────────────────────────────────────────

export async function openNewInitiativeModal() {
  document.getElementById('new-initiative-modal').style.display = 'flex';
  if (!templates.length) {
    try { templates = (await api('GET', '/api/initiatives/templates')).templates || []; } catch {}
  }
  renderTemplatePicker();
  document.getElementById('new-initiative-name').focus();
}

function renderTemplatePicker() {
  const el = document.getElementById('new-initiative-templates');
  if (!el) return;
  el.innerHTML = templates.map(t => `<button type="button"
      class="template-card${t.id === selectedTemplate ? ' is-selected' : ''}"
      onclick="pickInitiativeTemplate('${escAttr(t.id)}')">
    <div class="template-card-name">${escHtml(t.name)}</div>
    <div class="template-card-summary">${escHtml(t.summary)}</div>
    <div class="template-card-stages">${t.stages.map(s => escHtml(s.name)).join(' → ')}</div>
    <div class="template-card-meta">
      <span>${escHtml(t.profile)}</span>
      <span>up to ${t.maxParallel} in parallel</span>
    </div>
  </button>`).join('');

  const chosen = templates.find(t => t.id === selectedTemplate);
  const hint = document.getElementById('new-initiative-when');
  if (hint) hint.textContent = chosen?.when || '';
  const profile = document.getElementById('new-initiative-profile');
  if (profile && chosen) profile.value = chosen.profile;
  const parallel = document.getElementById('new-initiative-parallel');
  if (parallel && chosen) parallel.value = chosen.maxParallel;
}

export function pickInitiativeTemplate(id) {
  selectedTemplate = id;
  renderTemplatePicker();
}

export async function createInitiative(event) {
  event.preventDefault();
  const body = {
    template: selectedTemplate,
    maxParallel: parseInt(document.getElementById('new-initiative-parallel').value, 10) || 3,
    useOrchestrator: document.getElementById('new-initiative-orchestrator').checked,
    name: document.getElementById('new-initiative-name').value.trim(),
    goal: document.getElementById('new-initiative-goal').value.trim(),
    cwd: document.getElementById('new-initiative-cwd').value.trim(),
    agentId: document.getElementById('new-initiative-agent').value,
    profile: document.getElementById('new-initiative-profile').value,
    verifyCommand: document.getElementById('new-initiative-verify').value.trim(),
    autoDecideAfterMs: parseInt(document.getElementById('new-initiative-autodecide').value, 10) * 60000,
  };
  if (!body.name || !body.cwd) return toast('Name and directory are required', 'error');
  if (pendingCriteria) body.acceptance = pendingCriteria;

  try {
    const data = await api('POST', '/api/initiatives', body);
    document.getElementById('new-initiative-modal').style.display = 'none';
    event.target.reset();
    pendingCriteria = null;
    document.getElementById('new-initiative-dod').innerHTML = '';
    selectedId = data.initiative.id;
    await loadInitiatives();
    toast('Initiative created — press Start when you want it driven');
  } catch (err) { toast(err.message, 'error'); }
}

/**
 * The one interactive step worth taking before the work starts: turn the goal
 * into criteria the supervisor can check, so the run does not have to keep
 * coming back to you.
 */
export async function frameNewInitiative() {
  const goal = document.getElementById('new-initiative-goal').value.trim()
    || document.getElementById('new-initiative-name').value.trim();
  const cwd = document.getElementById('new-initiative-cwd').value.trim();
  const el = document.getElementById('new-initiative-dod');
  if (!goal || !cwd) return toast('Give it a goal and a directory first', 'error');

  el.innerHTML = '<div class="drawer-loading">Working out what done means — about a minute…</div>';
  try {
    const { proposal } = await api('POST', '/api/initiatives/frame', { goal, cwd, template: selectedTemplate });
    pendingCriteria = proposal.criteria;
    if (proposal.suggestedTemplate && proposal.suggestedTemplate !== selectedTemplate) {
      pickInitiativeTemplate(proposal.suggestedTemplate);
      toast(`Looks more like ${proposal.suggestedTemplate} — switched`);
    }
    if (proposal.verifyCommand) document.getElementById('new-initiative-verify').value = proposal.verifyCommand;

    el.innerHTML = `
      <div class="dod-proposal-summary">${escHtml(proposal.summary)}</div>
      ${proposal.criteria.map(c => `<label class="dod-proposal-item">
        <input type="checkbox" checked data-dod="${escAttr(c.id)}" onchange="window.__dodToggle && window.__dodToggle()" />
        <span>
          <span class="dod-proposal-text">${escHtml(c.text)}</span>
          <span class="dod-proposal-check">${c.check.type === 'human' ? 'your call' : escHtml(describeCheck(c.check))}</span>
        </span>
      </label>`).join('')}
      ${proposal.openQuestions?.length ? `<div class="dod-proposal-questions">
        <strong>Worth settling now:</strong>
        ${proposal.openQuestions.map(q => `<div>• ${escHtml(q)}</div>`).join('')}
      </div>` : ''}`;

    // Unticking a criterion drops it from what gets saved.
    window.__dodToggle = () => {
      const keep = [...el.querySelectorAll('input[data-dod]')].filter(b => b.checked).map(b => b.dataset.dod);
      pendingCriteria = proposal.criteria.filter(c => keep.includes(c.id));
    };
  } catch (err) {
    el.innerHTML = `<div class="dod-proposal-error">${escHtml(err.message)}</div>`;
  }
}

// ─── Digest ──────────────────────────────────────────────────────────────────

export async function openInitiativeDigest() {
  const modal = document.getElementById('initiative-digest-modal');
  const body = document.getElementById('initiative-digest-body');
  modal.style.display = 'flex';
  body.innerHTML = '<div class="drawer-loading">Building digest…</div>';

  try {
    const since = new Date(Date.now() - 16 * 3600 * 1000).toISOString();
    const data = await api('GET', `/api/initiatives/digest?since=${encodeURIComponent(since)}`);
    if (!data.items.length) {
      body.innerHTML = '<div class="drawer-empty">Nothing moved since last night.</div>';
      return;
    }
    body.innerHTML = `
      <div class="digest-totals">
        <span><strong>${data.totals.stages}</strong> stages completed</span>
        <span><strong>${data.totals.autoApprovals}</strong> prompts auto-approved</span>
        <span><strong>${data.totals.nudges}</strong> nudges</span>
        <span><strong>${data.totals.openGates}</strong> waiting on you</span>
      </div>
      ${data.items.map(item => `<div class="digest-item">
        <div class="digest-item-head">
          <span class="initiative-status initiative-status-${escAttr(item.status)}">${escHtml(STATUS_LABELS[item.status] || item.status)}</span>
          <strong>${escHtml(item.name)}</strong>
          <span class="digest-stage">${escHtml(item.stage || '')}</span>
        </div>
        ${item.stagesCompleted.length ? `<div class="digest-line">Completed: ${escHtml(item.stagesCompleted.join(', '))}</div>` : ''}
        ${item.repo ? `<div class="digest-line">${escHtml(item.repo.branch)} · ${item.repo.commitsAhead} commit(s) ahead · ${item.repo.changedFiles} uncommitted file(s)${item.repo.lastCommit ? ` · last: ${escHtml(item.repo.lastCommit)}` : ''}</div>` : ''}
        <div class="digest-line digest-muted">${item.autoApprovals} auto-approved · ${item.nudges} nudges · ${item.autoDecided} auto-decided</div>
        ${item.openGates.map(g => `<div class="digest-gate">Waiting: ${escHtml(g.question)}</div>`).join('')}
      </div>`).join('')}
    `;
  } catch (err) {
    body.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tildefy(p) {
  return String(p || '').replace(/^\/Users\/[^/]+/, '~');
}

function shortTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
