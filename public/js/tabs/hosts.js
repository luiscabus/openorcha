import { api, toast, closeModal, escHtml, escAttr } from '../utils.js';

export async function loadHosts() {
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
          <button class="btn btn-ghost btn-sm btn-icon" title="Edit" onclick='window.openHostModal(${JSON.stringify(block)})'>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn btn-ghost btn-sm btn-icon" title="Delete" style="color:var(--danger)" onclick="window.deleteHost('${escAttr(block.Host)}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </div>
      </div>
      <div class="card-meta">
        ${optionRows}
        ${sshCmd ? `<div class="meta-row" style="margin-top:8px">
          <span class="meta-label" style="color:var(--text3)">ssh cmd</span>
          <span class="meta-value" style="color:var(--accent);cursor:pointer" title="Click to copy" onclick="navigator.clipboard.writeText('${escAttr(sshCmd)}').then(()=>window.toast('Copied!'))">${escHtml(sshCmd)}</span>
        </div>` : ''}
      </div>
    </div>`;
  }).join('');
}

export function openHostModal(block) {
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

export async function saveHost(e) {
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

export async function deleteHost(name) {
  if (!window.confirm(`Delete host "${name}"?`)) return;
  try {
    await api('DELETE', `/api/config/host/${encodeURIComponent(name)}`);
    toast('Host deleted');
    loadHosts();
  } catch (err) {
    toast(err.message, 'error');
  }
}
