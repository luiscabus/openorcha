import { api, toast, escHtml } from '../utils.js';

let currentView = 'activity';

export function setClaudeHistoryView(view) {
  currentView = view;
  document.getElementById('claude-history-view-activity').classList.toggle('active', view === 'activity');
  document.getElementById('claude-history-view-sessions').classList.toggle('active', view === 'sessions');
  loadClaudeHistory();
}

export async function loadClaudeHistory() {
  const container = document.getElementById('claude-history-list');
  const project = document.getElementById('claude-history-project-filter').value;
  const search = document.getElementById('claude-history-search').value;
  container.innerHTML = '<div class="drawer-loading">Loading…</div>';

  try {
    if (currentView === 'activity') {
      const params = new URLSearchParams();
      if (project) params.set('project', project);
      if (search) params.set('search', search);
      params.set('limit', '100');
      const data = await api('GET', `/api/claude/history/activity?${params}`);
      renderActivityFeed(container, data.entries || []);
    } else {
      const params = new URLSearchParams();
      if (project) params.set('project', project);
      if (search) params.set('search', search);
      params.set('limit', '50');
      const data = await api('GET', `/api/claude/history/sessions?${params}`);
      renderSessionList(container, data.sessions || []);
    }
  } catch (err) {
    container.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString();
}

function renderActivityFeed(container, entries) {
  if (!entries.length) {
    container.innerHTML = '<div class="drawer-empty">No activity found.</div>';
    return;
  }
  container.innerHTML = entries.map(e => `
    <div class="claude-history-entry">
      <span class="claude-history-time">${escHtml(formatTime(e.timestamp))}</span>
      <span class="claude-history-project badge badge-sm">${escHtml(shortProject(e.project))}</span>
      <span class="claude-history-display">${escHtml(e.display || '')}</span>
      <a href="#" class="claude-history-session-link" onclick="event.preventDefault();loadClaudeSessionDetail('${escHtml(e.sessionId)}')">session</a>
    </div>
  `).join('');
}

function renderSessionList(container, sessions) {
  if (!sessions.length) {
    container.innerHTML = '<div class="drawer-empty">No sessions found.</div>';
    return;
  }
  container.innerHTML = sessions.map(s => `
    <div class="claude-history-session-card" onclick="loadClaudeSessionDetail('${escHtml(s.sessionId)}')">
      <div class="claude-history-session-header">
        <span class="claude-history-time">${escHtml(formatTime(s.startedAt || s.firstTimestamp))}</span>
        <span class="badge badge-sm">${escHtml(shortProject(s.project))}</span>
        <span class="claude-history-msg-count">${s.messageCount} messages</span>
      </div>
    </div>
  `).join('');
}

export async function loadClaudeSessionDetail(sessionId) {
  const container = document.getElementById('claude-history-list');
  container.innerHTML = '<div class="drawer-loading">Loading session…</div>';
  try {
    const data = await api('GET', `/api/claude/history/${encodeURIComponent(sessionId)}`);
    let html = `<button class="btn btn-sm" onclick="loadClaudeHistory()" style="margin-bottom:1rem">← Back</button>`;
    html += `<div class="claude-history-conversation">`;
    for (const e of data.entries || []) {
      html += `<div class="claude-history-msg claude-history-msg-user">
        <span class="claude-history-time">${escHtml(formatTime(e.timestamp))}</span>
        <span class="claude-history-display">${escHtml(e.display || '')}</span>
      </div>`;
    }
    html += '</div>';
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

function shortProject(p) {
  if (!p) return '';
  const parts = p.split('/');
  return parts.slice(-2).join('/');
}

export async function populateClaudeHistoryProjects() {
  try {
    const data = await api('GET', '/api/claude/history/sessions?limit=1000');
    const projects = [...new Set((data.sessions || []).map(s => s.project).filter(Boolean))];
    const sel = document.getElementById('claude-history-project-filter');
    sel.innerHTML = '<option value="">All projects</option>' +
      projects.map(p => `<option value="${escHtml(p)}">${escHtml(shortProject(p))}</option>`).join('');
  } catch {}
}
