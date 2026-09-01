import { api, toast, escHtml, escAttr } from '../utils.js';

let initiatives = [];
let selectedId = null;
let refreshTimer = null;

const STATUS_LABELS = {
  draft: 'Draft',
  running: 'Running',
  blocked: 'Needs you',
  paused: 'Paused',
  done: 'Done',
  failed: 'Failed',
};

// ─── Loading ─────────────────────────────────────────────────────────────────

export async function loadInitiatives() {
  const list = document.getElementById('initiatives-list');
  try {
    const data = await api('GET', '/api/initiatives');
    initiatives = data.initiatives || [];
    if (!initiatives.some(i => i.id === selectedId)) {
      selectedId = initiatives.find(i => i.status === 'blocked')?.id || initiatives[0]?.id || null;
    }
    renderList(list);
    renderDetail();
    renderNeedsYou();
  } catch (err) {
    list.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

export function startInitiativesAutoRefresh() {
  clearInitiativesAutoRefresh();
  refreshTimer = setInterval(loadInitiatives, 8000);
}

export function clearInitiativesAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
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

// ─── Detail ──────────────────────────────────────────────────────────────────

function renderDetail() {
  const el = document.getElementById('initiative-detail');
  const i = initiatives.find(x => x.id === selectedId);
  if (!i) {
    el.innerHTML = '<div class="drawer-empty">Select an initiative.</div>';
    return;
  }

  const live = i.live
    ? `<span class="initiative-live initiative-live-${escAttr(i.live.status)}">agent ${escHtml(i.live.status)} · pid ${escHtml(i.live.pid)}</span>`
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
        </div>
      </div>
      <div class="initiative-detail-actions">
        ${i.status === 'running'
          ? `<button class="btn btn-ghost btn-sm" onclick="pauseInitiative('${escAttr(i.id)}')">Pause</button>`
          : `<button class="btn btn-primary btn-sm" onclick="startInitiative('${escAttr(i.id)}')">${i.run ? 'Resume' : 'Start'}</button>`}
        <button class="btn btn-ghost btn-sm" onclick="runInitiativeCheck('${escAttr(i.id)}')">Run check</button>
        <button class="btn btn-ghost btn-sm" onclick="advanceInitiative('${escAttr(i.id)}')">Skip stage</button>
        <button class="btn btn-ghost btn-sm" onclick="deleteInitiative('${escAttr(i.id)}')">Delete</button>
      </div>
    </div>

    ${i.goal ? `<p class="initiative-goal">${escHtml(i.goal)}</p>` : ''}

    ${renderGates(i)}
    ${renderStages(i)}
    ${renderStats(i)}

    <form class="initiative-say" onsubmit="sendInitiativeMessage(event, '${escAttr(i.id)}')">
      <input type="text" id="initiative-say-input" placeholder="Say something to this agent…" />
      <button type="submit" class="btn btn-ghost btn-sm">Send</button>
    </form>

    <h4 class="initiative-section-title">Activity</h4>
    <div class="initiative-timeline">
      ${[...(i.events || [])].reverse().slice(0, 60).map(renderEvent).join('') || '<div class="drawer-empty">Nothing yet.</div>'}
    </div>
  `;
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

function renderStages(i) {
  return `<div class="initiative-stages">
    ${i.stages.map((s, idx) => {
      const state = idx === i.stageIndex && !['done', 'skipped'].includes(s.status) ? 'active' : s.status;
      return `<div class="initiative-stage initiative-stage-${escAttr(state)}">
        <div class="initiative-stage-dot"></div>
        <div class="initiative-stage-body">
          <div class="initiative-stage-name">${escHtml(s.name)}${s.nudges ? `<span class="initiative-stage-nudges">${s.nudges} nudge${s.nudges === 1 ? '' : 's'}</span>` : ''}</div>
          <div class="initiative-stage-instruction">${escHtml(s.instruction)}</div>
        </div>
      </div>`;
    }).join('')}
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
  selectedId = id;
  renderList(document.getElementById('initiatives-list'));
  renderDetail();
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

export async function deleteInitiative(id) {
  const i = initiatives.find(x => x.id === id);
  if (!window.confirm(`Delete "${i?.name || id}"? The agent's tmux session is left running.`)) return;
  try {
    await api('DELETE', `/api/initiatives/${id}`);
    selectedId = null;
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

export async function answerGate(id, gateId, answer) {
  try {
    await api('POST', `/api/initiatives/${id}/gates/${gateId}`, { answer });
    toast('Answered — the run continues');
    loadInitiatives();
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
  event.preventDefault();
  const input = document.getElementById('initiative-say-input');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  try {
    await api('POST', `/api/initiatives/${id}/message`, { message });
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

// ─── Create ──────────────────────────────────────────────────────────────────

export function openNewInitiativeModal() {
  document.getElementById('new-initiative-modal').style.display = 'flex';
  document.getElementById('new-initiative-name').focus();
}

export async function createInitiative(event) {
  event.preventDefault();
  const body = {
    name: document.getElementById('new-initiative-name').value.trim(),
    goal: document.getElementById('new-initiative-goal').value.trim(),
    cwd: document.getElementById('new-initiative-cwd').value.trim(),
    agentId: document.getElementById('new-initiative-agent').value,
    profile: document.getElementById('new-initiative-profile').value,
    verifyCommand: document.getElementById('new-initiative-verify').value.trim(),
    autoDecideAfterMs: parseInt(document.getElementById('new-initiative-autodecide').value, 10) * 60000,
  };
  if (!body.name || !body.cwd) return toast('Name and directory are required', 'error');

  try {
    const data = await api('POST', '/api/initiatives', body);
    document.getElementById('new-initiative-modal').style.display = 'none';
    event.target.reset();
    selectedId = data.initiative.id;
    await loadInitiatives();
    toast('Initiative created — press Start when you want it driven');
  } catch (err) { toast(err.message, 'error'); }
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
