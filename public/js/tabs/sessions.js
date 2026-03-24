import { api, toast, closeModal, escHtml, escAttr } from '../utils.js';

export async function loadSessions() {
  await Promise.all([
    loadTerminalPicker(),
    loadQuickConnect(),
    loadTerminalSessions(),
    loadSSHProcesses(),
    loadScreenSessions(),
    loadTmuxSessions(),
  ]);
}

export async function loadTerminalSessions() {
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
            <button class="btn btn-ghost btn-sm" onclick="window.focusSession('${escAttr(s.tty)}','${escAttr(s.app)}')">Focus</button>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  } catch (err) {
    el.innerHTML = `<div class="multiplexer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

export async function focusSession(tty, app) {
  try {
    await api('POST', '/api/sessions/focus', { tty, app });
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function loadTerminalPicker() {
  const { terminals } = await api('GET', '/api/sessions/terminals');
  const sel = document.getElementById('terminal-picker');
  sel.innerHTML = terminals.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
}

export async function loadQuickConnect() {
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
    const cmd = buildSSHCmd(block);

    return `<div class="qc-card">
      <div class="qc-card-name">${escHtml(block.Host)}</div>
      <div class="qc-card-host">${user ? user + '@' : ''}${escHtml(host)}${port && port !== '22' ? ':' + port : ''}</div>
      <div class="qc-card-actions">
        <button class="btn btn-primary btn-sm" onclick="window.launchSSH('${escAttr(cmd)}')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
          Connect
        </button>
        <button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText('${escAttr(cmd)}').then(()=>window.toast('Copied!'))" title="Copy command">
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

export async function launchSSH(command) {
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

export function launchCustom() {
  const cmd = document.getElementById('custom-ssh-cmd').value.trim();
  if (!cmd) return toast('Enter an SSH command', 'error');
  launchSSH(cmd);
}

export async function loadSSHProcesses() {
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
      <button class="btn btn-danger btn-sm" onclick="window.killSSHProcess('${escAttr(p.pid)}')">Kill</button>
    </td>
  </tr>`).join('');
}

export async function killSSHProcess(pid) {
  if (!window.confirm(`Kill SSH process ${pid}?`)) return;
  try {
    await api('DELETE', `/api/sessions/ssh/${pid}`);
    toast('Process killed');
    loadSSHProcesses();
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function loadScreenSessions() {
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
          <span class="mono text-small" style="color:var(--accent);cursor:pointer" title="Click to copy" onclick="navigator.clipboard.writeText('${escAttr(attachCmd)}').then(()=>window.toast('Copied!'))">${escHtml(attachCmd)}</span>
        </td>
        <td style="display:flex;gap:6px;justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" onclick="window.attachScreen('${escAttr(s.id)}')">Attach</button>
          <button class="btn btn-danger btn-sm" onclick="window.killScreen('${escAttr(s.id)}')">Kill</button>
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

export function openNewScreenModal() {
  document.getElementById('screen-session-name').value = '';
  document.getElementById('screen-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('screen-session-name').focus(), 50);
}

export async function createScreenSession(e) {
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

export async function killScreen(id) {
  if (!window.confirm(`Kill screen session "${id}"?`)) return;
  try {
    await api('DELETE', `/api/sessions/screen/${encodeURIComponent(id)}`);
    toast('Screen session killed');
    loadScreenSessions();
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function attachScreen(id) {
  launchSSH(`screen -r ${id}`);
}

export async function loadTmuxSessions() {
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
  const staleBtn = document.getElementById('tmux-kill-stale-btn');

  if (!sessions.length) {
    if (staleBtn) staleBtn.style.display = 'none';
    el.innerHTML = `<div class="multiplexer-empty">No tmux sessions — create one to get started</div>`;
    return;
  }

  if (staleBtn) staleBtn.style.display = sessions.length > 1 ? '' : 'none';

  el.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Name</th><th>Windows</th><th>Created</th><th>Status</th><th>Attach Command</th><th></th></tr></thead>
    <tbody>${sessions.map(s => {
      const attachCmd = `tmux attach -t ${s.name}`;
      const staleTag = s.stale ? '<span class="session-state-tag session-state-tag-stale">Stale</span>' : '';
      return `<tr>
        <td class="mono">${escHtml(s.name)}</td>
        <td class="text-muted text-small">${s.windows}</td>
        <td class="text-muted text-small">${escHtml(s.created)}</td>
        <td><span class="status-dot ${s.attached ? 'status-attached' : 'status-detached'}"></span>${s.attached ? 'Attached' : 'Detached'}${staleTag}</td>
        <td>
          <span class="mono text-small" style="color:var(--accent);cursor:pointer" title="Click to copy" onclick="navigator.clipboard.writeText('${escAttr(attachCmd)}').then(()=>window.toast('Copied!'))">${escHtml(attachCmd)}</span>
        </td>
        <td style="display:flex;gap:6px;justify-content:flex-end">
          <button class="btn btn-primary btn-sm" onclick="window.openTmuxTerminal('${escAttr(s.name)}')">Open</button>
          <button class="btn btn-ghost btn-sm" onclick="window.attachTmux('${escAttr(s.name)}')">Attach</button>
          <button class="btn btn-danger btn-sm" onclick="window.killTmux('${escAttr(s.name)}')">Kill</button>
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

export function openNewTmuxModal() {
  document.getElementById('tmux-session-name').value = '';
  document.getElementById('tmux-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('tmux-session-name').focus(), 50);
}

export async function createTmuxSession(e) {
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

export async function killTmux(name) {
  if (!window.confirm(`Kill tmux session "${name}"?`)) return;
  try {
    await api('DELETE', `/api/sessions/tmux/${encodeURIComponent(name)}`);
    toast('Tmux session killed');
    loadTmuxSessions();
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function attachTmux(name) {
  launchSSH(`tmux attach -t ${name}`);
}

export async function killStaleTmux() {
  if (!window.confirm('Kill all tmux sessions that have no running agent?')) return;
  try {
    const { killed, kept } = await api('DELETE', '/api/sessions/tmux-stale');
    toast(`Killed ${killed.length} stale session${killed.length !== 1 ? 's' : ''}, kept ${kept} active`);
    loadTmuxSessions();
  } catch (err) {
    toast(err.message, 'error');
  }
}
