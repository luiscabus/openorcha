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

export async function loadAgents() {
  const list = document.getElementById('agents-list');
  const summary = document.getElementById('agents-summary');

  try {
    const { agents } = await api('GET', '/api/agents');

    // Summary pills
    const counts = {};
    for (const a of agents) counts[a.agentId] = (counts[a.agentId] || 0) + 1;

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

    if (!agents.length) {
      list.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a4 4 0 0 1 4 4v1h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1v1a4 4 0 0 1-8 0v-1H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1V6a4 4 0 0 1 4-4z"/></svg>
        <p>No AI agent sessions running</p>
        <small>Start Claude Code, Codex, Gemini, OpenCode, or Aider in a terminal</small>
      </div>`;
      return;
    }

    // Store multiplexer info keyed by PID for use in the drawer
    window._agentMux = {};
    for (const a of agents) window._agentMux[a.pid] = a.multiplexer || null;

    const interactive = agents.filter(a => a.multiplexer);
    const background = agents.filter(a => !a.multiplexer);

    const renderCard = a => {
      const meta = AGENT_META[a.agentId] || { label: '?', color: 'aider', accent: '#888' };
      const termBadge = a.terminalApp
        ? `<span class="app-badge app-badge-${a.terminalApp.toLowerCase()}">${escHtml(a.terminalApp)}</span>`
        : '';
      const muxBadge = a.multiplexer
        ? `<span class="app-badge app-badge-mux" title="${escAttr(a.multiplexer.type + ': ' + (a.multiplexer.target || a.multiplexer.session || ''))}">${escHtml(a.multiplexer.type)}</span>`
        : '';

      return `<div class="agent-card" style="cursor:pointer" onclick="window.openAgentMessages('${escAttr(a.pid)}','${escAttr(a.agentId)}','${escAttr(a.agentName)}','${escAttr(a.cwd||'')}')" title="Click to view conversation">
        <div class="agent-card-header">
          <div class="agent-icon agent-icon-${a.agentId}">${meta.label}</div>
          <div class="agent-name">${escHtml(a.agentName)}</div>
          ${termBadge}
          ${muxBadge}
          <span class="agent-pid">PID ${escHtml(a.pid)}</span>
        </div>
        <div class="agent-card-body">
          <div class="agent-row">
            <span class="agent-label">Project</span>
            <span class="agent-value agent-value-project" title="${escAttr(a.cwd || '')}">${escHtml(a.project || tildefy(a.cwd) || '—')}</span>
          </div>
          ${a.cwd ? `<div class="agent-row">
            <span class="agent-label">Path</span>
            <span class="agent-value" title="${escAttr(a.cwd)}">${escHtml(tildefy(a.cwd))}</span>
          </div>` : ''}
          <div class="agent-row">
            <span class="agent-label">Runtime</span>
            <span class="agent-value" style="color:var(--text)">${escHtml(formatEtime(a.etime))}</span>
          </div>
          ${a.tty ? `<div class="agent-row">
            <span class="agent-label">TTY</span>
            <span class="agent-value">${escHtml(a.tty)}</span>
          </div>` : ''}
        </div>
        <div class="agent-card-footer">
          <div class="agent-metrics">
            <span>CPU <span class="agent-metric-val">${a.cpu}%</span></span>
            <span>MEM <span class="agent-metric-val">${a.mem}%</span></span>
          </div>
          <div style="display:flex;gap:6px" onclick="event.stopPropagation()">
            ${a.tty && a.terminalApp ? `<button class="btn btn-ghost btn-sm" onclick="window.focusSession('${escAttr(a.tty)}','${escAttr(a.terminalApp || '')}')">Focus</button>` : ''}
            <button class="btn btn-danger btn-sm" onclick="window.killAgent('${escAttr(a.pid)}','${escAttr(a.agentName)}')">Kill</button>
          </div>
        </div>
      </div>`;
    };

    let html = '';
    if (interactive.length) {
      html += `<div class="agents-group-label">Interactive <span class="agents-group-count">${interactive.length}</span></div>`;
      html += `<div class="agents-grid-inner">${interactive.map(renderCard).join('')}</div>`;
    }
    if (background.length) {
      html += `<div class="agents-group-label">Background <span class="agents-group-count">${background.length}</span></div>`;
      html += `<div class="agents-grid-inner">${background.map(renderCard).join('')}</div>`;
    }
    list.innerHTML = html;

  } catch (err) {
    list.innerHTML = `<div class="empty-state"><p style="color:var(--danger)">${escHtml(err.message)}</p></div>`;
  }
}

export function openLaunchAgentModal() {
  document.getElementById('launch-agent-id').value = 'claude';
  document.getElementById('launch-agent-cwd').value = '';
  document.getElementById('launch-agent-session').value = '';
  document.getElementById('launch-skip-permissions').checked = false;
  document.getElementById('launch-agent-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('launch-agent-cwd').focus(), 50);
}

export async function launchAgent(e) {
  e.preventDefault();
  const agentId         = document.getElementById('launch-agent-id').value;
  const cwd             = document.getElementById('launch-agent-cwd').value.trim();
  const sessionName     = document.getElementById('launch-agent-session').value.trim();
  const skipPermissions = document.getElementById('launch-skip-permissions').checked;

  try {
    const { sessionName: name } = await api('POST', '/api/agents/launch', { agentId, cwd, sessionName, skipPermissions });
    closeModal('launch-agent-modal');
    toast(`Launched in tmux session "${name}"`);
    setTimeout(loadAgents, 3000);
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
let drawerView = 'messages'; // 'messages' | 'terminal'
let drawerHasMux = false;
let terminalRefreshTimer = null;

function updateDrawerSendVisibility() {
  const inTerminal = drawerView === 'terminal';
  document.getElementById('drawer-send-area').style.display = drawerHasMux ? 'flex' : 'none';
  document.getElementById('drawer-quickkeys').style.display = (drawerHasMux && inTerminal) ? 'flex' : 'none';
  document.getElementById('drawer-no-mux').style.display = (!drawerHasMux && !inTerminal) ? 'flex' : 'none';
}

export async function openAgentMessages(pid, agentId, agentName, cwd) {
  drawerCurrentPid = pid;
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
  document.getElementById('drawer-send-input').value = '';
  updateDrawerSendVisibility();

  // Always start on messages view
  switchDrawerView('messages');

  document.getElementById('messages-drawer').style.display = 'flex';
  await fetchAndRenderMessages(pid);
}

export function switchDrawerView(view) {
  drawerView = view;
  clearInterval(terminalRefreshTimer);
  terminalRefreshTimer = null;

  const msgs = document.getElementById('drawer-messages');
  const term = document.getElementById('drawer-terminal');
  const refreshBtn = document.getElementById('drawer-refresh-btn');

  document.getElementById('drawer-tab-messages').classList.toggle('active', view === 'messages');
  document.getElementById('drawer-tab-terminal').classList.toggle('active', view === 'terminal');
  updateDrawerSendVisibility();

  const sendInput = document.getElementById('drawer-send-input');
  if (view === 'messages') {
    msgs.style.display = 'flex';
    term.style.display = 'none';
    refreshBtn.onclick = () => refreshDrawer();
    sendInput.placeholder = 'Type a message and press Enter…';
  } else {
    msgs.style.display = 'none';
    term.style.display = 'block';
    refreshBtn.onclick = () => fetchAndRenderTerminal(drawerCurrentPid);
    sendInput.placeholder = 'Type a response and press Enter (e.g. y, 1, 2)…';
    fetchAndRenderTerminal(drawerCurrentPid);
    // Auto-refresh terminal every 2s to catch permission prompts
    terminalRefreshTimer = setInterval(() => fetchAndRenderTerminal(drawerCurrentPid), 2000);
  }
}

async function fetchAndRenderTerminal(pid) {
  if (!pid) return;
  const el = document.getElementById('drawer-terminal');
  try {
    const { content } = await api('GET', `/api/agents/${pid}/terminal`);
    el.textContent = content;
    el.scrollTop = el.scrollHeight;
  } catch (err) {
    el.textContent = err.message;
  }
}

export async function fetchAndRenderMessages(pid) {
  const container = document.getElementById('drawer-messages');
  try {
    const data = await api('GET', `/api/agents/${pid}/messages`);
    const { messages, total, note, sessionMeta } = data;

    document.getElementById('drawer-msg-count').textContent =
      total > messages.length ? `last ${messages.length} of ${total}` : `${messages.length} messages`;

    renderSessionMeta(sessionMeta);

    if (!messages.length) {
      container.innerHTML = `<div class="drawer-empty">
        ${note ? escHtml(note) : 'No messages found for this session.'}
      </div>`;
      return;
    }

    container.innerHTML = messages.map(m => renderMessage(m)).join('');
    container.scrollTop = container.scrollHeight;
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
  if (meta.costUSD != null && meta.costUSD > 0) {
    pills.push(`<span class="meta-pill meta-pill-cost" title="Estimated cost">$${meta.costUSD < 0.01 ? meta.costUSD.toFixed(4) : meta.costUSD.toFixed(2)}</span>`);
  }
  if (meta.etime) {
    pills.push(`<span class="meta-pill" title="Runtime">${escHtml(formatEtime(meta.etime))}</span>`);
  }
  if (meta.cpu != null) {
    pills.push(`<span class="meta-pill" title="CPU / MEM">CPU ${meta.cpu}% &middot; MEM ${meta.mem}%</span>`);
  }
  if (meta.pid) {
    pills.push(`<span class="meta-pill" title="Process ID">PID ${escHtml(meta.pid)}</span>`);
  }
  bar.innerHTML = pills.join('');
}

export async function refreshDrawer() {
  if (drawerCurrentPid) await fetchAndRenderMessages(drawerCurrentPid);
}

export function closeMessagesDrawer() {
  document.getElementById('messages-drawer').style.display = 'none';
  drawerCurrentPid = null;
  clearInterval(terminalRefreshTimer);
  terminalRefreshTimer = null;
}

export function closeDrawerOnOverlay(e) {
  if (e.target === document.getElementById('messages-drawer')) closeMessagesDrawer();
}

export async function sendAgentMessage() {
  const input = document.getElementById('drawer-send-input');
  const message = input.value.trim();
  if (!message || !drawerCurrentPid) return;

  // In terminal view: send without appending Enter (raw keystrokes)
  const noEnter = drawerView === 'terminal';

  input.disabled = true;
  try {
    await api('POST', `/api/agents/${drawerCurrentPid}/send`, { message, noEnter });
    input.value = '';
    if (!noEnter) {
      setTimeout(() => fetchAndRenderMessages(drawerCurrentPid), 1500);
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
  if (!drawerCurrentPid) return;
  try {
    await api('POST', `/api/agents/${drawerCurrentPid}/send`, { message: key, noEnter: true });
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
  const hasResult = t.result != null && t.result !== '';
  const hasError = t.resultError != null && t.resultError !== '';

  let resultHtml = '';
  if (hasResult || hasError) {
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
