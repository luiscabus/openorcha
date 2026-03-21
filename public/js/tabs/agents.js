import { api, toast, closeModal, escHtml, escAttr } from '../utils.js';

function tildefy(path) {
  if (!path) return path;
  return path.replace(/^\/Users\/[^/]+/, '~');
}

export const AGENT_META = {
  claude:   { label: 'C', color: 'claude',   accent: '#e08a6a' },
  codex:    { label: 'X', color: 'codex',    accent: '#3ecf8e' },
  gemini:   { label: 'G', color: 'gemini',   accent: '#6ba3ff' },
  opencode: { label: 'O', color: 'opencode', accent: '#f5a623' },
  aider:    { label: 'A', color: 'aider',    accent: '#a78bfa' },
  continue: { label: 'C', color: 'continue', accent: '#fc8181' },
};

const AGENT_INITIATIVES_KEY = 'ssh-manager.ai-agents.initiatives';

let draggedAgentKey = null;
let draggedInitiativeId = null;
let showNonInteractiveAgents = false;

export let agentsAutoRefreshTimer = null;

export function toggleAgentAutoRefresh() {
  const on = document.getElementById('agents-auto-refresh').checked;
  clearInterval(agentsAutoRefreshTimer);
  if (on) agentsAutoRefreshTimer = setInterval(loadAgents, 10000);
}

export function clearAgentAutoRefresh() {
  clearInterval(agentsAutoRefreshTimer);
  agentsAutoRefreshTimer = null;
  const cb = document.getElementById('agents-auto-refresh');
  if (cb) cb.checked = false;
}

function updateNonInteractiveToggle(hiddenCount = 0) {
  const button = document.getElementById('agents-non-interactive-btn');
  if (!button) return;
  button.classList.toggle('btn-active', showNonInteractiveAgents);
  button.textContent = showNonInteractiveAgents
    ? 'Hide Non-Interactive'
    : `Non-Interactive${hiddenCount ? ` (${hiddenCount})` : ''}`;
}

export function toggleAgentNonInteractive() {
  showNonInteractiveAgents = !showNonInteractiveAgents;
  loadAgents();
}

