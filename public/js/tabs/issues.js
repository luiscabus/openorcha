import { api, escHtml } from '../utils.js';

let currentIssueFilter = 'open';

function formatRelativeDate(value) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';

  const diffMs = Date.now() - then;
  const diffMinutes = Math.max(1, Math.round(diffMs / 60000));
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;

  return new Date(value).toLocaleDateString();
}

function renderIssueRow(issue) {
  const labels = issue.labels.length
    ? issue.labels.map(label => `
        <span class="issue-label" style="--issue-label:#${escHtml(label.color || '6b7280')}" title="${escHtml(label.description || label.name)}">
          ${escHtml(label.name)}
        </span>
      `).join('')
    : '<span class="issue-label issue-label-muted">No labels</span>';

  return `
    <tr>
      <td>
        <div class="issue-title-wrap">
          <a class="issue-link" href="${issue.htmlUrl}" target="_blank" rel="noreferrer">#${issue.number} ${escHtml(issue.title)}</a>
          <div class="issue-meta-line">
            <span>@${escHtml(issue.author || 'unknown')}</span>
            <span>${issue.comments} comments</span>
            <span>updated ${formatRelativeDate(issue.updatedAt)}</span>
          </div>
        </div>
      </td>
      <td><span class="issue-state issue-state-${escHtml(issue.state)}">${escHtml(issue.state)}</span></td>
      <td><div class="issue-label-list">${labels}</div></td>
    </tr>
  `;
}

function renderIssues(data) {
  const summary = document.getElementById('issues-summary');
  const body = document.getElementById('issues-body');
  const repoLink = document.getElementById('issues-repo-link');
  const access = data.repo.visibility === 'public'
    ? 'Public repo. Issues can be read anonymously.'
    : 'Visibility is not public. Anonymous issue access may fail.';

  repoLink.href = data.repo.issuesUrl;
  repoLink.textContent = data.repo.slug;
  summary.innerHTML = `
    <div class="issues-stat-card">
      <span class="issues-stat-label">Repository</span>
      <strong>${escHtml(data.repo.slug)}</strong>
      <small>${escHtml(access)}</small>
    </div>
    <div class="issues-stat-card">
      <span class="issues-stat-label">Showing</span>
      <strong>${data.issues.length}</strong>
      <small>Latest ${escHtml(data.filter)} issues</small>
    </div>
    <div class="issues-stat-card">
      <span class="issues-stat-label">Open Count</span>
      <strong>${data.repo.openIssuesCount ?? 'n/a'}</strong>
      <small>GitHub repo metadata</small>
    </div>
  `;

  body.innerHTML = data.issues.length
    ? data.issues.map(renderIssueRow).join('')
    : `<tr><td colspan="3"><div class="empty-state"><p>No issues returned</p><small>GitHub responded, but this filter currently has no issues.</small></div></td></tr>`;
}

function renderIssuesError(message) {
  const summary = document.getElementById('issues-summary');
  const body = document.getElementById('issues-body');
  const repoLink = document.getElementById('issues-repo-link');

  summary.innerHTML = `
    <div class="issues-stat-card">
      <span class="issues-stat-label">GitHub Issues</span>
      <strong>Unavailable</strong>
      <small>${escHtml(message)}</small>
    </div>
  `;
  repoLink.removeAttribute('href');
  repoLink.textContent = 'Issues unavailable';
  body.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p>Could not load issues</p><small>${escHtml(message)}</small></div></td></tr>`;
}

function syncIssueFilterUi() {
  document.querySelectorAll('[data-issues-filter]').forEach(button => {
    button.classList.toggle('active', button.dataset.issuesFilter === currentIssueFilter);
  });
}

export async function loadIssues() {
  syncIssueFilterUi();
  document.getElementById('issues-summary').innerHTML = `
    <div class="issues-stat-card">
      <span class="issues-stat-label">GitHub Issues</span>
      <strong>Loading…</strong>
      <small>Fetching repository metadata and latest issues.</small>
    </div>
  `;
  document.getElementById('issues-body').innerHTML = `<tr><td colspan="3"><div class="empty-state"><p>Loading issues…</p><small>Contacting the GitHub API for this checkout.</small></div></td></tr>`;

  try {
    const data = await api('GET', `/api/issues?state=${encodeURIComponent(currentIssueFilter)}`);
    renderIssues(data);
  } catch (err) {
    renderIssuesError(err.message);
  }
}

export function setIssuesFilter(state) {
  currentIssueFilter = state;
  loadIssues();
}
