import { api, toast, closeModal, escHtml, escAttr } from '../utils.js';
import {
  AGENT_META, AGENT_INITIATIVES_KEY, LAUNCH_RECENT_CWDS_KEY,
  tildefy, agentFullName, formatTimeAgo,
  agentInitiativeKey, readLastOpenedAgentKey,
} from './agentShared.js';
import { openAgentMessages, closeMessagesDrawer } from './agentDrawer.js';
import {
  selectPreset as _selectPreset, renderPresetPicker,
  getSelectedPresetFile, resetSelectedPresetFile,
} from './agentPresets.js';

// ─── Re-exports for main.js ──────────────────────────────────────────────────

export { AGENT_META } from './agentShared.js';
export {
  openAgentMessages, openTmuxTerminal, closeMessagesDrawer, closeDrawerOnOverlay,
  refreshDrawer, fetchAndRenderMessages, switchDrawerView,
  handleSendKeydown, sendAgentMessage, sendKey,
  clickPromptOption, endDrawerSession, attachDrawerSession, relaunchDrawerSession,
} from './agentDrawer.js';
export { toggleContextBlock, toggleMcpServer } from './agentContext.js';
export { openPresetsModal, loadAgentPresets, savePreset, deletePreset } from './agentPresets.js';

// ─── Module State ─────────────────────────────────────────────────────────────

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

// ─── Initiatives State ────────────────────────────────────────────────────────

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

// ─── Agent Card Rendering ─────────────────────────────────────────────────────

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
  const isLastOpened = readLastOpenedAgentKey() === key;

  return `<div class="agent-card agent-card-draggable${isLastOpened ? ' agent-card-last-opened' : ''}" draggable="true" ondragstart="window.startAgentInitiativeDrag(event, '${escAttr(key)}')" ondragend="window.endAgentInitiativeDrag()" style="cursor:pointer" onclick="window.openAgentMessages('${escAttr(agent.pid)}','${escAttr(agent.agentId)}','${escAttr(agent.agentName)}','${escAttr(agent.cwd || '')}')" title="Click to view conversation">
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
        ${isLastOpened ? '<span class="agent-last-opened-dot" title="Last opened"></span>' : ''}
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

// ─── Session History Dropdown ─────────────────────────────────────────────────

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

    const orderedSessions = [...sessions].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const byProject = {};
    for (const s of orderedSessions) {
      const key = s.project || 'unknown';
      if (!byProject[key]) byProject[key] = { cwd: s.cwd, sessions: [] };
      byProject[key].sessions.push(s);
    }

    const running = window._runningAgents || [];

    let html = '<div class="history-header">Recent Sessions</div><div class="history-scroll">';
    let projIdx = 0;

    for (const [project, group] of Object.entries(byProject)) {
      group.sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      const latestAgo = formatTimeAgo(new Date(group.sessions[0].updatedAt));
      const count = group.sessions.length;
      const pid = `hist-proj-${projIdx++}`;
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

        const match = running.find(a =>
          a.agentId === s.agentId &&
          a.cwd === s.cwd &&
          a.historySessionId &&
          a.historySessionId === s.id
        );
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

  document.getElementById('launch-agent-id').value = agentId;
  document.getElementById('launch-agent-cwd').value = tildefy(cwd);
  document.getElementById('launch-agent-session').value = '';
  document.getElementById('launch-skip-permissions').checked = false;
  launchSelectedSessionId = sessionId;
  document.getElementById('launch-agent-modal').style.display = 'flex';

  setTimeout(async () => {
    await fetchLaunchSessions();
    const list = document.getElementById('launch-sessions-list');
    const target = list.querySelector(`[data-session-id="${sessionId}"]`);
    if (target) {
      selectLaunchSession(target, sessionId);
    }
  }, 100);
}

// ─── Initiative Drag & Drop ───────────────────────────────────────────────────

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

// ─── Load Agents ──────────────────────────────────────────────────────────────

export async function loadAgents() {
  const list = document.getElementById('agents-list');
  const summary = document.getElementById('agents-summary');
  const initiativeState = loadInitiativesState();

  try {
    const { agents } = await api('GET', '/api/agents');
    const hiddenNonInteractiveCount = agents.filter(agent => !agent.multiplexer).length;
    updateNonInteractiveToggle(hiddenNonInteractiveCount);
    const visibleAgents = showNonInteractiveAgents ? agents : agents.filter(agent => agent.multiplexer);

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

// ─── Launch Modal ─────────────────────────────────────────────────────────────

let launchSelectedSessionId = null;
let launchSessionsDebounce = null;
let launchUiRefresh = null;
let launchDuplicateAgent = null;
let launchResumeSessionCount = 0;
let launchTmuxSessionsCache = null;
let launchSubmitting = false;

function readRecentLaunchCwds() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LAUNCH_RECENT_CWDS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function rememberRecentLaunchCwd(cwd) {
  if (!cwd) return;
  const next = [cwd, ...readRecentLaunchCwds().filter(entry => entry !== cwd)].slice(0, 12);
  window.localStorage.setItem(LAUNCH_RECENT_CWDS_KEY, JSON.stringify(next));
}

function basenameish(input) {
  const trimmed = String(input || '').trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === '~') return 'home';
  const parts = trimmed.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'home';
}

function sanitizeTmuxSessionName(input) {
  return String(input || '').trim().replace(/[^a-zA-Z0-9_.\-]/g, '-');
}

function suggestedLaunchSessionName(agentId, cwd, presetFile, explicitName = '') {
  const cleanedExplicit = sanitizeTmuxSessionName(explicitName);
  if (cleanedExplicit) return cleanedExplicit;
  if (presetFile) return sanitizeTmuxSessionName(`${presetFile}-${basenameish(cwd)}`);
  return sanitizeTmuxSessionName(`${agentId}-${basenameish(cwd)}`);
}

function uniqueLaunchSessionName(baseName, tmuxSessions = []) {
  const base = sanitizeTmuxSessionName(baseName) || 'session';
  const names = new Set((tmuxSessions || []).map(session => session.name));
  if (!names.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${base}-${Date.now() % 10000}`;
}

