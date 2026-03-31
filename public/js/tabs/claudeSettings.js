import { api, toast, escHtml } from '../utils.js';

let settingsProjects = [];

export async function loadClaudeSettings() {
  try {
    const data = await api('GET', '/api/claude/settings');
    document.getElementById('claude-settings-global').value = JSON.stringify(data.global, null, 2);
    settingsProjects = data.projects || [];
    const sel = document.getElementById('claude-settings-project');
    sel.innerHTML = '<option value="">Select project…</option>' +
      settingsProjects.map(p => `<option value="${escHtml(p.encoded)}">${escHtml(p.decoded)}</option>`).join('');
    document.getElementById('claude-settings-project-main').value = '';
    document.getElementById('claude-settings-project-local').value = '';
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function loadClaudeProjectSettings() {
  const sel = document.getElementById('claude-settings-project');
  const project = sel.value;
  if (!project) {
    document.getElementById('claude-settings-project-main').value = '';
    document.getElementById('claude-settings-project-local').value = '';
    return;
  }
  try {
    const data = await api('GET', `/api/claude/settings/${encodeURIComponent(project)}`);
    document.getElementById('claude-settings-project-main').value = data.main ? JSON.stringify(data.main, null, 2) : '';
    document.getElementById('claude-settings-project-local').value = data.local ? JSON.stringify(data.local, null, 2) : '';
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function saveClaudeSettings(which) {
  let url, content;
  if (which === 'global') {
    url = '/api/claude/settings/global';
    content = document.getElementById('claude-settings-global').value;
  } else if (which === 'project') {
    const project = document.getElementById('claude-settings-project').value;
    if (!project) { toast('Select a project first', 'error'); return; }
    url = `/api/claude/settings/${encodeURIComponent(project)}`;
    content = document.getElementById('claude-settings-project-main').value;
  } else if (which === 'project-local') {
    const project = document.getElementById('claude-settings-project').value;
    if (!project) { toast('Select a project first', 'error'); return; }
    url = `/api/claude/settings/${encodeURIComponent(project)}/local`;
    content = document.getElementById('claude-settings-project-local').value;
  }
  try {
    JSON.parse(content);
  } catch {
    toast('Invalid JSON — fix syntax before saving', 'error');
    return;
  }
  try {
    await api('PUT', url, { content });
    toast('Settings saved');
  } catch (err) {
    toast(err.message, 'error');
  }
}
