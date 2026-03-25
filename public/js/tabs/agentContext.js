import { api, toast, escHtml, escAttr } from '../utils.js';
import { CONTEXT_UI_STATE_KEY, getDrawerCurrentPid } from './agentShared.js';

// ─── Context UI State ─────────────────────────────────────────────────────────

function readContextUiState() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CONTEXT_UI_STATE_KEY) || 'null');
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return {};
}

let contextUiState = readContextUiState();

function persistContextUiState() {
  window.localStorage.setItem(CONTEXT_UI_STATE_KEY, JSON.stringify(contextUiState));
}

function makeContextUiKey(agentId, cwd, kind, name) {
  return [agentId || 'unknown', cwd || '', kind, name || ''].join('::');
}

function contextDomKey(key) {
  return encodeURIComponent(key);
}

function isContextBlockOpen(key, defaultOpen = true) {
  if (Object.prototype.hasOwnProperty.call(contextUiState, key)) return !!contextUiState[key];
  return defaultOpen;
}

function setContextBlockOpen(key, open) {
  contextUiState[key] = !!open;
  persistContextUiState();
}

function applyContextBlockState(node, open) {
  if (!node) return;
  node.classList.toggle('is-open', !!open);
  node.classList.toggle('is-collapsed', !open);
  const toggle = node.firstElementChild;
  const body = node.children[1];
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (body) body.hidden = !open;
}

export function toggleContextBlock(targetOrKey) {
  let key = null;
  let nodes = [];
  let currentOpen = true;

  if (typeof targetOrKey === 'string') {
    key = decodeURIComponent(targetOrKey);
    nodes = Array.from(document.querySelectorAll(`[data-context-key="${targetOrKey}"]`));
    currentOpen = isContextBlockOpen(key, true);
  } else {
    const toggle = targetOrKey?.closest?.('.ctx-collapsible-toggle');
    const node = toggle?.closest?.('[data-context-key]');
    const domKey = node?.getAttribute('data-context-key');
    if (!domKey) return;
    key = decodeURIComponent(domKey);
    nodes = [node];
    currentOpen = toggle?.getAttribute('aria-expanded') === 'true';
  }

  if (!key || !nodes.length) return;
  const nextOpen = !currentOpen;
  setContextBlockOpen(key, nextOpen);
  nodes.forEach(node => applyContextBlockState(node, nextOpen));
}

// ─── Context Tab Rendering ────────────────────────────────────────────────────

