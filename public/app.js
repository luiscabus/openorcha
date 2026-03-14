// ─── State ────────────────────────────────────────────────────────────────────
let allKnownHosts = [];
let currentPubKey = '';

// ─── Navigation ───────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const tab = link.dataset.tab;
    document.querySelectorAll('.nav-item').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    link.classList.add('active');
    document.getElementById(`tab-${tab}`).classList.add('active');
    loadTab(tab);
  });
});

function loadTab(tab) {
  if (tab === 'hosts') loadHosts();
  else if (tab === 'keys') loadKeys();
  else if (tab === 'known-hosts') loadKnownHosts();
  else if (tab === 'raw-config') loadRawConfig();
  else if (tab === 'sessions') loadSessions();
  else if (tab === 'agents') loadAgents();
}

// ─── Utils ────────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => el.classList.remove('show'), 3000);
}

function confirm(msg) {
  return window.confirm(msg);
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

// Close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.style.display = 'none';
  });
});

// ─── SSH Hosts ────────────────────────────────────────────────────────────────
async function loadHosts() {
  const { blocks } = await api('GET', '/api/config');
  const list = document.getElementById('hosts-list');

  if (!blocks.length) {
    list.innerHTML = `<div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
      <p>No SSH hosts configured</p>
      <small>Click "Add Host" to add your first entry</small>
    </div>`;
    return;
  }

  list.innerHTML = blocks.map(block => {
    const isWild = block.Host.includes('*');
    const hostname = block.options.HostName || '';
    const user = block.options.User || '';
    const port = block.options.Port || '22';

    const sshCmd = hostname
      ? `ssh ${user ? user + '@' : ''}${hostname}${port !== '22' ? ' -p ' + port : ''}`
      : '';

    const optionRows = Object.entries(block.options)
      .map(([k, v]) => `<div class="meta-row"><span class="meta-label">${k}</span><span class="meta-value">${escHtml(v)}</span></div>`)
      .join('');

    return `<div class="card${isWild ? ' host-wildcard' : ''}">
      <div class="card-header">
        <div>
          <div class="card-title">${escHtml(block.Host)}
            ${isWild ? '<span class="tag tag-gray" style="margin-left:6px">wildcard</span>' : ''}
          </div>
          ${hostname ? `<div class="card-subtitle">${user ? user + '@' : ''}${hostname}${port !== '22' ? ':' + port : ''}</div>` : ''}
        </div>
        <div class="card-actions">
          <button class="btn btn-ghost btn-sm btn-icon" title="Edit" onclick='openHostModal(${JSON.stringify(block)})'>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn btn-ghost btn-sm btn-icon" title="Delete" style="color:var(--danger)" onclick="deleteHost('${escAttr(block.Host)}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </div>
      </div>
      <div class="card-meta">
        ${optionRows}
        ${sshCmd ? `<div class="meta-row" style="margin-top:8px">
          <span class="meta-label" style="color:var(--text3)">ssh cmd</span>
          <span class="meta-value" style="color:var(--accent);cursor:pointer" title="Click to copy" onclick="navigator.clipboard.writeText('${escAttr(sshCmd)}').then(()=>toast('Copied!'))">${escHtml(sshCmd)}</span>
        </div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function openHostModal(block) {
  document.getElementById('host-modal-title').textContent = block ? 'Edit SSH Host' : 'Add SSH Host';
  document.getElementById('host-form').reset();
  document.getElementById('host-original-name').value = '';

  if (block) {
    document.getElementById('host-original-name').value = block.Host;
    document.getElementById('host-alias').value = block.Host;
    document.getElementById('host-hostname').value = block.options.HostName || '';
    document.getElementById('host-user').value = block.options.User || '';
    document.getElementById('host-port').value = block.options.Port || '';
    document.getElementById('host-identity').value = block.options.IdentityFile || '';
    document.getElementById('host-proxyjump').value = block.options.ProxyJump || '';
    document.getElementById('host-alive').value = block.options.ServerAliveInterval || '';
    document.getElementById('host-forward-agent').value = block.options.ForwardAgent || '';

    const knownKeys = new Set(['HostName','User','Port','IdentityFile','ProxyJump','ServerAliveInterval','ForwardAgent']);
    const extra = Object.entries(block.options)
      .filter(([k]) => !knownKeys.has(k))
      .map(([k, v]) => `${k} ${v}`)
      .join('\n');
    document.getElementById('host-extra').value = extra;
  }

  document.getElementById('host-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('host-alias').focus(), 50);
}

async function saveHost(e) {
  e.preventDefault();
  const Host = document.getElementById('host-alias').value.trim();
  const originalHost = document.getElementById('host-original-name').value;

  const options = {};
  const addOpt = (id, key) => {
    const v = document.getElementById(id).value.trim();
    if (v) options[key] = v;
  };
  addOpt('host-hostname', 'HostName');
  addOpt('host-user', 'User');
  addOpt('host-port', 'Port');
  addOpt('host-identity', 'IdentityFile');
  addOpt('host-proxyjump', 'ProxyJump');
  addOpt('host-alive', 'ServerAliveInterval');
  addOpt('host-forward-agent', 'ForwardAgent');

  const extra = document.getElementById('host-extra').value.trim();
  if (extra) {
    for (const line of extra.split('\n')) {
      const m = line.trim().match(/^(\S+)\s+(.+)$/);
      if (m) options[m[1]] = m[2];
    }
  }

  try {
    await api('POST', '/api/config/host', { Host, options, originalHost });
    closeModal('host-modal');
    toast('Host saved');
    loadHosts();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteHost(name) {
  if (!confirm(`Delete host "${name}"?`)) return;
  try {
    await api('DELETE', `/api/config/host/${encodeURIComponent(name)}`);
    toast('Host deleted');
    loadHosts();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── SSH Keys ─────────────────────────────────────────────────────────────────
async function loadKeys() {
  const { keys } = await api('GET', '/api/keys');
  const list = document.getElementById('keys-list');

  if (!keys.length) {
    list.innerHTML = `<div class="empty-state">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
      <p>No SSH keys found</p>
      <small>Click "Generate Key" to create a new key pair</small>
    </div>`;
    return;
  }

  list.innerHTML = keys.map(key => {
    const typeColor = { ed25519: 'tag-green', rsa: 'tag-blue', ecdsa: 'tag-blue' }[key.type?.replace('ssh-','').split('-')[0]] || 'tag-gray';
    const modified = new Date(key.modified).toLocaleDateString();

    return `<div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">
            ${escHtml(key.name)}
            <span class="tag ${typeColor}" style="margin-left:6px">${escHtml(key.type)}</span>
          </div>
          <div class="card-subtitle">${key.comment ? escHtml(key.comment) : 'No comment'}</div>
        </div>
        <div class="card-actions">
          <button class="btn btn-ghost btn-sm" onclick="showPublicKey('${escAttr(key.name)}', '${escAttr(key.publicKey)}')">
            View
          </button>
          <button class="btn btn-ghost btn-sm btn-icon" style="color:var(--danger)" title="Delete" onclick="deleteKey('${escAttr(key.name)}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </div>
      </div>
      <div class="card-meta">
        <div class="meta-row">
          <span class="meta-label">Private key</span>
          <span class="meta-value">${key.hasPrivate ? '✓ present' : '✗ missing'}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Path</span>
          <span class="meta-value">${escHtml(key.pubPath)}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Modified</span>
          <span class="meta-value">${modified}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function openKeyModal() {
  document.getElementById('key-form').reset();
  document.getElementById('key-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('key-name').focus(), 50);
}

async function generateKey(e) {
  e.preventDefault();
  const name = document.getElementById('key-name').value.trim();
  const type = document.getElementById('key-type').value;
  const comment = document.getElementById('key-comment').value.trim();
  const passphrase = document.getElementById('key-passphrase').value;

  try {
    await api('POST', '/api/keys/generate', { name, type, comment, passphrase });
    closeModal('key-modal');
    toast('Key pair generated!');
    loadKeys();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteKey(name) {
  if (!confirm(`Delete key "${name}" (both private and public)?`)) return;
  try {
    await api('DELETE', `/api/keys/${encodeURIComponent(name)}`);
    toast('Key deleted');
    loadKeys();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function showPublicKey(name, pubKey) {
  currentPubKey = pubKey;
  document.getElementById('pubkey-modal-title').textContent = name + '.pub';
  document.getElementById('pubkey-content').textContent = pubKey;
  document.getElementById('pubkey-modal').style.display = 'flex';
}

function copyPubKey() {
  navigator.clipboard.writeText(currentPubKey).then(() => toast('Public key copied!'));
}

// ─── Known Hosts ──────────────────────────────────────────────────────────────
async function loadKnownHosts() {
  const { entries } = await api('GET', '/api/known-hosts');
  allKnownHosts = entries;
  renderKnownHosts(entries);
}

function renderKnownHosts(entries) {
  const tbody = document.getElementById('known-hosts-body');
  if (!entries.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:40px">No known hosts found</td></tr>`;
    return;
  }

  tbody.innerHTML = entries.map(e => {
    const parts = e.line.split(' ');
    const hostPart = parts[0] || '';
    const keyType = parts[1] || '';
    const keyData = parts[2] || '';
    const fingerprint = keyData.length > 16
      ? keyData.substring(0, 8) + '...' + keyData.slice(-8)
      : keyData;

    // Host might be hashed (|1|...) or plain
    const displayHost = hostPart.startsWith('|')
      ? `<span class="mono text-muted text-small" title="${escAttr(hostPart)}">[hashed]</span>`
      : `<span class="mono">${escHtml(hostPart)}</span>`;

    return `<tr>
      <td>${displayHost}</td>
      <td><span class="tag tag-gray">${escHtml(keyType)}</span></td>
      <td class="mono text-muted text-small">${escHtml(fingerprint)}</td>
      <td>
        <button class="btn btn-danger btn-sm" onclick="removeKnownHost('${escAttr(hostPart)}')">Remove</button>
      </td>
    </tr>`;
  }).join('');
}

function filterKnownHosts() {
  const q = document.getElementById('known-hosts-search').value.toLowerCase();
  const filtered = allKnownHosts.filter(e => e.line.toLowerCase().includes(q));
  renderKnownHosts(filtered);
}

async function removeKnownHost(host) {
  if (!confirm(`Remove "${host}" from known_hosts?`)) return;
  try {
    await api('DELETE', '/api/known-hosts', { host });
    toast('Removed from known_hosts');
    loadKnownHosts();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── Raw Config ───────────────────────────────────────────────────────────────
async function loadRawConfig() {
  const { content } = await api('GET', '/api/config/raw');
  document.getElementById('raw-config-editor').value = content;
}

async function saveRawConfig() {
  const content = document.getElementById('raw-config-editor').value;
  try {
    await api('PUT', '/api/config/raw', { content });
    toast('Config saved');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  return String(str ?? '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ─── AI Agents ────────────────────────────────────────────────────────────────

const AGENT_META = {
  claude:   { label: 'C', color: 'claude',   accent: '#e08a6a' },
  codex:    { label: 'X', color: 'codex',    accent: '#3ecf8e' },
  gemini:   { label: 'G', color: 'gemini',   accent: '#6ba3ff' },
  opencode: { label: 'O', color: 'opencode', accent: '#f5a623' },
  aider:    { label: 'A', color: 'aider',    accent: '#a78bfa' },
  continue: { label: 'C', color: 'continue', accent: '#fc8181' },
};

let agentsAutoRefreshTimer = null;

function toggleAgentAutoRefresh() {
  const on = document.getElementById('agents-auto-refresh').checked;
  clearInterval(agentsAutoRefreshTimer);
  if (on) agentsAutoRefreshTimer = setInterval(loadAgents, 10000);
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

async function loadAgents() {
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

    list.innerHTML = agents.map(a => {
      const meta = AGENT_META[a.agentId] || { label: '?', color: 'aider', accent: '#888' };
      const termBadge = a.terminalApp
        ? `<span class="app-badge app-badge-${a.terminalApp.toLowerCase()}">${escHtml(a.terminalApp)}</span>`
        : '';

      return `<div class="agent-card" style="cursor:pointer" onclick="openAgentMessages('${escAttr(a.pid)}','${escAttr(a.agentId)}','${escAttr(a.agentName)}','${escAttr(a.cwd||'')}')" title="Click to view conversation">
        <div class="agent-card-header">
          <div class="agent-icon agent-icon-${a.agentId}">${meta.label}</div>
          <div class="agent-name">${escHtml(a.agentName)}</div>
          ${termBadge}
          <span class="agent-pid">PID ${escHtml(a.pid)}</span>
        </div>
        <div class="agent-card-body">
          <div class="agent-row">
            <span class="agent-label">Project</span>
            <span class="agent-value agent-value-project" title="${escAttr(a.cwd || '')}">${escHtml(a.project || a.cwd || '—')}</span>
          </div>
          ${a.cwd ? `<div class="agent-row">
            <span class="agent-label">Path</span>
            <span class="agent-value" title="${escAttr(a.cwd)}">${escHtml(a.cwd)}</span>
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
            ${a.tty && a.terminalApp ? `<button class="btn btn-ghost btn-sm" onclick="focusSession('${escAttr(a.tty)}','${escAttr(a.terminalApp || '')}')">Focus</button>` : ''}
            <button class="btn btn-danger btn-sm" onclick="killAgent('${escAttr(a.pid)}','${escAttr(a.agentName)}')">Kill</button>
          </div>
        </div>
      </div>`;
    }).join('');

  } catch (err) {
    list.innerHTML = `<div class="empty-state"><p style="color:var(--danger)">${escHtml(err.message)}</p></div>`;
  }
}

// ─── Agent Messages Drawer ────────────────────────────────────────────────────

let drawerCurrentPid = null;

async function openAgentMessages(pid, agentId, agentName, cwd) {
  drawerCurrentPid = pid;
  const meta = AGENT_META[agentId] || { label: '?', color: 'aider' };

  // Set up header
  const icon = document.getElementById('drawer-agent-icon');
  icon.textContent = meta.label;
  icon.className = `agent-icon agent-icon-${agentId}`;
  document.getElementById('drawer-agent-name').textContent = agentName;
  document.getElementById('drawer-agent-cwd').textContent = cwd || '';
  document.getElementById('drawer-msg-count').textContent = '';
  document.getElementById('drawer-messages').innerHTML = `<div class="drawer-loading">Loading conversation…</div>`;

  document.getElementById('messages-drawer').style.display = 'flex';
  await fetchAndRenderMessages(pid);
}

async function fetchAndRenderMessages(pid) {
  const container = document.getElementById('drawer-messages');
  try {
    const data = await api('GET', `/api/agents/${pid}/messages`);
    const { messages, total, note } = data;

    document.getElementById('drawer-msg-count').textContent =
      total > messages.length ? `last ${messages.length} of ${total}` : `${messages.length} messages`;

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

async function refreshDrawer() {
  if (drawerCurrentPid) await fetchAndRenderMessages(drawerCurrentPid);
}

function closeMessagesDrawer() {
  document.getElementById('messages-drawer').style.display = 'none';
  drawerCurrentPid = null;
}

function closeDrawerOnOverlay(e) {
  if (e.target === document.getElementById('messages-drawer')) closeMessagesDrawer();
}

function renderMessage(msg) {
  const isUser = msg.role === 'user';
  const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  const toolsHtml = (msg.tools || []).map(t => {
    const icon = toolIcon(t.name);
    return `<span class="msg-tool-pill">${icon}${escHtml(t.name)}</span>`;
  }).join('');

  const bodyText = simpleMarkdown(msg.text || '');

  return `<div class="msg-entry ${isUser ? 'user' : 'assistant'}">
    <div class="msg-role-row">
      <span class="msg-role-label ${isUser ? 'msg-role-user' : 'msg-role-assistant'}">${isUser ? 'You' : 'Agent'}</span>
      ${timeStr ? `<span class="msg-timestamp">${timeStr}</span>` : ''}
    </div>
    ${bodyText ? `<div class="msg-body">${bodyText}</div>` : ''}
    ${toolsHtml ? `<div class="msg-tools">${toolsHtml}</div>` : ''}
  </div>`;
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

function agentFullName(id) {
  const names = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode', aider: 'Aider', continue: 'Continue' };
  return names[id] || id;
}

async function killAgent(pid, name) {
  if (!confirm(`Kill ${name} (PID ${pid})?`)) return;
  try {
    await api('DELETE', `/api/agents/${pid}`);
    toast(`${name} killed`);
    loadAgents();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// Stop auto-refresh when leaving the tab
document.querySelectorAll('.nav-item').forEach(link => {
  link.addEventListener('click', () => {
    if (link.dataset.tab !== 'agents') {
      clearInterval(agentsAutoRefreshTimer);
      const cb = document.getElementById('agents-auto-refresh');
      if (cb) cb.checked = false;
    }
  });
});

// ─── Sessions ─────────────────────────────────────────────────────────────────

async function loadSessions() {
  await Promise.all([
    loadTerminalPicker(),
    loadQuickConnect(),
    loadTerminalSessions(),
    loadSSHProcesses(),
    loadScreenSessions(),
    loadTmuxSessions(),
  ]);
}

async function loadTerminalSessions() {
  const el = document.getElementById('terminal-sessions-body');
  el.innerHTML = `<div style="color:var(--text3);font-size:13px;padding:8px 0">Loading...</div>`;
  try {
    const { sessions } = await api('GET', '/api/sessions/terminal-sessions');

    if (!sessions.length) {
      el.innerHTML = `<div class="multiplexer-empty">No open terminal sessions detected</div>`;
      return;
    }

    const appBadgeClass = { Warp: 'app-badge-warp', iTerm2: 'app-badge-iterm2', Terminal: 'app-badge-terminal' };

    el.innerHTML = `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>App</th><th>TTY</th><th>Session / Command</th><th>Shell</th><th>Status</th><th></th></tr></thead>
      <tbody>${sessions.map(s => {
        const badge = appBadgeClass[s.app] || 'app-badge-terminal';
        const titleOrCmd = s.title || (s.command ? s.command : (s.idle ? '(idle)' : s.fgComm || ''));
        const statusHtml = s.idle
          ? `<span style="color:var(--text3);font-size:12px">idle</span>`
          : `<span class="running-dot"></span><span style="font-size:12px;color:var(--success)">${escHtml(s.fgComm || 'running')}</span>`;

        return `<tr>
          <td><span class="app-badge ${badge}">${escHtml(s.app)}</span></td>
          <td class="mono text-small text-muted">${escHtml(s.tty)}</td>
          <td>
            <span class="session-cmd" title="${escAttr(s.command || titleOrCmd)}">${escHtml(titleOrCmd)}</span>
          </td>
          <td class="mono text-small text-muted">${escHtml(s.shell)}</td>
          <td>${statusHtml}</td>
          <td>
            <button class="btn btn-ghost btn-sm" onclick="focusSession('${escAttr(s.tty)}','${escAttr(s.app)}')">Focus</button>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  } catch (err) {
    el.innerHTML = `<div class="multiplexer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

async function focusSession(tty, app) {
  try {
    await api('POST', '/api/sessions/focus', { tty, app });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadTerminalPicker() {
  const { terminals } = await api('GET', '/api/sessions/terminals');
  const sel = document.getElementById('terminal-picker');
  sel.innerHTML = terminals.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
}

async function loadQuickConnect() {
  const { blocks } = await api('GET', '/api/config');
  const list = document.getElementById('quick-connect-list');
  const hosts = blocks.filter(b => !b.Host.includes('*') && b.options.HostName);

  if (!hosts.length) {
    list.innerHTML = `<div style="color:var(--text3);font-size:13px;padding:8px 0">
      No hosts with HostName configured — add hosts in the SSH Hosts tab.
    </div>`;
    return;
  }

  list.innerHTML = hosts.map(block => {
    const user = block.options.User || '';
    const host = block.options.HostName;
    const port = block.options.Port;
    const identity = block.options.IdentityFile || '';
    const cmd = buildSSHCmd(block);

    return `<div class="qc-card">
      <div class="qc-card-name">${escHtml(block.Host)}</div>
      <div class="qc-card-host">${user ? user + '@' : ''}${escHtml(host)}${port && port !== '22' ? ':' + port : ''}</div>
      <div class="qc-card-actions">
        <button class="btn btn-primary btn-sm" onclick="launchSSH('${escAttr(cmd)}')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
          Connect
        </button>
        <button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText('${escAttr(cmd)}').then(()=>toast('Copied!'))" title="Copy command">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

function buildSSHCmd(block) {
  const user = block.options.User;
  const host = block.options.HostName || block.Host;
  const port = block.options.Port;
  const identity = block.options.IdentityFile;
  const parts = ['ssh'];
  if (port && port !== '22') parts.push(`-p ${port}`);
  if (identity) parts.push(`-i ${identity}`);
  parts.push(user ? `${user}@${host}` : host);
  return parts.join(' ');
}

async function launchSSH(command) {
  const terminal = document.getElementById('terminal-picker').value;
  // Copy to clipboard first for Warp (no AppleScript command support)
  if (terminal === 'warp') {
    await navigator.clipboard.writeText(command);
  }
  try {
    const data = await api('POST', '/api/sessions/launch', { command, terminal });
    toast(data.note || `Launched in ${terminal}`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function launchCustom() {
  const cmd = document.getElementById('custom-ssh-cmd').value.trim();
  if (!cmd) return toast('Enter an SSH command', 'error');
  launchSSH(cmd);
}

async function loadSSHProcesses() {
  const { processes } = await api('GET', '/api/sessions/ssh');
  const tbody = document.getElementById('ssh-procs-body');

  if (!processes.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:28px">No active SSH processes</td></tr>`;
    return;
  }

  tbody.innerHTML = processes.map(p => `<tr>
    <td class="mono text-small">${escHtml(p.pid)}</td>
    <td><span class="proc-cmd" title="${escAttr(p.command)}">${escHtml(p.command)}</span></td>
    <td class="text-muted text-small">${escHtml(p.user)}</td>
    <td class="text-muted text-small">${escHtml(p.cpu)}%</td>
    <td class="text-muted text-small">${escHtml(p.mem)}%</td>
    <td class="text-muted text-small mono">${escHtml(p.time)}</td>
    <td>
      <button class="btn btn-danger btn-sm" onclick="killSSHProcess('${escAttr(p.pid)}')">Kill</button>
    </td>
  </tr>`).join('');
}

async function killSSHProcess(pid) {
  if (!confirm(`Kill SSH process ${pid}?`)) return;
  try {
    await api('DELETE', `/api/sessions/ssh/${pid}`);
    toast('Process killed');
    loadSSHProcesses();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadScreenSessions() {
  const { installed, sessions } = await api('GET', '/api/sessions/screen');
  const el = document.getElementById('screen-sessions-body');

  if (!installed) {
    el.innerHTML = `<div class="multiplexer-not-installed">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      screen is not installed on this system
    </div>`;
    document.querySelector('#screen-section .btn-ghost').style.display = 'none';
    return;
  }

  if (!sessions.length) {
    el.innerHTML = `<div class="multiplexer-empty">No screen sessions — create one to get started</div>`;
    return;
  }

  el.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Name</th><th>PID</th><th>Status</th><th>Attach Command</th><th></th></tr></thead>
    <tbody>${sessions.map(s => {
      const isAttached = s.status.toLowerCase().includes('attach');
      const attachCmd = `screen -r ${s.id}`;
      return `<tr>
        <td class="mono">${escHtml(s.name)}</td>
        <td class="mono text-small text-muted">${escHtml(s.pid)}</td>
        <td><span class="status-dot ${isAttached ? 'status-attached' : 'status-detached'}"></span>${escHtml(s.status)}</td>
        <td>
          <span class="mono text-small" style="color:var(--accent);cursor:pointer" title="Click to copy" onclick="navigator.clipboard.writeText('${escAttr(attachCmd)}').then(()=>toast('Copied!'))">${escHtml(attachCmd)}</span>
        </td>
        <td style="display:flex;gap:6px;justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" onclick="attachScreen('${escAttr(s.id)}')">Attach</button>
          <button class="btn btn-danger btn-sm" onclick="killScreen('${escAttr(s.id)}')">Kill</button>
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function openNewScreenModal() {
  document.getElementById('screen-session-name').value = '';
  document.getElementById('screen-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('screen-session-name').focus(), 50);
}

async function createScreenSession(e) {
  e.preventDefault();
  const name = document.getElementById('screen-session-name').value.trim();
  try {
    await api('POST', '/api/sessions/screen', { name });
    closeModal('screen-modal');
    toast(`Screen session "${name}" created`);
    loadScreenSessions();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function killScreen(id) {
  if (!confirm(`Kill screen session "${id}"?`)) return;
  try {
    await api('DELETE', `/api/sessions/screen/${encodeURIComponent(id)}`);
    toast('Screen session killed');
    loadScreenSessions();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function attachScreen(id) {
  launchSSH(`screen -r ${id}`);
}

async function loadTmuxSessions() {
  const { installed, sessions } = await api('GET', '/api/sessions/tmux');
  const el = document.getElementById('tmux-sessions-body');
  const newBtn = document.getElementById('tmux-new-btn');

  if (!installed) {
    el.innerHTML = `<div class="multiplexer-not-installed">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      tmux is not installed — <code style="font-size:12px;margin-left:4px">brew install tmux</code>
    </div>`;
    if (newBtn) newBtn.style.display = 'none';
    return;
  }

  if (newBtn) newBtn.style.display = '';

  if (!sessions.length) {
    el.innerHTML = `<div class="multiplexer-empty">No tmux sessions — create one to get started</div>`;
    return;
  }

  el.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Name</th><th>Windows</th><th>Created</th><th>Status</th><th>Attach Command</th><th></th></tr></thead>
    <tbody>${sessions.map(s => {
      const attachCmd = `tmux attach -t ${s.name}`;
      return `<tr>
        <td class="mono">${escHtml(s.name)}</td>
        <td class="text-muted text-small">${s.windows}</td>
        <td class="text-muted text-small">${escHtml(s.created)}</td>
        <td><span class="status-dot ${s.attached ? 'status-attached' : 'status-detached'}"></span>${s.attached ? 'Attached' : 'Detached'}</td>
        <td>
          <span class="mono text-small" style="color:var(--accent);cursor:pointer" title="Click to copy" onclick="navigator.clipboard.writeText('${escAttr(attachCmd)}').then(()=>toast('Copied!'))">${escHtml(attachCmd)}</span>
        </td>
        <td style="display:flex;gap:6px;justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" onclick="attachTmux('${escAttr(s.name)}')">Attach</button>
          <button class="btn btn-danger btn-sm" onclick="killTmux('${escAttr(s.name)}')">Kill</button>
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function openNewTmuxModal() {
  document.getElementById('tmux-session-name').value = '';
  document.getElementById('tmux-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('tmux-session-name').focus(), 50);
}

async function createTmuxSession(e) {
  e.preventDefault();
  const name = document.getElementById('tmux-session-name').value.trim();
  try {
    await api('POST', '/api/sessions/tmux', { name });
    closeModal('tmux-modal');
    toast(`Tmux session "${name}" created`);
    loadTmuxSessions();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function killTmux(name) {
  if (!confirm(`Kill tmux session "${name}"?`)) return;
  try {
    await api('DELETE', `/api/sessions/tmux/${encodeURIComponent(name)}`);
    toast('Tmux session killed');
    loadTmuxSessions();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function attachTmux(name) {
  launchSSH(`tmux attach -t ${name}`);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
loadHosts();
