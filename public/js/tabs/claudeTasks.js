import { api, toast, escHtml } from '../utils.js';

let tasksAutoRefreshTimer = null;

export async function loadClaudeTasks() {
  const container = document.getElementById('claude-tasks-list');
  const status = document.getElementById('claude-tasks-status-filter').value;
  const project = document.getElementById('claude-tasks-project-filter').value;
  container.innerHTML = '<div class="drawer-loading">Loading…</div>';

  try {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (project) params.set('project', project);
    const data = await api('GET', `/api/claude/tasks?${params}`);
    const tasks = data.tasks || [];

    if (!tasks.length) {
      container.innerHTML = '<div class="drawer-empty">No tasks found.</div>';
      return;
    }

    const groups = { in_progress: [], pending: [], completed: [] };
    for (const t of tasks) {
      (groups[t.status] || groups.pending).push(t);
    }

    let html = '';
    for (const [status, items] of Object.entries(groups)) {
      if (!items.length) continue;
      const collapsed = status === 'completed' ? ' claude-tasks-collapsed' : '';
      html += `<div class="claude-tasks-group${collapsed}">
        <h3 class="claude-tasks-group-header" onclick="this.parentElement.classList.toggle('claude-tasks-collapsed')">
          ${escHtml(status.replace('_', ' '))} <span class="claude-tasks-count">${items.length}</span>
        </h3>
        <div class="claude-tasks-group-body">
          ${items.map(t => renderTask(t)).join('')}
        </div>
      </div>`;
    }
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

function renderTask(t) {
  const statusClass = `claude-task-status-${t.status}`;
  const projectShort = t.project ? t.project.split('/').slice(-2).join('/') : '';
  return `<details class="claude-task-card">
    <summary>
      <span class="badge badge-sm ${statusClass}">${escHtml(t.status)}</span>
      <span class="claude-task-subject">${escHtml(t.subject || 'Untitled')}</span>
      ${projectShort ? `<span class="badge badge-sm">${escHtml(projectShort)}</span>` : ''}
      ${t.owner ? `<span class="claude-task-owner">${escHtml(t.owner)}</span>` : ''}
    </summary>
    <div class="claude-task-detail">
      ${t.description ? `<p>${escHtml(t.description)}</p>` : ''}
      ${t.activeForm ? `<p class="claude-task-active"><em>${escHtml(t.activeForm)}</em></p>` : ''}
      ${t.blocks && t.blocks.length ? `<p>Blocks: ${t.blocks.join(', ')}</p>` : ''}
      ${t.blockedBy && t.blockedBy.length ? `<p>Blocked by: ${t.blockedBy.join(', ')}</p>` : ''}
      <button class="btn btn-sm" onclick="promoteClaudeTask('${escHtml(t.sessionId)}','${escHtml(t.id)}')">Add to Todo</button>
    </div>
  </details>`;
}

export async function promoteClaudeTask(sessionId, taskId) {
  try {
    const todo = await api('POST', `/api/claude/tasks/${encodeURIComponent(sessionId)}/${encodeURIComponent(taskId)}/promote`);
    toast(`Added "${todo.text}" to todo list`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function toggleClaudeTasksAutoRefresh() {
  const checked = document.getElementById('claude-tasks-auto-refresh').checked;
  clearInterval(tasksAutoRefreshTimer);
  tasksAutoRefreshTimer = null;
  if (checked) {
    tasksAutoRefreshTimer = setInterval(loadClaudeTasks, 15000);
  }
}

export function clearClaudeTasksAutoRefresh() {
  clearInterval(tasksAutoRefreshTimer);
  tasksAutoRefreshTimer = null;
}