function formatEtime(etime) {
  // etime format: [[DD-]HH:]MM:SS
  const [dayPart, timePart] = etime.includes('-') ? etime.split('-') : [null, etime];
  const parts = (timePart || etime).split(':').map(Number);
  const days = dayPart ? parseInt(dayPart) : 0;
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) [h, m, s] = parts;
  else if (parts.length === 2) [m, s] = parts;
  else [s] = parts;
  if (days) return `${days}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function agentFullName(id) {
  const names = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode', aider: 'Aider', continue: 'Continue' };
  return names[id] || id;
}

function contextWindowSize(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('haiku')) return 200000;
  if (m.includes('opus')) return 200000;
  if (m.includes('sonnet')) return 200000;
  if (m.includes('gemini')) return 1000000;
  if (m.includes('gpt-4o')) return 128000;
  if (m.includes('gpt-4')) return 128000;
  if (m.includes('o3') || m.includes('o4')) return 200000;
  return 200000;
}

function readInitiativesState() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AGENT_INITIATIVES_KEY) || 'null');
    if (parsed && Array.isArray(parsed.initiatives) && parsed.assignments && typeof parsed.assignments === 'object') {
      return {
        initiatives: parsed.initiatives,
        assignments: parsed.assignments,
        collapsed: parsed.collapsed && typeof parsed.collapsed === 'object' ? parsed.collapsed : {},
      };
    }
  } catch {}
  return { initiatives: [], assignments: {}, collapsed: {} };
}

function persistInitiativesState(state) {
  window.localStorage.setItem(AGENT_INITIATIVES_KEY, JSON.stringify(state));
}

function agentInitiativeKey(agent) {
  const muxTarget = agent.multiplexer?.target || agent.multiplexer?.session || '';
  return [agent.agentId, agent.cwd || '', muxTarget || agent.tty || agent.pid].join('::');
}

function loadInitiativesState() {
  const state = readInitiativesState();
  window._agentInitiatives = state;
  return state;
}

function initiativeCollapseKey(initiativeId) {
  return initiativeId || '__unassigned__';
}

function isInitiativeCollapsed(state, initiativeId, agentsCount) {
  const key = initiativeCollapseKey(initiativeId);
  if (Object.prototype.hasOwnProperty.call(state.collapsed, key)) return !!state.collapsed[key];
  return !initiativeId && agentsCount === 0;
}

function renderAgentLane(agent, initiativeName = '') {
  const meta = AGENT_META[agent.agentId] || { label: '?', color: 'aider', accent: '#888' };
  const termBadge = agent.terminalApp
    ? `<span class="app-badge app-badge-${agent.terminalApp.toLowerCase()}">${escHtml(agent.terminalApp)}</span>`
    : '';
  const muxTarget = agent.multiplexer?.target || agent.multiplexer?.session || '';
  const muxSessionName = muxTarget.split(':')[0] || agent.multiplexer?.type || '';
  const muxBadge = agent.multiplexer
    ? `<span class="app-badge app-badge-mux" title="${escAttr(agent.multiplexer.type + ': ' + muxTarget)}">${escHtml(muxSessionName)}</span>`
    : '';
  const key = agentInitiativeKey(agent);

  const statusClass = agent.status || 'idle';
  const statusLabels = { idle: 'Idle', thinking: 'Thinking', waiting_input: 'Waiting' };
  const statusLabel = statusLabels[statusClass] || statusClass;
  const statusBadge = `<span class="agent-status-badge agent-status-${statusClass}" title="${escAttr(statusLabel)}">${escHtml(statusLabel)}</span>`;

  return `<div class="agent-card agent-card-draggable" draggable="true" ondragstart="window.startAgentInitiativeDrag(event, '${escAttr(key)}')" ondragend="window.endAgentInitiativeDrag()" style="cursor:pointer" onclick="window.openAgentMessages('${escAttr(agent.pid)}','${escAttr(agent.agentId)}','${escAttr(agent.agentName)}','${escAttr(agent.cwd || '')}')" title="Click to view conversation">
    <div class="agent-card-header">
      <div class="agent-icon agent-icon-${agent.agentId}">${meta.label}</div>
      <div class="agent-name">${escHtml(agent.agentName)}</div>
      ${termBadge}
      ${muxBadge}
    </div>
    <div class="agent-card-body">
      <div class="agent-row">
        <span class="agent-label">Project</span>
        <span class="agent-value agent-value-project" title="${escAttr(agent.cwd || '')}">${escHtml(agent.project || tildefy(agent.cwd) || '—')}</span>
      </div>
      ${agent.cwd ? `<div class="agent-row">
        <span class="agent-label">Path</span>
        <span class="agent-value" title="${escAttr(agent.cwd)}">${escHtml(tildefy(agent.cwd))}</span>
      </div>` : ''}
    </div>
    <div class="agent-card-footer">
      <div style="display:flex;gap:6px;align-items:center" onclick="event.stopPropagation()">
        ${statusBadge}
        <span class="agent-status-badge agent-status-pid">PID ${escHtml(agent.pid)}</span>
        ${agent.tty && agent.terminalApp ? `<button class="btn btn-ghost btn-sm" onclick="window.focusSession('${escAttr(agent.tty)}','${escAttr(agent.terminalApp || '')}')">Focus</button>` : ''}
        <button class="btn btn-danger btn-sm agent-kill-btn" onclick="window.killAgent('${escAttr(agent.pid)}','${escAttr(agent.agentName)}')">Kill</button>
      </div>
    </div>
  </div>`;
}

function renderInitiativeLane(initiative, agents, collapsed = false) {
  const initiativeId = initiative?.id || '';
  const initiativeName = initiative?.name || 'Unassigned';
  const reorderHandle = initiativeId
    ? `<button class="btn btn-ghost btn-sm btn-icon initiative-order-handle" draggable="true" ondragstart="window.startInitiativeOrderDrag(event, '${escAttr(initiativeId)}')" ondragend="window.endInitiativeOrderDrag()" onclick="event.stopPropagation()" title="Drag to reorder initiative">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>
      </button>`
    : '';
  return `<section class="initiative-lane${collapsed ? ' is-collapsed' : ''}" data-initiative-id="${escAttr(initiativeId)}" ondragover="window.handleAgentInitiativeDragOver(event, '${escAttr(initiativeId)}')" ondragleave="window.handleAgentInitiativeDragLeave(event)" ondrop="window.handleAgentInitiativeDrop(event, '${escAttr(initiativeId)}')">
    <div class="initiative-lane-header">
      <button class="initiative-lane-toggle" onclick="window.toggleInitiativeCollapse('${escAttr(initiativeId)}');event.stopPropagation()" title="${collapsed ? 'Expand lane' : 'Collapse lane'}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
      <div class="initiative-lane-heading">
        <div class="initiative-lane-title">${escHtml(initiativeName)}</div>
        <div class="initiative-lane-meta">${agents.length} agent${agents.length === 1 ? '' : 's'}</div>
      </div>
      <div class="initiative-lane-actions">
      ${reorderHandle}
      ${initiativeId ? `<button class="btn btn-ghost btn-sm btn-icon initiative-delete-btn" onclick="window.deleteAgentInitiative('${escAttr(initiativeId)}')" title="Delete initiative">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
      </button>` : ''}
      </div>
    </div>
    <div class="initiative-lane-dropnote">Drop an agent here to place it in this lane.</div>
    <div class="initiative-lane-body">
      ${agents.length ? agents.map(agent => renderAgentLane(agent, initiativeId ? initiativeName : '')).join('') : '<div class="initiative-empty">No agents in this initiative.</div>'}
    </div>
  </section>`;
}

// ─── Session History Dropdown ──────────────────────────────────────────────────

let historyOpen = false;

export async function toggleAgentHistory() {
  const dropdown = document.getElementById('agent-history-dropdown');
  if (historyOpen) {
    dropdown.style.display = 'none';
    historyOpen = false;
    return;
  }

  historyOpen = true;
  dropdown.style.display = 'block';
  dropdown.innerHTML = '<div class="history-loading">Loading history…</div>';

  try {
    const { sessions } = await api('GET', '/api/agents/history?limit=30');
    if (!sessions.length) {
      dropdown.innerHTML = '<div class="history-empty">No previous sessions found</div>';
      return;
    }

    // Group by project
    const byProject = {};
    for (const s of sessions) {
      const key = s.project || 'unknown';
      if (!byProject[key]) byProject[key] = { cwd: s.cwd, sessions: [] };
      byProject[key].sessions.push(s);
    }

    // Cross-reference with running agents
    const running = window._runningAgents || [];

    let html = '<div class="history-header">Recent Sessions</div><div class="history-scroll">';
    let projIdx = 0;

    for (const [project, group] of Object.entries(byProject)) {
      const latestAgo = formatTimeAgo(new Date(group.sessions[0].updatedAt));
      const count = group.sessions.length;
      const pid = `hist-proj-${projIdx++}`;
      // Check if any session in this project is currently running
      const projRunning = running.find(a => a.cwd === group.cwd);
      const projBadge = projRunning
        ? `<span class="history-badge history-badge-active">${projRunning.multiplexer ? 'interactive' : 'running'}</span>`
        : '';

      html += `<div class="history-project">
        <div class="history-project-name" title="${escAttr(group.cwd)}" onclick="this.parentElement.classList.toggle('open')">
          <svg class="history-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="9 18 15 12 9 6"/></svg>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span class="history-project-label">${escHtml(project)}</span>
          ${projBadge}
          <span class="history-project-count">${count}</span>
          <span class="history-project-ago">${escHtml(latestAgo)}</span>
        </div>
        <div class="history-project-items" id="${pid}">`;

      for (const s of group.sessions) {
        const meta = AGENT_META[s.agentId] || { label: '?', color: 'aider', accent: '#888' };
        const date = new Date(s.updatedAt);
        const ago = formatTimeAgo(date);
        const model = s.model ? s.model.replace('claude-', '').replace(/-\d{8}$/, '') : '';
        const preview = s.firstMessage.length > 80 ? s.firstMessage.slice(0, 80) + '…' : s.firstMessage;

        // Check if this specific session is currently running
        const match = running.find(a => a.agentId === s.agentId && a.cwd === s.cwd);
        let badge = '';
        if (match) {
          badge = match.multiplexer
            ? '<span class="history-badge history-badge-interactive">interactive</span>'
            : '<span class="history-badge history-badge-running">running</span>';
        }

        const onclick = match
          ? `window.historyOpenAgent('${escAttr(match.pid)}','${escAttr(match.agentId)}','${escAttr(match.agentName)}','${escAttr(match.cwd || '')}')`
          : `window.launchFromHistory('${escAttr(s.agentId)}','${escAttr(s.cwd)}','${escAttr(s.id)}')`;

        html += `<div class="history-item${match ? ' history-item-active' : ''}" onclick="${onclick}">
          <div class="history-item-top">
            <span class="history-agent-icon agent-icon-${s.agentId}">${meta.label}</span>
            <span class="history-item-preview">${escHtml(preview)}</span>
            ${badge}
          </div>
          <div class="history-item-meta">
            ${model ? `<span class="history-item-model">${escHtml(model)}</span>` : ''}
            <span class="history-item-size">${s.sizeMB} MB</span>
            <span class="history-item-date">${escHtml(ago)}</span>
          </div>
        </div>`;
      }

      html += '</div></div>';
    }

    html += '</div>';
    dropdown.innerHTML = html;
  } catch (err) {
    dropdown.innerHTML = `<div class="history-empty">Error loading history</div>`;
  }
}

export function historyOpenAgent(pid, agentId, agentName, cwd) {
  historyOpen = false;
  document.getElementById('agent-history-dropdown').style.display = 'none';
  openAgentMessages(pid, agentId, agentName, cwd);
}

export function launchFromHistory(agentId, cwd, sessionId) {
  historyOpen = false;
  document.getElementById('agent-history-dropdown').style.display = 'none';

  // Pre-fill the launch modal with session data
  document.getElementById('launch-agent-id').value = agentId;
  document.getElementById('launch-agent-cwd').value = tildefy(cwd);
  document.getElementById('launch-agent-session').value = '';
  document.getElementById('launch-skip-permissions').checked = false;
  launchSelectedSessionId = sessionId;
  document.getElementById('launch-agent-modal').style.display = 'flex';

  // Trigger session list fetch, then auto-select the right session
  setTimeout(async () => {
    await fetchLaunchSessions();
    const list = document.getElementById('launch-sessions-list');
    const target = list.querySelector(`[data-session-id="${sessionId}"]`);
    if (target) {
      selectLaunchSession(target, sessionId);
    }
  }, 100);
}

export function addAgentInitiative(event) {
  event.preventDefault();
  const input = document.getElementById('agent-initiative-input');
  const name = input.value.trim();
  if (!name) return;

  const state = loadInitiativesState();
  state.initiatives.push({ id: `initiative-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name });
  persistInitiativesState(state);
  input.value = '';
  loadAgents();
}

