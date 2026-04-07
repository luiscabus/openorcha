import { api, toast, escHtml, escAttr } from '../utils.js';
import {
  AGENT_META, tildefy, formatEtime, contextWindowSize, simpleMarkdown,
  agentInitiativeKey, writeLastOpenedAgentKey, setDrawerCurrentPid,
} from './agentShared.js';
import { fetchAndRenderContext } from './agentContext.js';
import {
  activateDrawerLiveTerminal,
  deactivateDrawerLiveTerminal,
  refreshDrawerLiveTerminal,
} from './drawerLiveTerminal.js';

// ─── Drawer State ─────────────────────────────────────────────────────────────

let drawerCurrentPid = null;
let drawerTmuxSession = null;
const drawerDrafts = {};
let drawerDraftKey = null;
let drawerView = 'messages';
let drawerHasMux = false;
let terminalRefreshTimer = null;
let promptPollTimer = null;
let messagesPollTimer = null;
let drawerRenderedMessagesPid = null;
let drawerRenderedMessageKeys = [];
let drawerSessionFile = null;

function setCurrentPid(pid) {
  drawerCurrentPid = pid;
  setDrawerCurrentPid(pid);
}

export function getDrawerCurrentPid() {
  return drawerCurrentPid;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function messageRenderKey(msg, idx) {
  const stamp = msg.timestamp || '';
  const text = msg.text || '';
  return `${idx}|${msg.role || ''}|${stamp}|${text.length}|${text.slice(0, 48)}`;
}

function renderTypingIndicator() {
  return `<div class="msg-entry assistant" data-msg-typing="true">
    <div class="msg-role-row">
      <span class="msg-role-label msg-role-assistant">Agent</span>
    </div>
    <div class="typing-dots"><span></span><span></span><span></span></div>
  </div>`;
}

function clearTypingIndicator(container) {
  const typing = container.querySelector('[data-msg-typing="true"]');
  if (typing && typing.parentNode) typing.parentNode.removeChild(typing);
}

function hasExpandedSelectionInside(container) {
  if (!window.getSelection) return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  return !!((anchorNode && container.contains(anchorNode)) || (focusNode && container.contains(focusNode)));
}

function appendHtml(container, html) {
  if (!html) return;
  if (typeof container.insertAdjacentHTML === 'function') {
    container.insertAdjacentHTML('beforeend', html);
    return;
  }
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  while (wrapper.firstChild) container.appendChild(wrapper.firstChild);
}

// ─── Send Area Visibility ─────────────────────────────────────────────────────

function updateDrawerSendVisibility() {
  const inTerminal = drawerView === 'terminal';
  const inLive = drawerView === 'live';
  const inContext = drawerView === 'context';
  const inGit = drawerView === 'git';
  document.getElementById('drawer-send-area').style.display = (drawerHasMux && !inContext && !inGit && !inLive) ? 'flex' : 'none';
  document.getElementById('drawer-quickkeys').style.display = (drawerHasMux && inTerminal) ? 'flex' : 'none';
  document.getElementById('drawer-no-mux').style.display = (!drawerHasMux && !inTerminal && !inContext && !inGit && !inLive) ? 'flex' : 'none';
}

function updateDrawerTmuxTabVisibility() {
  const liveTab = document.getElementById('drawer-tab-live');
  if (!liveTab) return;
  liveTab.style.display = drawerTmuxSession ? '' : 'none';
}

// ─── Open / Close ─────────────────────────────────────────────────────────────

export async function openAgentMessages(pid, agentId, agentName, cwd) {
  setCurrentPid(pid);
  const mux = window._agentMux?.[pid] || null;
  drawerTmuxSession = mux?.type === 'tmux'
    ? ((mux.target || mux.session || '').split(':')[0] || null)
    : null;
  drawerDraftKey = getDrawerDraftKey(pid, agentId, cwd);
  drawerRenderedMessagesPid = null;
  drawerRenderedMessageKeys = [];
  drawerSessionFile = null;
  writeLastOpenedAgentKey(agentInitiativeKey({ pid, agentId, cwd, multiplexer: window._agentMux?.[pid], tty: null }));
  window.loadAgents();
  const meta = AGENT_META[agentId] || { label: '?', color: 'aider' };

  const icon = document.getElementById('drawer-agent-icon');
  icon.textContent = meta.label;
  icon.className = `agent-icon agent-icon-${agentId}`;
  document.getElementById('drawer-agent-name').textContent = agentName;
  document.getElementById('drawer-agent-cwd').textContent = tildefy(cwd) || '';
  document.getElementById('drawer-msg-count').textContent = '';
  document.getElementById('drawer-messages').innerHTML = `<div class="drawer-loading">Loading conversation…</div>`;

  drawerHasMux = !!mux;
  updateDrawerTmuxTabVisibility();
  const attachBtn = document.getElementById('drawer-attach-btn');
  if (attachBtn) attachBtn.style.display = drawerTmuxSession ? '' : 'none';
  const sendInput = document.getElementById('drawer-send-input');
  sendInput.value = drawerDrafts[drawerDraftKey] || '';
  sendInput.style.height = 'auto';
  bindDrawerDraftTracking(drawerDraftKey);
  const enterCb = document.getElementById('drawer-enter-to-send');
  if (enterCb) enterCb.checked = localStorage.getItem('enterToSend') !== 'false';
  updateDrawerSendVisibility();

  switchDrawerView('messages');

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
  clearInterval(terminalRefreshTimer);
  clearInterval(promptPollTimer);
  clearInterval(messagesPollTimer);
  terminalRefreshTimer = null;
  promptPollTimer = null;
  messagesPollTimer = null;
  setCurrentPid(null);
  drawerTmuxSession = sessionName;
  drawerHasMux = true;
  drawerRenderedMessagesPid = null;
  drawerRenderedMessageKeys = [];
  drawerSessionFile = null;

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
  const attachBtn = document.getElementById('drawer-attach-btn');
  if (attachBtn) attachBtn.style.display = drawerTmuxSession ? '' : 'none';
  updateDrawerTmuxTabVisibility();
  updateDrawerSendVisibility();

  document.getElementById('messages-drawer').style.display = 'flex';
  switchDrawerView('live');
  setTimeout(() => document.getElementById('drawer-live-terminal')?.focus(), 0);
}

export function closeMessagesDrawer() {
  const input = document.getElementById('drawer-send-input');
  input.oninput = null;
  document.getElementById('messages-drawer').style.display = 'none';
  deactivateDrawerLiveTerminal();
  setCurrentPid(null);
  drawerTmuxSession = null;
  drawerDraftKey = null;
  drawerRenderedMessagesPid = null;
  drawerRenderedMessageKeys = [];
  drawerSessionFile = null;
  const attachBtn = document.getElementById('drawer-attach-btn');
  if (attachBtn) attachBtn.style.display = 'none';
  updateDrawerTmuxTabVisibility();
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

export function attachDrawerSession() {
  if (!drawerTmuxSession || !window.attachTmux) return;
  window.attachTmux(drawerTmuxSession);
}

// ─── Prompt Detection ─────────────────────────────────────────────────────────

async function checkForPrompt(pid) {
  if (!pid) return;
  try {
    const data = await api('GET', `/api/agents/${pid}/prompt`);
    if (pid !== drawerCurrentPid) return;

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
      await api('POST', `/api/agents/${drawerCurrentPid}/send`, { message: String(targetIdx + 1), noEnter: true });
    } else {
      const delta = targetIdx - currentIdx;
      const key = delta > 0 ? 'Down' : 'Up';
      for (let i = 0; i < Math.abs(delta); i++) {
        await api('POST', `/api/agents/${drawerCurrentPid}/send`, { message: key, noEnter: true });
      }
      await api('POST', `/api/agents/${drawerCurrentPid}/send`, { message: 'Enter', noEnter: true });
    }
    document.getElementById('drawer-prompt').style.display = 'none';
    setTimeout(() => fetchAndRenderMessages(drawerCurrentPid), 2000);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── View Switching ───────────────────────────────────────────────────────────

export function switchDrawerView(view) {
  drawerView = view;
  clearInterval(terminalRefreshTimer);
  terminalRefreshTimer = null;

  const msgs = document.getElementById('drawer-messages');
  const term = document.getElementById('drawer-terminal');
  const git  = document.getElementById('drawer-git');
  const ctx  = document.getElementById('drawer-context');
  const refreshBtn = document.getElementById('drawer-refresh-btn');
  const metaBar = document.getElementById('drawer-session-meta');

  document.getElementById('drawer-tab-messages').classList.toggle('active', view === 'messages');
  document.getElementById('drawer-tab-live').classList.toggle('active', view === 'live');
  document.getElementById('drawer-tab-terminal').classList.toggle('active', view === 'terminal');
  document.getElementById('drawer-tab-git').classList.toggle('active', view === 'git');
  document.getElementById('drawer-tab-context').classList.toggle('active', view === 'context');
  updateDrawerSendVisibility();

  msgs.style.display = 'none';
  const live = document.getElementById('drawer-live');
  term.style.display = 'none';
  git.style.display = 'none';
  ctx.style.display  = 'none';
  live.style.display = 'none';
  deactivateDrawerLiveTerminal();

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
  } else if (view === 'live') {
    live.style.display = 'flex';
    if (metaBar) metaBar.style.display = 'none';
    refreshBtn.onclick = () => refreshDrawerLiveTerminal();
    sendInput.placeholder = 'Live tmux input is captured directly in the canvas…';
    clearInterval(messagesPollTimer);
    messagesPollTimer = null;
    if (!drawerCurrentPid) {
      clearInterval(promptPollTimer);
      promptPollTimer = null;
    }
    activateDrawerLiveTerminal({ pid: drawerCurrentPid, sessionName: drawerTmuxSession });
    if (!promptPollTimer && drawerHasMux && drawerCurrentPid) {
      checkForPrompt(drawerCurrentPid);
      promptPollTimer = setInterval(() => checkForPrompt(drawerCurrentPid), 2500);
    }
  } else if (view === 'terminal') {
    term.style.display = 'block';
    if (metaBar) metaBar.style.display = 'none';
    refreshBtn.onclick = () => fetchAndRenderTerminal(drawerCurrentPid);
    sendInput.placeholder = 'Type a response and press Enter (e.g. y, 1, 2)…';
    clearInterval(messagesPollTimer);
    messagesPollTimer = null;
    fetchAndRenderTerminal(drawerCurrentPid);
    terminalRefreshTimer = setInterval(() => fetchAndRenderTerminal(drawerCurrentPid), 2000);
    if (!promptPollTimer && drawerHasMux && drawerCurrentPid) {
      checkForPrompt(drawerCurrentPid);
      promptPollTimer = setInterval(() => checkForPrompt(drawerCurrentPid), 2500);
    }
  } else if (view === 'git') {
    git.style.display = 'flex';
    if (metaBar) metaBar.style.display = 'none';
    clearInterval(messagesPollTimer);
    messagesPollTimer = null;
    refreshBtn.onclick = () => fetchAndRenderGit(drawerCurrentPid);
    fetchAndRenderGit(drawerCurrentPid);
    if (!promptPollTimer && drawerHasMux && drawerCurrentPid) {
      checkForPrompt(drawerCurrentPid);
      promptPollTimer = setInterval(() => checkForPrompt(drawerCurrentPid), 2500);
    }
  } else if (view === 'context') {
    ctx.style.display = 'flex';
    if (metaBar) metaBar.style.display = 'none';
    clearInterval(messagesPollTimer);
    messagesPollTimer = null;
    refreshBtn.onclick = () => fetchAndRenderContext(drawerCurrentPid);
    fetchAndRenderContext(drawerCurrentPid);
    if (!promptPollTimer && drawerHasMux && drawerCurrentPid) {
      checkForPrompt(drawerCurrentPid);
      promptPollTimer = setInterval(() => checkForPrompt(drawerCurrentPid), 2500);
    }
  }
}

// ─── Terminal View ────────────────────────────────────────────────────────────

async function fetchAndRenderTerminal(pid) {
  if (!pid && !drawerTmuxSession) return;
  const el = document.getElementById('drawer-terminal');
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

// ─── Git View ─────────────────────────────────────────────────────────────────

async function fetchAndRenderGit(pid) {
  const container = document.getElementById('drawer-git');
  if (!pid) {
    container.innerHTML = `<div class="drawer-empty">Git info is only available for agent sessions.</div>`;
    return;
  }

  container.innerHTML = `<div class="drawer-loading">Loading git info…</div>`;
  try {
    const data = await api('GET', `/api/agents/${pid}/git`);
    if (!data.isRepo) {
      container.innerHTML = `<div class="drawer-empty">${escHtml(data.note || 'This session is not inside a git repository.')}</div>`;
      return;
    }

    const branchMeta = [];
    if (data.branch) branchMeta.push(`<span class="meta-pill meta-pill-model">${escHtml(data.branch)}</span>`);
    if (data.upstream) branchMeta.push(`<span class="meta-pill">${escHtml(data.upstream)}</span>`);
    if (data.ahead > 0) branchMeta.push(`<span class="meta-pill git-ahead"><strong>+${data.ahead}</strong> ahead</span>`);
    if (data.behind > 0) branchMeta.push(`<span class="meta-pill git-behind"><strong>${data.behind}</strong> behind</span>`);

    const stats = [
      { label: 'Changed', value: data.changedCount || 0 },
      { label: 'Staged', value: data.stagedCount || 0 },
      { label: 'Untracked', value: data.untrackedCount || 0 },
    ];

    const filesHtml = data.files.length
      ? `<div class="git-panel">
          <div class="git-panel-header">
            <div class="git-panel-title">Files</div>
          </div>
          <div class="git-status-list">
            ${data.files.map(file => `<div class="git-status-row">
              <span class="git-status-code">${escHtml(file.code)}</span>
              <span class="git-status-path">${escHtml(file.path)}</span>
            </div>`).join('')}
          </div>
        </div>`
      : `<div class="git-panel"><div class="git-empty">Working tree clean.</div></div>`;

    container.innerHTML = `
      <div class="git-panel">
        <div class="git-panel-header">
          <div>
            <div class="git-panel-title">Repository</div>
            <div class="git-branch">${escHtml(data.rootName || data.root || 'Repository')}</div>
          </div>
          <div class="git-branch-meta">${branchMeta.join('')}</div>
        </div>
        <div class="git-stat-grid">
          ${stats.map(stat => `<div class="git-stat">
            <div class="git-stat-label">${escHtml(stat.label)}</div>
            <div class="git-stat-value">${escHtml(String(stat.value))}</div>
          </div>`).join('')}
        </div>
      </div>
      ${filesHtml}
    `;
  } catch (err) {
    container.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

// ─── Messages View ────────────────────────────────────────────────────────────

export async function fetchAndRenderMessages(pid) {
  const container = document.getElementById('drawer-messages');
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  const selectionInside = hasExpandedSelectionInside(container);
  try {
    const data = await api('GET', `/api/agents/${pid}/messages`);
    if (pid !== drawerCurrentPid) return;

    const { messages, total, note, sessionMeta, isWorking, sessionFile } = data;

    if (sessionFile) {
      if (drawerSessionFile && drawerSessionFile !== sessionFile) {
        console.warn(`[agents] Session file changed for PID ${pid}: ${drawerSessionFile} → ${sessionFile} — forcing full re-render`);
        drawerRenderedMessagesPid = null;
        drawerRenderedMessageKeys = [];
      }
      drawerSessionFile = sessionFile;
    }

    document.getElementById('drawer-msg-count').textContent =
      total > messages.length ? `last ${messages.length} of ${total}` : `${messages.length} messages`;

    renderSessionMeta(sessionMeta);

    if (!messages.length) {
      container.innerHTML = `<div class="drawer-empty">
        ${note ? escHtml(note) : 'No messages found for this session.'}
      </div>`;
      drawerRenderedMessagesPid = pid;
      drawerRenderedMessageKeys = [];
      return;
    }

    const baseEntries = messages.map((m, idx) => ({ key: messageRenderKey(m, idx), html: renderMessage(m) }));
    const baseKeys = baseEntries.map(entry => entry.key);
    const oldBaseKeys = drawerRenderedMessageKeys.filter(key => key !== '__typing__');
    const canAppend =
      drawerRenderedMessagesPid === pid &&
      oldBaseKeys.length <= baseKeys.length &&
      oldBaseKeys.every((key, idx) => key === baseKeys[idx]);

    if (canAppend) {
      try {
        clearTypingIndicator(container);
        if (baseKeys.length > oldBaseKeys.length) {
          appendHtml(container, baseEntries.slice(oldBaseKeys.length).map(entry => entry.html).join(''));
        }
        if (isWorking) {
          appendHtml(container, renderTypingIndicator());
        }
        drawerRenderedMessagesPid = pid;
        drawerRenderedMessageKeys = [...baseKeys, ...(isWorking ? ['__typing__'] : [])];
        if (atBottom) container.scrollTop = container.scrollHeight;
        return;
      } catch {}
    }

    if (selectionInside) return;

    const previousBottomOffset = container.scrollHeight - container.scrollTop;
    let html = baseEntries.map(entry => entry.html).join('');
    if (isWorking) html += renderTypingIndicator();
    container.innerHTML = html;
    drawerRenderedMessagesPid = pid;
    drawerRenderedMessageKeys = [...baseKeys, ...(isWorking ? ['__typing__'] : [])];

    if (atBottom) container.scrollTop = container.scrollHeight;
    else container.scrollTop = Math.max(0, container.scrollHeight - previousBottomOffset);
  } catch (err) {
    container.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
    drawerRenderedMessagesPid = null;
    drawerRenderedMessageKeys = [];
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
    const maxCtx = meta.modelContextWindow || contextWindowSize(meta.model);
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
  if (drawerView === 'live') await refreshDrawerLiveTerminal();
  else if (!drawerCurrentPid) return;
  else if (drawerView === 'terminal') await fetchAndRenderTerminal(drawerCurrentPid);
  else if (drawerView === 'git') await fetchAndRenderGit(drawerCurrentPid);
  else if (drawerView === 'context') await fetchAndRenderContext(drawerCurrentPid);
  else await fetchAndRenderMessages(drawerCurrentPid);
}

// ─── Send / Input ─────────────────────────────────────────────────────────────

export function handleSendKeydown(e) {
  const textarea = e.target;
  const enterToSend = document.getElementById('drawer-enter-to-send').checked;

  if (e.key === 'Enter') {
    if (enterToSend && !e.shiftKey) {
      e.preventDefault();
      sendAgentMessage();
    }
  }

  requestAnimationFrame(() => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
  });
}

export async function sendAgentMessage() {
  const input = document.getElementById('drawer-send-input');
  const message = input.value.trim();
  const draftKey = drawerDraftKey;
  const pid = drawerCurrentPid;
  const tmuxSess = drawerTmuxSession;
  if (!message || (!pid && !tmuxSess)) return;

  // Normal sends should execute immediately in both messages and terminal views.
  // Use the quick-key buttons for raw terminal keystrokes like Enter or Escape.
  const noEnter = false;

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

// ─── Session Actions ──────────────────────────────────────────────────────────

export async function endDrawerSession() {
  if (!drawerCurrentPid) return;
  const name = document.getElementById('drawer-agent-name').textContent;
  if (!window.confirm(`Kill ${name} (PID ${drawerCurrentPid})?`)) return;
  try {
    await api('DELETE', `/api/agents/${drawerCurrentPid}`);
    toast(`${name} ended`);
    closeMessagesDrawer();
    setTimeout(() => window.loadAgents(), 1500);
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function relaunchDrawerSession() {
  if (!drawerCurrentPid) return;
  const name = document.getElementById('drawer-agent-name').textContent;
  if (!window.confirm(`Relaunch ${name}? This will kill and resume its session.`)) return;
  try {
    const { sessionName } = await api('POST', `/api/agents/${drawerCurrentPid}/relaunch`);
    toast(`${name} relaunched in "${sessionName}"`);
    closeMessagesDrawer();
    setTimeout(() => window.loadAgents(), 3000);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── Message Rendering ────────────────────────────────────────────────────────

function renderMessage(msg) {
  const isUser = msg.role === 'user';
  const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  const toolsHtml = (msg.tools || []).map(t => renderTool(t)).join('');
  const bodyText = simpleMarkdown(msg.text || '');

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