function setLaunchSubmitting(submitting) {
  launchSubmitting = submitting;
  const submit = document.getElementById('launch-agent-submit');
  if (!submit) return;
  submit.disabled = submitting;
  submit.textContent = submitting ? 'Launching…' : 'Launch';
}

function renderLaunchCwdSuggestions() {
  const datalist = document.getElementById('launch-agent-cwd-suggestions');
  if (!datalist) return;
  const suggestions = [
    ...readRecentLaunchCwds(),
    ...((window._runningAgents || []).map(agent => agent.cwd).filter(Boolean)),
  ];
  const unique = [...new Set(suggestions)].slice(0, 20);
  datalist.innerHTML = unique.map(cwd => `<option value="${escAttr(cwd)}"></option>`).join('');
}

async function ensureLaunchTmuxSessions() {
  if (launchTmuxSessionsCache) return launchTmuxSessionsCache;
  try {
    launchTmuxSessionsCache = await api('GET', '/api/sessions/tmux');
  } catch {
    launchTmuxSessionsCache = { installed: false, sessions: [] };
  }
  return launchTmuxSessionsCache;
}

async function refreshLaunchPreflight() {
  const panel = document.getElementById('launch-preflight');
  if (!panel) return;

  const agentId = document.getElementById('launch-agent-id').value;
  const cwd = document.getElementById('launch-agent-cwd').value.trim();
  const explicitSessionName = document.getElementById('launch-agent-session').value.trim();
  const isTerminal = agentId === 'terminal';
  const previewSessionName = suggestedLaunchSessionName(agentId, cwd, getSelectedPresetFile(), explicitSessionName);

  if (!cwd && !previewSessionName) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }

  const tmuxInfo = await ensureLaunchTmuxSessions();
  const running = window._runningAgents || [];
  const finalSessionName = uniqueLaunchSessionName(previewSessionName, tmuxInfo.sessions);
  launchDuplicateAgent = !isTerminal
    ? running.find(agent => agent.agentId === agentId && agent.cwd === cwd)
    : null;
  const tmuxCollision = tmuxInfo.sessions?.find(session => session.name === previewSessionName);

  panel.style.display = 'block';
  panel.innerHTML = `
    <div class="launch-preflight-title">Launch Preflight</div>
    <div class="launch-preflight-row">
      <span class="launch-preflight-label">Session</span>
      <span class="launch-preflight-value mono">${escHtml(finalSessionName || '—')}</span>
      <span class="launch-preflight-note">${tmuxCollision ? 'auto-suffixed' : (explicitSessionName ? 'custom' : 'auto')}</span>
    </div>
    <div class="launch-preflight-row">
      <span class="launch-preflight-label">Resume</span>
      <span class="launch-preflight-value">${launchResumeSessionCount ? `${launchResumeSessionCount} saved session${launchResumeSessionCount > 1 ? 's' : ''}` : 'none found'}</span>
      <span class="launch-preflight-note"></span>
    </div>
    <div class="launch-preflight-row">
      <span class="launch-preflight-label">Live Agent</span>
      ${launchDuplicateAgent
        ? `<span class="launch-preflight-value">Already running in this project</span>
           <button type="button" class="btn btn-ghost btn-sm" onclick="window.openExistingLaunchAgent()">Open Existing</button>`
        : '<span class="launch-preflight-value">No matching live agent</span><span class="launch-preflight-note"></span>'}
    </div>
    <div class="launch-preflight-row">
      <span class="launch-preflight-label">tmux</span>
      <span class="launch-preflight-value">${tmuxCollision ? 'Name collision resolved automatically' : 'Session name is free'}</span>
      <span class="launch-preflight-note">${tmuxCollision ? escHtml(finalSessionName) : 'new session'}</span>
    </div>
  `;
}