export function deleteAgentInitiative(initiativeId) {
  const state = loadInitiativesState();
  const initiative = state.initiatives.find(item => item.id === initiativeId);
  if (!initiative) return;
  if (!window.confirm(`Delete initiative "${initiative.name}"? Assigned agents will move to Unassigned.`)) return;

  state.initiatives = state.initiatives.filter(item => item.id !== initiativeId);
  Object.keys(state.assignments).forEach(key => {
    if (state.assignments[key] === initiativeId) delete state.assignments[key];
  });
  delete state.collapsed[initiativeCollapseKey(initiativeId)];
  persistInitiativesState(state);
  loadAgents();
}

export function toggleInitiativeCollapse(initiativeId) {
  const state = loadInitiativesState();
  const key = initiativeCollapseKey(initiativeId);
  const agents = (window._runningAgents || []).filter(agent => {
    if (!window._visibleAgents) return true;
    return window._visibleAgents.some(item => item.pid === agent.pid);
  });
  const agentsCount = initiativeId
    ? agents.filter(agent => state.assignments[agentInitiativeKey(agent)] === initiativeId).length
    : agents.filter(agent => !state.assignments[agentInitiativeKey(agent)]).length;
  state.collapsed[key] = !isInitiativeCollapsed(state, initiativeId, agentsCount);
  persistInitiativesState(state);
  loadAgents();
}

export function startAgentInitiativeDrag(event, agentKey) {
  draggedAgentKey = agentKey;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', agentKey);
}

export function endAgentInitiativeDrag() {
  draggedAgentKey = null;
  document.querySelectorAll('.initiative-lane').forEach(lane => lane.classList.remove('is-drop-target', 'is-order-target'));
}

export function startInitiativeOrderDrag(event, initiativeId) {
  draggedInitiativeId = initiativeId;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', initiativeId);
}

export function endInitiativeOrderDrag() {
  draggedInitiativeId = null;
  document.querySelectorAll('.initiative-lane').forEach(lane => lane.classList.remove('is-drop-target', 'is-order-target'));
}

