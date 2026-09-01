import { api, toast, escHtml } from '../utils.js';

let allProjects = [];
let selectedProject = null;

export async function loadClaudeMemory() {
  try {
    const data = await api('GET', '/api/claude/memory');
    allProjects = data.projects || [];
    renderProjectList();
    if (selectedProject) {
      const still = allProjects.find(p => p.encoded === selectedProject);
      if (still) { loadClaudeMemoryProject(selectedProject); return; }
    }
    document.getElementById('claude-memory-detail').innerHTML = '<div class="drawer-empty">Select a project to view its memory.</div>';
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function filterClaudeMemoryProjects() {
  renderProjectList();
}

function renderProjectList() {
  const filter = (document.getElementById('claude-memory-search').value || '').toLowerCase();
  const filtered = allProjects.filter(p => p.decoded.toLowerCase().includes(filter));
  const container = document.getElementById('claude-memory-projects');
  container.innerHTML = filtered.map(p => `
    <div class="claude-memory-project-item${p.encoded === selectedProject ? ' active' : ''}" onclick="loadClaudeMemoryProject('${escHtml(p.encoded)}')">
      <span class="claude-memory-project-path">${escHtml(p.decoded)}</span>
      <span class="claude-memory-project-meta">
        ${p.hasClaudeMd ? '<span class="badge badge-sm">CLAUDE.md</span>' : ''}
        ${p.memoryCount ? `<span class="badge badge-sm">${p.memoryCount} memories</span>` : ''}
      </span>
    </div>
  `).join('') || '<div class="drawer-empty">No projects with memory data.</div>';
}

export async function loadClaudeMemoryProject(encoded) {
  selectedProject = encoded;
  renderProjectList();
  const detail = document.getElementById('claude-memory-detail');
  detail.innerHTML = '<div class="drawer-loading">Loading…</div>';
  try {
    const data = await api('GET', `/api/claude/memory/${encodeURIComponent(encoded)}`);
    let html = '';

    // CLAUDE.md
    html += `<div class="claude-memory-block">
      <h3>CLAUDE.md</h3>
      <textarea id="claude-md-editor" class="config-editor" rows="10">${escHtml(data.claudeMd || '')}</textarea>
      <button class="btn btn-primary btn-sm" onclick="saveClaudeMemoryFile('claude-md')">Save</button>
    </div>`;

    // MEMORY.md
    html += `<div class="claude-memory-block">
      <h3>MEMORY.md</h3>
      <textarea id="memory-md-editor" class="config-editor" rows="6">${escHtml(data.memoryMd || '')}</textarea>
      <button class="btn btn-primary btn-sm" onclick="saveClaudeMemoryFile('memory-md')">Save</button>
    </div>`;

    // Memory files grouped by type
    const byType = {};
    for (const m of data.memories || []) {
      (byType[m.type] = byType[m.type] || []).push(m);
    }

    html += '<div class="claude-memory-block"><h3>Memory Files</h3>';
    html += `<button class="btn btn-sm" onclick="openNewMemoryForm()">+ New Memory</button>`;
    html += '<div id="new-memory-form" style="display:none" class="claude-memory-new-form">'
      + '<input id="new-mem-name" placeholder="Name" class="search-input">'
      + '<input id="new-mem-desc" placeholder="Description" class="search-input">'
      + '<select id="new-mem-type" class="search-input"><option value="user">user</option><option value="feedback">feedback</option><option value="project">project</option><option value="reference">reference</option></select>'
      + '<textarea id="new-mem-body" class="config-editor" rows="4" placeholder="Content"></textarea>'
      + '<button class="btn btn-primary btn-sm" onclick="createClaudeMemory()">Create</button>'
      + '</div>';

    for (const [type, mems] of Object.entries(byType)) {
      html += `<div class="claude-memory-type-group"><h4 class="claude-memory-type-label">${escHtml(type)}</h4>`;
      for (const m of mems) {
        html += `<details class="claude-memory-entry">
          <summary>
            <span class="claude-memory-entry-name">${escHtml(m.name)}</span>
            <span class="claude-memory-entry-desc">${escHtml(m.description)}</span>
            <span class="claude-memory-entry-file">${escHtml(m.file)}</span>
          </summary>
          <textarea id="mem-${escHtml(m.file)}" class="config-editor" rows="6">${escHtml(m.body)}</textarea>
          <div class="claude-memory-entry-actions">
            <button class="btn btn-primary btn-sm" onclick="saveClaudeMemoryEntry('${escHtml(m.file)}')">Save</button>
            <button class="btn btn-danger btn-sm" onclick="deleteClaudeMemory('${escHtml(m.file)}')">Delete</button>
          </div>
        </details>`;
      }
      html += '</div>';
    }
    html += '</div>';

    detail.innerHTML = html;
  } catch (err) {
    detail.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

export function openNewMemoryForm() {
  const form = document.getElementById('new-memory-form');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

export async function createClaudeMemory() {
  if (!selectedProject) return;
  const body = {
    name: document.getElementById('new-mem-name').value,
    description: document.getElementById('new-mem-desc').value,
    type: document.getElementById('new-mem-type').value,
    body: document.getElementById('new-mem-body').value,
  };
  if (!body.name) { toast('Name is required', 'error'); return; }
  try {
    await api('POST', `/api/claude/memory/${encodeURIComponent(selectedProject)}/file`, body);
    toast('Memory created');
    loadClaudeMemoryProject(selectedProject);
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function saveClaudeMemoryFile(which) {
  if (!selectedProject) return;
  try {
    if (which === 'claude-md') {
      await api('PUT', `/api/claude/memory/${encodeURIComponent(selectedProject)}/claude-md`, {
        content: document.getElementById('claude-md-editor').value,
      });
    } else if (which === 'memory-md') {
      await api('PUT', `/api/claude/memory/${encodeURIComponent(selectedProject)}/memory-md`, {
        content: document.getElementById('memory-md-editor').value,
      });
    }
    toast('Saved');
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function saveClaudeMemoryEntry(filename) {
  if (!selectedProject) return;
  const textarea = document.getElementById(`mem-${filename}`);
  if (!textarea) return;
  try {
    await api('PUT', `/api/claude/memory/${encodeURIComponent(selectedProject)}/file/${encodeURIComponent(filename)}`, {
      content: textarea.value,
    });
    toast('Saved');
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function deleteClaudeMemory(filename) {
  if (!selectedProject) return;
  if (!confirm(`Delete ${filename}?`)) return;
  try {
    await api('DELETE', `/api/claude/memory/${encodeURIComponent(selectedProject)}/file/${encodeURIComponent(filename)}`);
    toast('Deleted');
    loadClaudeMemoryProject(selectedProject);
  } catch (err) {
    toast(err.message, 'error');
  }
}