export async function openLaunchAgentModal() {
  document.getElementById('launch-agent-id').value = 'claude';
  document.getElementById('launch-agent-cwd').value = '';
  document.getElementById('launch-agent-session').value = '';
  document.getElementById('launch-skip-permissions').checked = false;
  launchSelectedSessionId = null;
  resetSelectedPresetFile();
  launchDuplicateAgent = null;
  launchResumeSessionCount = 0;
  launchTmuxSessionsCache = null;
  setLaunchSubmitting(false);
  document.getElementById('launch-sessions-group').style.display = 'none';
  document.getElementById('launch-preflight').style.display = 'none';
  document.getElementById('launch-agent-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('launch-agent-cwd').focus(), 50);

  const cwdInput = document.getElementById('launch-agent-cwd');
  const agentSelect = document.getElementById('launch-agent-id');
  const sessionInput = document.getElementById('launch-agent-session');
  const updateLaunchUI = () => {
    const isTerminal = agentSelect.value === 'terminal';
    cwdInput.required = !isTerminal;
    cwdInput.placeholder = isTerminal ? '~ (home directory)' : '~/projects/myapp';
    document.getElementById('launch-skip-permissions').closest('.form-group').style.display = isTerminal ? 'none' : '';
    document.getElementById('launch-sessions-group').style.display = isTerminal ? 'none' : document.getElementById('launch-sessions-group').style.display;
  };
  const handler = () => {
    updateLaunchUI();
    clearTimeout(launchSessionsDebounce);
    launchSessionsDebounce = setTimeout(async () => {
      await fetchLaunchSessions();
      await refreshLaunchPreflight();
    }, 400);
  };
  cwdInput.oninput = handler;
  agentSelect.onchange = handler;
  sessionInput.oninput = handler;
  launchUiRefresh = handler;
  updateLaunchUI();
  renderLaunchCwdSuggestions();

  await renderPresetPicker();
  await refreshLaunchPreflight();
}

export function selectPreset(presetFile) {
  _selectPreset(presetFile, launchUiRefresh);
}

export function openExistingLaunchAgent() {
  if (!launchDuplicateAgent) return;
  closeModal('launch-agent-modal');
  openAgentMessages(
    launchDuplicateAgent.pid,
    launchDuplicateAgent.agentId,
    launchDuplicateAgent.agentName,
    launchDuplicateAgent.cwd || '',
  );
}

async function fetchLaunchSessions() {
  const agentId = document.getElementById('launch-agent-id').value;
  const cwd = document.getElementById('launch-agent-cwd').value.trim();
  const group = document.getElementById('launch-sessions-group');
  const list = document.getElementById('launch-sessions-list');

  if (!cwd || cwd.length < 2) {
    group.style.display = 'none';
    launchSelectedSessionId = null;
    launchResumeSessionCount = 0;
    return;
  }

  group.style.display = '';
  list.innerHTML = '<div class="sessions-loading">Loading sessions…</div>';

  try {
    const { sessions, supportsResume } = await api('GET', `/api/agents/sessions?agentId=${encodeURIComponent(agentId)}&cwd=${encodeURIComponent(cwd)}`);
    launchResumeSessionCount = supportsResume ? sessions.length : 0;
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
      const recent = Array.isArray(s.recentMessages) ? s.recentMessages.slice(-2) : [];
      html += `<div class="session-option" data-session-id="${escAttr(s.id)}" onclick="window.selectLaunchSession(this, '${escAttr(s.id)}')">
        <div class="session-option-header">
          <span class="session-option-msgs">${s.messageCount} msgs</span>
          ${model ? `<span class="session-option-model">${escHtml(model)}</span>` : ''}
          <span class="session-option-date">${escHtml(ago)}</span>
          <span class="session-option-size">${s.sizeMB} MB</span>
        </div>
        <div class="session-option-preview">${preview}</div>
        ${recent.length ? `<div class="session-option-recent">
          ${recent.map(msg => `<div class="session-option-recent-item">
            <span class="session-option-recent-role session-option-recent-role-${escAttr(msg.role)}">${msg.role === 'assistant' ? 'Agent' : 'You'}</span>
            <span class="session-option-recent-text">${escHtml(msg.text.length > 140 ? msg.text.slice(0, 140) + '…' : msg.text)}</span>
          </div>`).join('')}
        </div>` : ''}
      </div>`;
    }

    list.innerHTML = html;
  } catch {
    group.style.display = 'none';
    launchSelectedSessionId = null;
    launchResumeSessionCount = 0;
  }
}

