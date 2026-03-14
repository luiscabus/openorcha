import { api, toast, closeModal, escHtml, escAttr } from '../utils.js';

let currentPubKey = '';

export async function loadKeys() {
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
          <button class="btn btn-ghost btn-sm" onclick="window.showPublicKey('${escAttr(key.name)}', '${escAttr(key.publicKey)}')">
            View
          </button>
          <button class="btn btn-ghost btn-sm btn-icon" style="color:var(--danger)" title="Delete" onclick="window.deleteKey('${escAttr(key.name)}')">
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

export function openKeyModal() {
  document.getElementById('key-form').reset();
  document.getElementById('key-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('key-name').focus(), 50);
}

export async function generateKey(e) {
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

export async function deleteKey(name) {
  if (!window.confirm(`Delete key "${name}" (both private and public)?`)) return;
  try {
    await api('DELETE', `/api/keys/${encodeURIComponent(name)}`);
    toast('Key deleted');
    loadKeys();
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function showPublicKey(name, pubKey) {
  currentPubKey = pubKey;
  document.getElementById('pubkey-modal-title').textContent = name + '.pub';
  document.getElementById('pubkey-content').textContent = pubKey;
  document.getElementById('pubkey-modal').style.display = 'flex';
}

export function copyPubKey() {
  navigator.clipboard.writeText(currentPubKey).then(() => toast('Public key copied!'));
}