export async function fetchAndRenderContext(pid) {
  const container = document.getElementById('drawer-context');
  container.innerHTML = `<div class="drawer-loading">Loading context…</div>`;
  try {
    const data = await api('GET', `/api/agents/${pid}/context`);
    const { sections, agentId, cwd } = data;

    let html = '';

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

    container.innerHTML = html + `<div class="ctx-stack">${sections.map(s => renderContextSection(s, agentId, cwd)).join('')}</div>`;
  } catch (err) {
    container.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

function renderContextBlock({ key, open = true, className, headerClass, bodyClass = '', headerHtml, bodyHtml }) {
  const domKey = contextDomKey(key);
  const bodyClassName = bodyClass ? `${bodyClass} ctx-collapsible-body` : 'ctx-collapsible-body';
  return `<section class="${className}${open ? ' is-open' : ' is-collapsed'}" data-context-key="${escAttr(domKey)}">
    <button type="button" class="${headerClass} ctx-collapsible-toggle" aria-expanded="${open ? 'true' : 'false'}" onclick="window.toggleContextBlock(this)">
      ${headerHtml}
      <span class="ctx-collapse-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </span>
    </button>
    <div class="${bodyClassName}"${open ? '' : ' hidden'}>
      ${bodyHtml}
    </div>
  </section>`;
}

function renderContextMemoryEntry(memory, agentId, cwd, kind, defaultOpen = false) {
  const entryKey = makeContextUiKey(agentId, cwd, kind, memory.file || memory.name || kind);
  const open = isContextBlockOpen(entryKey, defaultOpen);
  const typeBadge = `<span class="ctx-mem-type">${escHtml(memory.type || 'note')}</span>`;
  const name = memory.name || memory.file || 'Untitled';
  const fileBadge = memory.file ? `<span class="ctx-memory-file">${escHtml(memory.file)}</span>` : '';
  const description = memory.description
    ? `<span class="ctx-memory-desc">${escHtml(memory.description)}</span>`
    : '';

  return renderContextBlock({
    key: entryKey,
    open,
    className: 'ctx-memory',
    headerClass: 'ctx-memory-summary',
    bodyClass: 'ctx-memory-panel',
    headerHtml: `${typeBadge}
      <div class="ctx-memory-headings">
        <span class="ctx-memory-name">${escHtml(name)}</span>
        ${description}
      </div>
      ${fileBadge}`,
    bodyHtml: `<pre class="ctx-memory-body">${escHtml(memory.body || '')}</pre>`,
  });
}

function renderContextSection(section, agentId, cwd) {
  const scopeBadge = `<span class="ctx-scope ctx-scope-${section.scope}">${section.scope}</span>`;
  const icon = contextIcon(section.icon);
  const sectionKey = makeContextUiKey(agentId, cwd, 'section', `${section.scope}:${section.title}`);
  let countBadge = '';
  let bodyHtml = '';

  if (section.servers) {
    const enabledCount = section.servers.filter(s => !s.disabled).length;
    countBadge = `<span class="ctx-active-count">${enabledCount}/${section.servers.length}</span>`;
    bodyHtml = `<div class="ctx-servers">${section.servers.map(s => {
      const sBadge = `<span class="ctx-scope ctx-scope-${s.scope}">${s.scope}</span>`;
      const isOAuth = s.type === 'oauth';
      const toggleId = `mcp-toggle-${escAttr(s.name)}`;
      const toggleHtml = isOAuth ? '' : `<label class="mcp-toggle" title="${s.disabled ? 'Enable' : 'Disable'} this MCP server">
          <input type="checkbox" id="${toggleId}" ${s.disabled ? '' : 'checked'} onchange="window.toggleMcpServer('${escAttr(s.name)}','${escAttr(s.scope)}',!this.checked)">
          <span class="mcp-toggle-slider"></span>
        </label>`;
      return `<div class="ctx-server-row${s.disabled ? ' ctx-server-disabled' : ''}">
        <div class="ctx-server-main">
          <span class="ctx-server-name">${escHtml(s.name)}</span>
          <span class="ctx-server-source">${escHtml(s.source || '')}</span>
        </div>
        <div class="ctx-server-meta">
          <span class="ctx-server-type">${escHtml(s.type)}</span>
          ${sBadge}
          ${toggleHtml}
        </div>
      </div>`;
    }).join('')}</div>`;
  } else if (section.plugins) {
    countBadge = `<span class="ctx-active-count">${section.plugins.length}</span>`;
    bodyHtml = `<div class="ctx-plugins">${section.plugins.map(p => {
      const statusLabel = p.active ? 'active' : p.hasMcp ? 'available' : 'skill';
      const typeLabel = p.builtin ? 'builtin' : 'external';
      return `<div class="ctx-plugin-row${p.active ? ' ctx-plugin-row-active' : ''}">
        <div class="ctx-plugin-main">
          <span class="ctx-plugin-name">${escHtml(p.name)}</span>
          ${p.description ? `<span class="ctx-plugin-desc">${escHtml(p.description)}</span>` : ''}
        </div>
        <div class="ctx-plugin-meta">
          <span class="ctx-plugin-badge ctx-plugin-badge-${statusLabel}">${statusLabel}</span>
          <span class="ctx-plugin-type">${typeLabel}</span>
        </div>
      </div>`;
    }).join('')}</div>`;
  } else if (section.memories) {
    const blocks = [];
    if (section.index && section.index.trim()) {
      blocks.push(renderContextMemoryEntry({
        file: 'MEMORY.md',
        name: 'Memory Index',
        type: 'index',
        description: 'Project-wide memory overview',
        body: section.index,
      }, agentId, cwd, 'memory-index', true));
    }
    if (section.memories.length) {
      countBadge = `<span class="ctx-active-count">${section.memories.length}</span>`;
      blocks.push(`<div class="ctx-memory-list">${section.memories.map(m => renderContextMemoryEntry(m, agentId, cwd, 'memory-entry')).join('')}</div>`);
    }
    bodyHtml = blocks.join('') || '<div class="ctx-section-empty">No memory entries available.</div>';
  } else if (section.content) {
    bodyHtml = `<pre class="ctx-doc-content">${escHtml(section.content)}</pre>`;
  } else if (section.items) {
    bodyHtml = `<div class="ctx-items">${section.items.map(item => `<div class="ctx-item-row">
      <span class="ctx-item-label">${escHtml(item.label)}</span>
      <span class="ctx-item-value">${escHtml(item.value)}</span>
    </div>`).join('')}</div>`;
  } else {
    return '';
  }

  return renderContextBlock({
    key: sectionKey,
    open: isContextBlockOpen(sectionKey, true),
    className: 'ctx-section',
    headerClass: 'ctx-section-header',
    bodyClass: 'ctx-section-body',
    headerHtml: `${icon}<span class="ctx-section-title">${escHtml(section.title)}</span>${countBadge}${scopeBadge}`,
    bodyHtml,
  });
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

export async function toggleMcpServer(serverName, scope, disabled) {
  const drawerCurrentPid = getDrawerCurrentPid();
  if (!drawerCurrentPid) return;
  try {
    await api('POST', `/api/agents/${drawerCurrentPid}/mcp-toggle`, { serverName, scope, disabled });
    toast(`${serverName} ${disabled ? 'disabled' : 'enabled'}`);
    await fetchAndRenderContext(drawerCurrentPid);
  } catch (err) {
    toast(err.message, 'error');
    await fetchAndRenderContext(drawerCurrentPid);
  }
}
