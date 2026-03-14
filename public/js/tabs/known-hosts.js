import { api, toast, escHtml, escAttr } from '../utils.js';

let allKnownHosts = [];

export async function loadKnownHosts() {
  const { entries } = await api('GET', '/api/known-hosts');
  allKnownHosts = entries;
  renderKnownHosts(entries);
}

export function renderKnownHosts(entries) {
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
        <button class="btn btn-danger btn-sm" onclick="window.removeKnownHost('${escAttr(hostPart)}')">Remove</button>
      </td>
    </tr>`;
  }).join('');
}

export function filterKnownHosts() {
  const q = document.getElementById('known-hosts-search').value.toLowerCase();
  const filtered = allKnownHosts.filter(e => e.line.toLowerCase().includes(q));
  renderKnownHosts(filtered);
}

export async function removeKnownHost(host) {
  if (!window.confirm(`Remove "${host}" from known_hosts?`)) return;
  try {
    await api('DELETE', '/api/known-hosts', { host });
    toast('Removed from known_hosts');
    loadKnownHosts();
  } catch (err) {
    toast(err.message, 'error');
  }
}