export function handleAgentInitiativeDragOver(event, initiativeId) {
  if (!draggedAgentKey && !draggedInitiativeId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  if (draggedInitiativeId) {
    document.querySelectorAll('.initiative-lane').forEach(lane => {
      lane.classList.toggle('is-order-target', !!initiativeId && lane.dataset.initiativeId === initiativeId && initiativeId !== draggedInitiativeId);
      lane.classList.remove('is-drop-target');
    });
    return;
  }
  document.querySelectorAll('.initiative-lane').forEach(lane => {
    lane.classList.toggle('is-drop-target', lane.dataset.initiativeId === initiativeId);
    lane.classList.remove('is-order-target');
  });
}

export function handleAgentInitiativeDragLeave(event) {
  const lane = event.currentTarget;
  if (!lane.contains(event.relatedTarget)) {
    lane.classList.remove('is-drop-target');
  }
}

export function handleAgentInitiativeDrop(event, initiativeId) {
  event.preventDefault();
  if (draggedInitiativeId) {
    if (!initiativeId || initiativeId === draggedInitiativeId) {
      endInitiativeOrderDrag();
      return;
    }
    const state = loadInitiativesState();
    const fromIndex = state.initiatives.findIndex(item => item.id === draggedInitiativeId);
    const toIndex = state.initiatives.findIndex(item => item.id === initiativeId);
    if (fromIndex !== -1 && toIndex !== -1) {
      const [moved] = state.initiatives.splice(fromIndex, 1);
      state.initiatives.splice(toIndex, 0, moved);
      persistInitiativesState(state);
    }
    endInitiativeOrderDrag();
    loadAgents();
    return;
  }
  const agentKey = draggedAgentKey || event.dataTransfer.getData('text/plain');
  if (!agentKey) return;

  const state = loadInitiativesState();
  if (initiativeId) state.assignments[agentKey] = initiativeId;
  else delete state.assignments[agentKey];
  persistInitiativesState(state);
  endAgentInitiativeDrag();
  loadAgents();
}

// Close history dropdown on outside click
document.addEventListener('click', (e) => {
  if (!historyOpen) return;
  const dropdown = document.getElementById('agent-history-dropdown');
  const btn = document.getElementById('history-btn');
  if (!dropdown.contains(e.target) && !btn.contains(e.target)) {
    dropdown.style.display = 'none';
    historyOpen = false;
  }
});

export async function loadAgents() {
  const list = document.getElementById('agents-list');
  const summary = document.getElementById('agents-summary');
  const initiativeState = loadInitiativesState();

  try {
    const { agents } = await api('GET', '/api/agents');
    const hiddenNonInteractiveCount = agents.filter(agent => !agent.multiplexer).length;
    updateNonInteractiveToggle(hiddenNonInteractiveCount);
    const visibleAgents = showNonInteractiveAgents ? agents : agents.filter(agent => agent.multiplexer);

    // Summary pills
    const counts = {};
    for (const a of visibleAgents) counts[a.agentId] = (counts[a.agentId] || 0) + 1;

    if (!Object.keys(counts).length) {
      summary.innerHTML = '';
    } else {
      summary.innerHTML = Object.entries(counts).map(([id, n]) => {
        const meta = AGENT_META[id] || { label: id[0].toUpperCase(), accent: '#888' };
        return `<div class="agent-stat-pill">
          <span class="dot" style="background:${meta.accent}"></span>
          <span style="font-weight:600;color:var(--text)">${AGENT_META[id]?.label ? agentFullName(id) : id}</span>
          <span style="color:var(--text2)">${n} session${n > 1 ? 's' : ''}</span>
        </div>`;
      }).join('');
    }

    // Store agents data for use in drawer and history
    window._agentMux = {};
    window._runningAgents = agents;
    window._visibleAgents = visibleAgents;
    for (const a of agents) window._agentMux[a.pid] = a.multiplexer || null;

    const lanes = [
      {
        id: '',
        name: 'Unassigned',
        agents: visibleAgents.filter(agent => !initiativeState.assignments[agentInitiativeKey(agent)]),
      },
      ...initiativeState.initiatives.map(initiative => ({
        ...initiative,
        agents: visibleAgents.filter(agent => initiativeState.assignments[agentInitiativeKey(agent)] === initiative.id),
      })),
    ];

    if (!visibleAgents.length && !initiativeState.initiatives.length) {
      list.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a4 4 0 0 1 4 4v1h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1v1a4 4 0 0 1-8 0v-1H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1V6a4 4 0 0 1 4-4z"/></svg>
        <p>${agents.length ? 'Only non-interactive sessions are running' : 'No AI agent sessions running'}</p>
        <small>${agents.length ? 'Use the Non-Interactive toggle to show sessions that were not started in tmux/screen.' : 'Start Claude Code, Codex, Gemini, OpenCode, or Aider in a terminal, or create an initiative now.'}</small>
      </div>`;
      return;
    }

    list.innerHTML = lanes.map(lane => renderInitiativeLane(
      lane.id ? { id: lane.id, name: lane.name } : null,
      lane.agents,
      isInitiativeCollapsed(initiativeState, lane.id, lane.agents.length),
    )).join('');

  } catch (err) {
    list.innerHTML = `<div class="empty-state"><p style="color:var(--danger)">${escHtml(err.message)}</p></div>`;
  }
}

let launchSelectedSessionId = null;
let launchSelectedPresetId = null;
let launchSessionsDebounce = null;

export async function openLaunchAgentModal() {
  document.getElementById('launch-agent-id').value = 'claude';
  document.getElementById('launch-agent-cwd').value = '';
  document.getElementById('launch-agent-session').value = '';
  document.getElementById('launch-skip-permissions').checked = false;
  launchSelectedSessionId = null;
  launchSelectedPresetId = null;
  document.getElementById('launch-sessions-group').style.display = 'none';
  document.getElementById('launch-agent-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('launch-agent-cwd').focus(), 50);

  // Wire up session fetching on cwd/agent change
  const cwdInput = document.getElementById('launch-agent-cwd');
  const agentSelect = document.getElementById('launch-agent-id');
  const updateLaunchUI = () => {
    const isTerminal = agentSelect.value === 'terminal';
    cwdInput.required = !isTerminal;
    cwdInput.placeholder = isTerminal ? '~ (home directory)' : '~/projects/myapp';
    document.getElementById('launch-skip-permissions').closest('.form-group').style.display = isTerminal ? 'none' : '';
    document.getElementById('launch-sessions-group').style.display = isTerminal ? 'none' : document.getElementById('launch-sessions-group').style.display;
  };
  const handler = () => { updateLaunchUI(); clearTimeout(launchSessionsDebounce); launchSessionsDebounce = setTimeout(fetchLaunchSessions, 400); };
  cwdInput.oninput = handler;
  agentSelect.onchange = handler;
  updateLaunchUI();

  // Load presets
  renderPresetPicker();
}

// ─── Presets ──────────────────────────────────────────────────────────────────

async function renderPresetPicker() {
  const container = document.getElementById('launch-presets');
  try {
    const { presets } = await api('GET', '/api/agents/presets');
    let html = `<div class="preset-chip preset-chip-none${!launchSelectedPresetId ? ' preset-chip-selected' : ''}" onclick="window.selectPreset(null)">None</div>`;
    for (const p of presets) {
      const selected = launchSelectedPresetId === p.id ? ' preset-chip-selected' : '';
      html += `<div class="preset-chip${selected}" data-preset="${escAttr(p.id)}" onclick="window.selectPreset('${escAttr(p.id)}')" title="${escAttr(p.description || p.flags || '')}">
        <span class="preset-chip-icon" style="background:${escAttr(p.color)}20;color:${escAttr(p.color)}">${escHtml(p.icon)}</span>
        ${escHtml(p.name)}
      </div>`;
    }
    html += `<div class="preset-chip preset-chip-manage" onclick="window.openPresetsModal()">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </div>`;
    container.innerHTML = html;
  } catch {
    container.innerHTML = '';
  }
}

export function selectPreset(presetId) {
  launchSelectedPresetId = presetId;
  const container = document.getElementById('launch-presets');
  for (const chip of container.querySelectorAll('.preset-chip')) {
    const isNone = chip.classList.contains('preset-chip-none');
    const chipId = chip.dataset.preset || null;
    chip.classList.toggle('preset-chip-selected', presetId ? chipId === presetId : isNone);
  }
  // Auto-select the preset's agent
  if (presetId) {
    const chip = container.querySelector(`[data-preset="${presetId}"]`);
    // Find agent from presets data (stored in chip title won't work, fetch from API cache)
    // For now, presets always map to an agent — we'll set it when data is available
  }
}

export async function openPresetsModal() {
  document.getElementById('presets-modal').style.display = 'flex';
  await renderPresetsManageList();
}

export async function loadAgentPresets() {
  await renderPresetsManageList('presets-page-list');
}

async function renderPresetsManageList(targetId = 'presets-list') {
  const container = document.getElementById(targetId);
  if (!container) return;
  try {
    const { presets } = await api('GET', '/api/agents/presets');
    if (!presets.length) {
      container.innerHTML = '<div style="padding:12px;color:var(--text3);font-size:13px">No presets yet. Add one below.</div>';
      return;
    }
    let html = '';
    for (const p of presets) {
      html += `<div class="preset-manage-row">
        <span class="preset-chip-icon" style="background:${escAttr(p.color)}20;color:${escAttr(p.color)}">${escHtml(p.icon)}</span>
        <div class="preset-manage-info">
          <div class="preset-manage-name">${escHtml(p.name)} <span style="color:var(--text3);font-weight:400;font-size:11px">${escHtml(p.agent)}</span></div>
          <div class="preset-manage-desc">${escHtml(p.description)}</div>
          <div class="preset-manage-flags">${escHtml(p.flags || '(no flags)')}</div>
        </div>
        <button class="btn btn-danger btn-sm" onclick="window.deletePreset('${escAttr(p.id)}')">Delete</button>
      </div>`;
    }
    container.innerHTML = html;
  } catch {
    container.innerHTML = '<div style="padding:12px;color:var(--danger)">Error loading presets</div>';
  }
}

function getPresetFieldId(prefix, name) {
  return prefix === 'page' ? `preset-page-${name}` : `preset-${name}`;
}

export async function savePreset(e, prefix = 'modal') {
  e.preventDefault();
  const name = document.getElementById(getPresetFieldId(prefix, 'name')).value.trim();
  const agent = document.getElementById(getPresetFieldId(prefix, 'agent')).value;
  const icon = document.getElementById(getPresetFieldId(prefix, 'icon')).value.trim() || name[0];
  const color = document.getElementById(getPresetFieldId(prefix, 'color')).value;
  const description = document.getElementById(getPresetFieldId(prefix, 'description')).value.trim();
  const flags = document.getElementById(getPresetFieldId(prefix, 'flags')).value.trim();

  try {
    await api('POST', '/api/agents/presets', { name, agent, icon, color, description, flags });
    document.getElementById(getPresetFieldId(prefix, 'name')).value = '';
    document.getElementById(getPresetFieldId(prefix, 'icon')).value = '';
    document.getElementById(getPresetFieldId(prefix, 'description')).value = '';
    document.getElementById(getPresetFieldId(prefix, 'flags')).value = '';
    if (prefix === 'modal') {
      document.querySelector('.preset-form-details').removeAttribute('open');
    }
    await renderPresetsManageList();
    await renderPresetsManageList('presets-page-list');
    toast(`Preset "${name}" created`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function deletePreset(id) {
  if (!window.confirm('Delete this preset?')) return;
  try {
    await api('DELETE', `/api/agents/presets/${id}`);
    await renderPresetsManageList();
    await renderPresetsManageList('presets-page-list');
    toast('Preset deleted');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function fetchLaunchSessions() {
  const agentId = document.getElementById('launch-agent-id').value;
  const cwd = document.getElementById('launch-agent-cwd').value.trim();
  const group = document.getElementById('launch-sessions-group');
  const list = document.getElementById('launch-sessions-list');

  if (!cwd || cwd.length < 2) {
    group.style.display = 'none';
    launchSelectedSessionId = null;
    return;
  }

  group.style.display = '';
  list.innerHTML = '<div class="sessions-loading">Loading sessions…</div>';

  try {
    const { sessions, supportsResume } = await api('GET', `/api/agents/sessions?agentId=${encodeURIComponent(agentId)}&cwd=${encodeURIComponent(cwd)}`);
    if (!supportsResume || !sessions.length) {
      group.style.display = 'none';
      launchSelectedSessionId = null;
      return;
    }

    launchSelectedSessionId = null;
    let html = `<div class="session-option session-option-selected" data-session-id="" onclick="window.selectLaunchSession(this, '')">
      <div class="session-option-title">New Session</div>
      <div class="session-option-detail">Start a fresh conversation</div>
    </div>`;

    for (const s of sessions.slice(0, 10)) {
      const date = new Date(s.updatedAt);
      const ago = formatTimeAgo(date);
      const preview = escHtml(s.firstMessage.length > 100 ? s.firstMessage.slice(0, 100) + '…' : s.firstMessage);
      const model = s.model ? s.model.replace('claude-', '').replace(/-\d{8}$/, '') : '';
      html += `<div class="session-option" data-session-id="${escAttr(s.id)}" onclick="window.selectLaunchSession(this, '${escAttr(s.id)}')">
        <div class="session-option-header">
          <span class="session-option-msgs">${s.messageCount} msgs</span>
          ${model ? `<span class="session-option-model">${escHtml(model)}</span>` : ''}
          <span class="session-option-date">${escHtml(ago)}</span>
          <span class="session-option-size">${s.sizeMB} MB</span>
        </div>
        <div class="session-option-preview">${preview}</div>
      </div>`;
    }

    list.innerHTML = html;
  } catch {
    group.style.display = 'none';
    launchSelectedSessionId = null;
  }
}

export function selectLaunchSession(el, sessionId) {
  launchSelectedSessionId = sessionId || null;
  const list = document.getElementById('launch-sessions-list');
  for (const opt of list.querySelectorAll('.session-option')) {
    opt.classList.toggle('session-option-selected', opt === el);
  }
}

function formatTimeAgo(date) {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return date.toLocaleDateString();
}

export async function launchAgent(e) {
  e.preventDefault();
  const agentId         = document.getElementById('launch-agent-id').value;
  const cwd             = document.getElementById('launch-agent-cwd').value.trim();
  const sessionName     = document.getElementById('launch-agent-session').value.trim();
  const skipPermissions = document.getElementById('launch-skip-permissions').checked;
  const resumeSessionId = launchSelectedSessionId || null;
  const presetId = launchSelectedPresetId || null;

  try {
    const { sessionName: name } = await api('POST', '/api/agents/launch', { agentId, cwd, sessionName, skipPermissions, resumeSessionId, presetId });
    closeModal('launch-agent-modal');
    toast(`${resumeSessionId ? 'Resumed' : 'Launched'} in tmux session "${name}"`);
    setTimeout(loadAgents, 3000);
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function endDrawerSession() {
  if (!drawerCurrentPid) return;
  const name = document.getElementById('drawer-agent-name').textContent;
  if (!window.confirm(`Kill ${name} (PID ${drawerCurrentPid})?`)) return;
  try {
    await api('DELETE', `/api/agents/${drawerCurrentPid}`);
    toast(`${name} ended`);
    closeMessagesDrawer();
    setTimeout(loadAgents, 1500);
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function killAgent(pid, name) {
  if (!window.confirm(`Kill ${name} (PID ${pid})?`)) return;
  try {
    await api('DELETE', `/api/agents/${pid}`);
    toast(`${name} killed`);
    loadAgents();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── Agent Messages Drawer ────────────────────────────────────────────────────

let drawerCurrentPid = null;
let drawerTmuxSession = null; // set when opening a raw tmux terminal (no PID)
const drawerDrafts = {};
let drawerDraftKey = null;
let drawerView = 'messages'; // 'messages' | 'terminal' | 'context'
let drawerHasMux = false;
let terminalRefreshTimer = null;
let promptPollTimer = null;
let messagesPollTimer = null;

function getDrawerDraftKey(pid, agentId, cwd) {
  return `${agentId || ''}::${cwd || ''}::${pid || ''}`;
}

function bindDrawerDraftTracking(key) {
  const input = document.getElementById('drawer-send-input');
  input.oninput = () => {
    const value = input.value;
    if (value.trim()) drawerDrafts[key] = value;
    else delete drawerDrafts[key];
  };
}

export function handleSendKeydown(e) {
  const textarea = e.target;
  const enterToSend = document.getElementById('drawer-enter-to-send').checked;

  if (e.key === 'Enter') {
    if (enterToSend && !e.shiftKey) {
      e.preventDefault();
      sendAgentMessage();
    }
    // Shift+Enter always inserts newline (default textarea behavior)
  }

  // Auto-resize textarea
  requestAnimationFrame(() => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
  });
}

function updateDrawerSendVisibility() {
  const inTerminal = drawerView === 'terminal';
  const inContext = drawerView === 'context';
  document.getElementById('drawer-send-area').style.display = (drawerHasMux && !inContext) ? 'flex' : 'none';
  document.getElementById('drawer-quickkeys').style.display = (drawerHasMux && inTerminal) ? 'flex' : 'none';
  document.getElementById('drawer-no-mux').style.display = (!drawerHasMux && !inTerminal && !inContext) ? 'flex' : 'none';
}

export async function openAgentMessages(pid, agentId, agentName, cwd) {
  drawerCurrentPid = pid;
  drawerTmuxSession = null;
  drawerDraftKey = getDrawerDraftKey(pid, agentId, cwd);
  const meta = AGENT_META[agentId] || { label: '?', color: 'aider' };

  // Set up header
  const icon = document.getElementById('drawer-agent-icon');
  icon.textContent = meta.label;
  icon.className = `agent-icon agent-icon-${agentId}`;
  document.getElementById('drawer-agent-name').textContent = agentName;
  document.getElementById('drawer-agent-cwd').textContent = tildefy(cwd) || '';
  document.getElementById('drawer-msg-count').textContent = '';
  document.getElementById('drawer-messages').innerHTML = `<div class="drawer-loading">Loading conversation…</div>`;

  // Show send area only if agent is running in tmux or screen
  const mux = window._agentMux?.[pid] || null;
  drawerHasMux = !!mux;
  const sendInput = document.getElementById('drawer-send-input');
  sendInput.value = drawerDrafts[drawerDraftKey] || '';
  sendInput.style.height = 'auto';
  bindDrawerDraftTracking(drawerDraftKey);
  // Restore enter-to-send preference
  const enterCb = document.getElementById('drawer-enter-to-send');
  if (enterCb) enterCb.checked = localStorage.getItem('enterToSend') !== 'false';
  updateDrawerSendVisibility();

  // Always start on messages view
  switchDrawerView('messages');

  // Poll messages + prompts when in messages view with a multiplexer
  clearInterval(promptPollTimer);
  clearInterval(messagesPollTimer);
  promptPollTimer = null;
  messagesPollTimer = null;
  if (drawerHasMux) {
    promptPollTimer  = setInterval(() => checkForPrompt(drawerCurrentPid), 2500);
    messagesPollTimer = setInterval(() => fetchAndRenderMessages(drawerCurrentPid), 5000);
  }

  document.getElementById('messages-drawer').style.display = 'flex';
  if (drawerHasMux) {
    setTimeout(() => {
      const input = document.getElementById('drawer-send-input');
      if (input && drawerView === 'messages') input.focus();
    }, 0);
  }
  await fetchAndRenderMessages(pid);
}

export function openTmuxTerminal(sessionName) {
  drawerCurrentPid = null;
  drawerTmuxSession = sessionName;
  drawerHasMux = true;

  const icon = document.getElementById('drawer-agent-icon');
  icon.textContent = '>';
  icon.className = 'agent-icon agent-icon-terminal';
  document.getElementById('drawer-agent-name').textContent = sessionName;
  document.getElementById('drawer-agent-cwd').textContent = 'tmux session';
  document.getElementById('drawer-msg-count').textContent = '';
  document.getElementById('drawer-messages').innerHTML = '';

  const sendInput = document.getElementById('drawer-send-input');
  sendInput.value = '';
  sendInput.style.height = 'auto';
  updateDrawerSendVisibility();

  // Go straight to terminal view
  switchDrawerView('terminal');
  document.getElementById('messages-drawer').style.display = 'flex';
  setTimeout(() => sendInput.focus(), 0);
}

async function checkForPrompt(pid) {
  if (!pid || drawerView !== 'messages') return;
  try {
    const data = await api('GET', `/api/agents/${pid}/prompt`);
    const banner = document.getElementById('drawer-prompt');
    if (!data.hasPrompt) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = 'flex';
    banner.innerHTML = `
      ${data.context ? `<div class="drawer-prompt-context">${escHtml(data.context)}</div>` : ''}
      <div class="drawer-prompt-question">${escHtml(data.question)}</div>
      <div class="drawer-prompt-options">
        ${data.options.map((opt, i) =>
          `<button class="drawer-prompt-option${i === data.selectedIdx && !data.isNumbered ? ' selected' : ''}"
            onclick="clickPromptOption(${i}, ${data.isNumbered}, ${data.selectedIdx})"
          >${escHtml(opt.label)}</button>`
        ).join('')}
      </div>`;
  } catch {}
}

export async function clickPromptOption(targetIdx, isNumbered, currentIdx) {
  if (!drawerCurrentPid) return;
  try {
    if (isNumbered) {
      // Numbered prompts: send the digit key directly (no Enter)
      await api('POST', `/api/agents/${drawerCurrentPid}/send`, { message: String(targetIdx + 1), noEnter: true });
    } else {
      // Arrow-key prompts: navigate to target then Enter
      const delta = targetIdx - currentIdx;
      const key = delta > 0 ? 'Down' : 'Up';
      for (let i = 0; i < Math.abs(delta); i++) {
        await api('POST', `/api/agents/${drawerCurrentPid}/send`, { message: key, noEnter: true });
      }
      await api('POST', `/api/agents/${drawerCurrentPid}/send`, { message: 'Enter', noEnter: true });
    }
    // Hide prompt immediately and refresh messages shortly after
    document.getElementById('drawer-prompt').style.display = 'none';
    setTimeout(() => fetchAndRenderMessages(drawerCurrentPid), 2000);
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function switchDrawerView(view) {
  drawerView = view;
  clearInterval(terminalRefreshTimer);
  terminalRefreshTimer = null;

  const msgs = document.getElementById('drawer-messages');
  const term = document.getElementById('drawer-terminal');
  const ctx  = document.getElementById('drawer-context');
  const refreshBtn = document.getElementById('drawer-refresh-btn');
  const metaBar = document.getElementById('drawer-session-meta');

  document.getElementById('drawer-tab-messages').classList.toggle('active', view === 'messages');
  document.getElementById('drawer-tab-terminal').classList.toggle('active', view === 'terminal');
  document.getElementById('drawer-tab-context').classList.toggle('active', view === 'context');
  updateDrawerSendVisibility();

  // Hide all panels
  msgs.style.display = 'none';
  term.style.display = 'none';
  ctx.style.display  = 'none';

  const sendInput = document.getElementById('drawer-send-input');
  if (view === 'messages') {
    msgs.style.display = 'flex';
    if (metaBar) metaBar.style.display = '';
    refreshBtn.onclick = () => refreshDrawer();
    sendInput.placeholder = 'Type a message and press Enter…';
    clearInterval(promptPollTimer);
    clearInterval(messagesPollTimer);
    if (drawerHasMux && drawerCurrentPid) {
      checkForPrompt(drawerCurrentPid);
      promptPollTimer   = setInterval(() => checkForPrompt(drawerCurrentPid), 2500);
      messagesPollTimer = setInterval(() => fetchAndRenderMessages(drawerCurrentPid), 5000);
    }
    if (drawerHasMux) {
      setTimeout(() => sendInput.focus(), 0);
    }
  } else if (view === 'terminal') {
    term.style.display = 'block';
    if (metaBar) metaBar.style.display = 'none';
    refreshBtn.onclick = () => fetchAndRenderTerminal(drawerCurrentPid);
    sendInput.placeholder = 'Type a response and press Enter (e.g. y, 1, 2)…';
    clearInterval(promptPollTimer);
    clearInterval(messagesPollTimer);
    promptPollTimer = null;
    messagesPollTimer = null;
    document.getElementById('drawer-prompt').style.display = 'none';
    fetchAndRenderTerminal(drawerCurrentPid);
    terminalRefreshTimer = setInterval(() => fetchAndRenderTerminal(drawerCurrentPid), 2000);
  } else if (view === 'context') {
    ctx.style.display = 'flex';
    if (metaBar) metaBar.style.display = 'none';
    clearInterval(promptPollTimer);
    clearInterval(messagesPollTimer);
    promptPollTimer = null;
    messagesPollTimer = null;
    document.getElementById('drawer-prompt').style.display = 'none';
    refreshBtn.onclick = () => fetchAndRenderContext(drawerCurrentPid);
    fetchAndRenderContext(drawerCurrentPid);
  }
}

async function fetchAndRenderTerminal(pid) {
  if (!pid && !drawerTmuxSession) return;
  const el = document.getElementById('drawer-terminal');
  // Only auto-scroll if already at (or near) the bottom
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  try {
    const url = drawerTmuxSession && !pid
      ? `/api/agents/tmux-terminal/${encodeURIComponent(drawerTmuxSession)}`
      : `/api/agents/${pid}/terminal`;
    const { content } = await api('GET', url);
    el.textContent = content;
    if (atBottom) el.scrollTop = el.scrollHeight;
  } catch (err) {
    el.textContent = err.message;
  }
}

export async function fetchAndRenderMessages(pid) {
  const container = document.getElementById('drawer-messages');
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  try {
    const data = await api('GET', `/api/agents/${pid}/messages`);
    const { messages, total, note, sessionMeta, isWorking } = data;

    document.getElementById('drawer-msg-count').textContent =
      total > messages.length ? `last ${messages.length} of ${total}` : `${messages.length} messages`;

    renderSessionMeta(sessionMeta);

    if (!messages.length) {
      container.innerHTML = `<div class="drawer-empty">
        ${note ? escHtml(note) : 'No messages found for this session.'}
      </div>`;
      return;
    }

    let html = messages.map(m => renderMessage(m)).join('');
    if (isWorking) {
      html += `<div class="msg-entry assistant">
        <div class="msg-role-row">
          <span class="msg-role-label msg-role-assistant">Agent</span>
        </div>
        <div class="typing-dots"><span></span><span></span><span></span></div>
      </div>`;
    }
    container.innerHTML = html;
    if (atBottom) container.scrollTop = container.scrollHeight;
  } catch (err) {
    container.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

function renderSessionMeta(meta) {
  const bar = document.getElementById('drawer-session-meta');
  if (!bar) return;
  if (!meta || (!meta.model && !meta.totalInputTokens && !meta.pid)) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';

  const pills = [];
  if (meta.model) {
    const short = meta.model.replace('claude-', '').replace(/-\d{8}$/, '');
    pills.push(`<span class="meta-pill meta-pill-model">${escHtml(short)}</span>`);
  }
  if (meta.totalInputTokens || meta.totalOutputTokens) {
    const inK = (meta.totalInputTokens / 1000).toFixed(1);
    const outK = (meta.totalOutputTokens / 1000).toFixed(1);
    pills.push(`<span class="meta-pill" title="Input / Output tokens">${inK}k in &middot; ${outK}k out</span>`);
  }
  if (meta.totalCacheRead) {
    pills.push(`<span class="meta-pill" title="Cache read tokens">${(meta.totalCacheRead / 1000).toFixed(1)}k cached</span>`);
  }
  if (meta.lastContextTokens && meta.model) {
    const maxCtx = contextWindowSize(meta.model);
    const pctUsed = Math.min(100, (meta.lastContextTokens / maxCtx) * 100);
    const pctLeft = Math.max(0, 100 - pctUsed);
    const cls = pctLeft < 15 ? 'meta-pill-ctx-low' : pctLeft < 35 ? 'meta-pill-ctx-mid' : 'meta-pill-ctx-ok';
    pills.push(`<span class="meta-pill ${cls}" title="${meta.lastContextTokens.toLocaleString()} / ${maxCtx.toLocaleString()} tokens used">${pctLeft.toFixed(0)}% ctx</span>`);
  }
  if (meta.costUSD != null && meta.costUSD > 0) {
    pills.push(`<span class="meta-pill meta-pill-cost" title="Estimated cost">$${meta.costUSD < 0.01 ? meta.costUSD.toFixed(4) : meta.costUSD.toFixed(2)}</span>`);
  }
  if (meta.etime) {
    pills.push(`<span class="meta-pill" title="Runtime">${escHtml(formatEtime(meta.etime))}</span>`);
  }
  if (meta.pid) {
    pills.push(`<span class="meta-pill" title="Process ID">PID ${escHtml(meta.pid)}</span>`);
  }
  bar.innerHTML = pills.join('');
}

export async function refreshDrawer() {
  if (drawerCurrentPid) await fetchAndRenderMessages(drawerCurrentPid);
}

// ─── Context Tab ──────────────────────────────────────────────────────────────

async function fetchAndRenderContext(pid) {
  const container = document.getElementById('drawer-context');
  container.innerHTML = `<div class="drawer-loading">Loading context…</div>`;
  try {
    const data = await api('GET', `/api/agents/${pid}/context`);
    const { sections, agentId, cwd } = data;

    let html = '';

    // Tmux attach command at the top
    const mux = window._agentMux?.[pid];
    if (mux && mux.type === 'tmux') {
      const cmd = `tmux attach -t ${mux.target}`;
      html += `<div class="ctx-connect-bar">
        <code class="ctx-connect-cmd" title="Click to copy" onclick="navigator.clipboard.writeText('${escAttr(cmd)}');this.classList.add('copied');setTimeout(()=>this.classList.remove('copied'),1200)">${escHtml(cmd)}</code>
      </div>`;
    } else if (mux && mux.type === 'screen') {
      const cmd = `screen -r ${mux.session}`;
      html += `<div class="ctx-connect-bar">
        <code class="ctx-connect-cmd" title="Click to copy" onclick="navigator.clipboard.writeText('${escAttr(cmd)}');this.classList.add('copied');setTimeout(()=>this.classList.remove('copied'),1200)">${escHtml(cmd)}</code>
      </div>`;
    }

    if (!sections || !sections.length) {
      container.innerHTML = html + `<div class="drawer-empty">No configuration or context data found for this agent.</div>`;
      return;
    }

    container.innerHTML = html + sections.map(s => renderContextSection(s)).join('');
  } catch (err) {
    container.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

function renderContextSection(section) {
  const scopeBadge = `<span class="ctx-scope ctx-scope-${section.scope}">${section.scope}</span>`;
  const icon = contextIcon(section.icon);

  // Active MCP servers section
  if (section.servers) {
    const rows = section.servers.map(s => {
      const sBadge = `<span class="ctx-scope ctx-scope-${s.scope}">${s.scope}</span>`;
      return `<div class="ctx-server-row">
        <span class="ctx-server-name">${escHtml(s.name)}</span>
        <span class="ctx-server-type">${escHtml(s.type)}</span>
        <span class="ctx-server-source">${escHtml(s.source || '')}</span>
        ${sBadge}
      </div>`;
    }).join('');
    return `<div class="ctx-section">
      <div class="ctx-section-header">${icon}<span class="ctx-section-title">${escHtml(section.title)}</span><span class="ctx-active-count">${section.servers.length}</span>${scopeBadge}</div>
      <div class="ctx-servers">${rows}</div>
    </div>`;
  }

  // Marketplace plugins section
  if (section.plugins) {
    const rows = section.plugins.map(p => {
      const statusCls = p.active ? 'ctx-plugin-active' : '';
      const statusLabel = p.active ? 'active' : p.hasMcp ? 'available' : 'skill';
      const typeLabel = p.builtin ? 'builtin' : 'external';
      return `<div class="ctx-plugin-row ${statusCls}">
        <span class="ctx-plugin-name">${escHtml(p.name)}</span>
        ${p.description ? `<span class="ctx-plugin-desc">${escHtml(p.description)}</span>` : ''}
        <span class="ctx-plugin-badge ctx-plugin-badge-${statusLabel}">${statusLabel}</span>
        <span class="ctx-plugin-type">${typeLabel}</span>
      </div>`;
    }).join('');
    return `<details class="ctx-section">
      <summary class="ctx-section-header" style="cursor:pointer">${icon}<span class="ctx-section-title">${escHtml(section.title)}</span><span class="ctx-active-count">${section.plugins.length}</span>${scopeBadge}</summary>
      <div class="ctx-plugins">${rows}</div>
    </details>`;
  }

  // Memory section
  if (section.memories) {
    const mems = section.memories.map(m => {
      const typeBadge = `<span class="ctx-mem-type">${escHtml(m.type)}</span>`;
      return `<details class="ctx-memory">
        <summary class="ctx-memory-summary">${typeBadge}<span class="ctx-memory-name">${escHtml(m.name)}</span>${m.description ? `<span class="ctx-memory-desc">${escHtml(m.description)}</span>` : ''}</summary>
        <pre class="ctx-memory-body">${escHtml(m.body)}</pre>
      </details>`;
    }).join('');
    return `<div class="ctx-section">
      <div class="ctx-section-header">${icon}<span class="ctx-section-title">${escHtml(section.title)}</span>${scopeBadge}</div>
      ${mems}
    </div>`;
  }

  // Markdown content section (CLAUDE.md, AGENTS.md etc)
  if (section.content) {
    return `<div class="ctx-section">
      <div class="ctx-section-header">${icon}<span class="ctx-section-title">${escHtml(section.title)}</span>${scopeBadge}</div>
      <pre class="ctx-doc-content">${escHtml(section.content)}</pre>
    </div>`;
  }

  // Key-value items section
  if (section.items) {
    const rows = section.items.map(item =>
      `<div class="ctx-item-row">
        <span class="ctx-item-label">${escHtml(item.label)}</span>
        <span class="ctx-item-value">${escHtml(item.value)}</span>
      </div>`
    ).join('');
    return `<div class="ctx-section">
      <div class="ctx-section-header">${icon}<span class="ctx-section-title">${escHtml(section.title)}</span>${scopeBadge}</div>
      <div class="ctx-items">${rows}</div>
    </div>`;
  }

  return '';
}

function contextIcon(name) {
  const icons = {
    settings: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    chart:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    plug:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v6M8 2v6M16 2v6M4 10h16v4a8 8 0 0 1-16 0v-4z"/></svg>',
    block:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>',
    doc:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    brain:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 0 0-7 7c0 3 1.5 5 3 6.5V20a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-4.5c1.5-1.5 3-3.5 3-6.5a7 7 0 0 0-7-7z"/><line x1="10" y1="22" x2="14" y2="22"/></svg>',
  };
  return `<span class="ctx-icon">${icons[name] || icons.doc}</span>`;
}

export function closeMessagesDrawer() {
  const input = document.getElementById('drawer-send-input');
  input.oninput = null;
  document.getElementById('messages-drawer').style.display = 'none';
  drawerCurrentPid = null;
  drawerDraftKey = null;
  clearInterval(terminalRefreshTimer);
  clearInterval(promptPollTimer);
  clearInterval(messagesPollTimer);
  terminalRefreshTimer = null;
  promptPollTimer = null;
  messagesPollTimer = null;
  document.getElementById('drawer-prompt').style.display = 'none';
}

export function closeDrawerOnOverlay(e) {
  if (e.target === document.getElementById('messages-drawer')) closeMessagesDrawer();
}

export async function sendAgentMessage() {
  const input = document.getElementById('drawer-send-input');
  const message = input.value.trim();
  const draftKey = drawerDraftKey;
  const pid = drawerCurrentPid;
  const tmuxSess = drawerTmuxSession;
  if (!message || (!pid && !tmuxSess)) return;

  // In terminal view: send without appending Enter (raw keystrokes)
  const noEnter = drawerView === 'terminal';

  input.disabled = true;
  try {
    const url = tmuxSess && !pid
      ? `/api/agents/tmux-terminal/${encodeURIComponent(tmuxSess)}/send`
      : `/api/agents/${pid}/send`;
    await api('POST', url, { message, noEnter });
    input.value = '';
    input.style.height = 'auto';
    if (draftKey) delete drawerDrafts[draftKey];
    if (!noEnter) {
      setTimeout(() => {
        if (drawerCurrentPid === pid) fetchAndRenderMessages(pid);
      }, 1500);
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    input.disabled = false;
    input.focus();
  }
}

// Send a single named key (Up, Down, Enter, Escape, y, n, 1 …)
export async function sendKey(key) {
  if (!drawerCurrentPid && !drawerTmuxSession) return;
  try {
    const url = drawerTmuxSession && !drawerCurrentPid
      ? `/api/agents/tmux-terminal/${encodeURIComponent(drawerTmuxSession)}/send`
      : `/api/agents/${drawerCurrentPid}/send`;
    await api('POST', url, { message: key, noEnter: true });
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderMessage(msg) {
  const isUser = msg.role === 'user';
  const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  const toolsHtml = (msg.tools || []).map(t => renderTool(t)).join('');
  const bodyText = simpleMarkdown(msg.text || '');

  // Usage badge for assistant messages
  let usageHtml = '';
  if (msg.usage) {
    const parts = [];
    if (msg.usage.inputTokens) parts.push(`${msg.usage.inputTokens.toLocaleString()} in`);
    if (msg.usage.outputTokens) parts.push(`${msg.usage.outputTokens.toLocaleString()} out`);
    if (parts.length) {
      usageHtml = `<span class="msg-usage">${parts.join(' · ')}</span>`;
    }
  }
  let modelHtml = '';
  if (msg.model) {
    const short = msg.model.replace('claude-', '').replace(/-\d{8}$/, '');
    modelHtml = `<span class="msg-model">${escHtml(short)}</span>`;
  }

  return `<div class="msg-entry ${isUser ? 'user' : 'assistant'}">
    <div class="msg-role-row">
      <span class="msg-role-label ${isUser ? 'msg-role-user' : 'msg-role-assistant'}">${isUser ? 'You' : 'Agent'}</span>
      ${modelHtml}
      ${timeStr ? `<span class="msg-timestamp">${timeStr}</span>` : ''}
      ${usageHtml}
    </div>
    ${bodyText ? `<div class="msg-body">${bodyText}</div>` : ''}
    ${toolsHtml ? `<div class="msg-tools-list">${toolsHtml}</div>` : ''}
  </div>`;
}

function renderTool(t) {
  const icon = toolIcon(t.name);
  const detail = toolDetailText(t);
  const hasPatch = t.patch && Array.isArray(t.patch) && t.patch.length > 0;
  const hasResult = !hasPatch && t.result != null && t.result !== '';
  const hasError = t.resultError != null && t.resultError !== '';

  let resultHtml = '';
  if (hasPatch) {
    resultHtml = renderDiff(t.patch);
  } else if (hasResult || hasError) {
    const resultContent = truncateResult(t.result || '');
    const errorContent = hasError ? truncateResult(t.resultError) : '';
    resultHtml = `<details class="tool-result-details">
      <summary class="tool-result-summary">${hasError ? 'Output + Error' : 'Output'} (${countLines(t.result || '')} lines)</summary>
      <pre class="tool-result-content">${escHtml(resultContent)}</pre>
      ${errorContent ? `<pre class="tool-result-error">${escHtml(errorContent)}</pre>` : ''}
    </details>`;
  }

  return `<div class="msg-tool-block">
    <div class="msg-tool-header">
      <span class="msg-tool-pill">${icon}${escHtml(t.name)}</span>
      ${detail ? `<span class="msg-tool-detail" title="${escAttr(detail)}">${escHtml(detail)}</span>` : ''}
    </div>
    ${resultHtml}
  </div>`;
}

function renderDiff(hunks) {
  let added = 0, removed = 0;
  const hunkHtmls = hunks.map(h => {
    const lines = (h.lines || []).map(line => {
      if (line.startsWith('+')) { added++; return `<div class="diff-add">${escHtml(line)}</div>`; }
      if (line.startsWith('-')) { removed++; return `<div class="diff-del">${escHtml(line)}</div>`; }
      return `<div class="diff-ctx">${escHtml(line)}</div>`;
    }).join('');
    return `<div class="diff-hunk-header">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</div>${lines}`;
  }).join('');

  const stats = `<span class="diff-stat-add">+${added}</span> <span class="diff-stat-del">-${removed}</span>`;
  return `<details class="tool-result-details" open>
    <summary class="tool-result-summary">Diff ${stats}</summary>
    <div class="diff-view">${hunkHtmls}</div>
  </details>`;
}

function toolDetailText(t) {
  if (!t.input) return '';
  const inp = t.input;
  switch (t.name) {
    case 'Read':     return inp.file_path ? tildefy(inp.file_path) : '';
    case 'Write':    return inp.file_path ? tildefy(inp.file_path) : '';
    case 'Edit':     return inp.file_path ? tildefy(inp.file_path) : '';
    case 'Bash':     return inp.command || inp.description || '';
    case 'Glob':     return inp.pattern || '';
    case 'Grep':     return inp.pattern ? `/${inp.pattern}/` + (inp.glob ? ` in ${inp.glob}` : '') : '';
    case 'Agent':    return inp.description || inp.prompt?.slice(0, 60) || '';
    default:
      // Generic: show first string value
      for (const v of Object.values(inp)) {
        if (typeof v === 'string' && v.length > 0) return v.length > 80 ? v.slice(0, 77) + '…' : v;
      }
      return '';
  }
}

function truncateResult(text, maxLines = 30) {
  if (!text) return '';
  if (typeof text !== 'string') text = JSON.stringify(text, null, 2);
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n… (${lines.length - maxLines} more lines)`;
}

function countLines(text) {
  if (!text) return 0;
  if (typeof text !== 'string') text = JSON.stringify(text, null, 2);
  return text.split('\n').length;
}

function toolIcon(name) {
  const icons = {
    Read:    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:3px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    Write:   '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:3px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    Edit:    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:3px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    Bash:    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:3px"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
    Glob:    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:3px"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    Grep:    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:3px"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  };
  return icons[name] || '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:3px"><circle cx="12" cy="12" r="3"/></svg>';
}

function simpleMarkdown(text) {
  if (!text) return '';
  // Escape HTML first
  let out = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Code blocks (```...```)
  out = out.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) =>
    `<pre>${code.trimEnd()}</pre>`);
  // Inline code
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Newlines
  out = out.replace(/\n/g, '<br>');
  return out;
}