export function selectLaunchSession(el, sessionId) {
  launchSelectedSessionId = sessionId || null;
  const list = document.getElementById('launch-sessions-list');
  for (const opt of list.querySelectorAll('.session-option')) {
    opt.classList.toggle('session-option-selected', opt === el);
  }
  refreshLaunchPreflight();
}

export async function launchAgent(e) {
  e.preventDefault();
  if (launchSubmitting) return;
  const agentId         = document.getElementById('launch-agent-id').value;
  const cwd             = document.getElementById('launch-agent-cwd').value.trim();
  const sessionName     = document.getElementById('launch-agent-session').value.trim();
  const skipPermissions = document.getElementById('launch-skip-permissions').checked;
  const resumeSessionId = launchSelectedSessionId || null;
  const presetFile = getSelectedPresetFile() || null;

  try {
    setLaunchSubmitting(true);
    const { sessionName: name } = await api('POST', '/api/agents/launch', { agentId, cwd, sessionName, skipPermissions, resumeSessionId, presetFile });
    rememberRecentLaunchCwd(cwd);
    closeModal('launch-agent-modal');
    toast(`${resumeSessionId ? 'Resumed' : 'Launched'} in tmux session "${name}"`);
    setTimeout(loadAgents, 3000);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setLaunchSubmitting(false);
  }
}

// ─── Kill / Relaunch ──────────────────────────────────────────────────────────

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

export async function relaunchAgent(pid, name) {
  if (!window.confirm(`Relaunch ${name}? This will kill the process and resume its session.`)) return;
  try {
    const { sessionName } = await api('POST', `/api/agents/${pid}/relaunch`);
    toast(`${name} relaunched in "${sessionName}"`);
    closeMessagesDrawer();
    setTimeout(loadAgents, 3000);
  } catch (err) {
    toast(err.message, 'error');
  }
}
