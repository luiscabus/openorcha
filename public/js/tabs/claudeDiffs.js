import { api, toast, escHtml } from '../utils.js';

export async function loadClaudeDiffs() {
  const container = document.getElementById('claude-diffs-list');
  const project = document.getElementById('claude-diffs-project-filter').value;
  container.innerHTML = '<div class="drawer-loading">Loading…</div>';

  try {
    const params = new URLSearchParams();
    if (project) params.set('project', project);
    const data = await api('GET', `/api/claude/diffs?${params}`);
    const changes = data.changes || [];

    if (!changes.length) {
      container.innerHTML = '<div class="drawer-empty">No file changes tracked.</div>';
      return;
    }

    // Populate project filter
    const projects = [...new Set(changes.map(c => c.project).filter(Boolean))];
    const sel = document.getElementById('claude-diffs-project-filter');
    const curVal = sel.value;
    sel.innerHTML = '<option value="">All projects</option>' +
      projects.map(p => `<option value="${escHtml(p)}"${p === curVal ? ' selected' : ''}>${escHtml(shortProject(p))}</option>`).join('');

    container.innerHTML = changes.map(c => {
      const projectShort = shortProject(c.project);
      const time = c.mtime ? new Date(c.mtime).toLocaleString() : '';
      return `<details class="claude-diff-card" data-session="${escHtml(c.sessionId)}" data-hash="${escHtml(c.hash)}" data-versions="${c.latestVersion}">
        <summary onclick="loadDiffOnExpand(this)">
          <span class="claude-diff-hash" title="${escHtml(c.hash)}">${escHtml(c.hash.slice(0, 8))}</span>
          ${projectShort ? `<span class="badge badge-sm">${escHtml(projectShort)}</span>` : ''}
          <span class="claude-diff-versions">${c.versions} version${c.versions > 1 ? 's' : ''}</span>
          <span class="claude-diff-preview">${escHtml(c.preview)}</span>
          <span class="claude-diff-time">${escHtml(time)}</span>
        </summary>
        <div class="claude-diff-body">
          <div class="claude-diff-version-controls">
            <label>From: <select class="claude-diff-from" onchange="reloadDiff(this)">
              <option value="0">(empty)</option>
              ${versionOptions(c.latestVersion, c.latestVersion - 1)}
            </select></label>
            <label>To: <select class="claude-diff-to" onchange="reloadDiff(this)">
              ${versionOptions(c.latestVersion, c.latestVersion)}
            </select></label>
          </div>
          <div class="claude-diff-viewer"><div class="drawer-loading">Loading diff…</div></div>
        </div>
      </details>`;
    }).join('');
  } catch (err) {
    container.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

function versionOptions(max, selected) {
  let html = '';
  for (let i = 1; i <= max; i++) {
    html += `<option value="${i}"${i === selected ? ' selected' : ''}>v${i}</option>`;
  }
  return html;
}

export async function loadDiffOnExpand(summaryEl) {
  const details = summaryEl.closest('details');
  if (details.open) return; // closing, not opening
  const sessionId = details.dataset.session;
  const hash = details.dataset.hash;
  const from = details.querySelector('.claude-diff-from')?.value || '0';
  const to = details.querySelector('.claude-diff-to')?.value || '1';
  await fetchAndRenderDiff(details, sessionId, hash, from, to);
}

export async function reloadDiff(selectEl) {
  const details = selectEl.closest('details');
  const sessionId = details.dataset.session;
  const hash = details.dataset.hash;
  const from = details.querySelector('.claude-diff-from').value;
  const to = details.querySelector('.claude-diff-to').value;
  await fetchAndRenderDiff(details, sessionId, hash, from, to);
}

async function fetchAndRenderDiff(details, sessionId, hash, from, to) {
  const viewer = details.querySelector('.claude-diff-viewer');
  viewer.innerHTML = '<div class="drawer-loading">Loading diff…</div>';
  try {
    const data = await api('GET', `/api/claude/diffs/${encodeURIComponent(sessionId)}/${encodeURIComponent(hash)}?from=${from}&to=${to}`);
    viewer.innerHTML = renderSideBySideDiff(data);
  } catch (err) {
    viewer.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

function renderSideBySideDiff(data) {
  if (!data.hunks || !data.hunks.length) {
    if (data.oldContent === data.newContent) {
      return '<div class="drawer-empty">No differences.</div>';
    }
  }

  let html = '<table class="claude-diff-table"><thead><tr><th class="claude-diff-ln">Line</th><th>Old</th><th class="claude-diff-ln">Line</th><th>New</th></tr></thead><tbody>';

  for (const hunk of data.hunks || []) {
    html += `<tr class="claude-diff-hunk-header"><td colspan="4">@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@</td></tr>`;
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith('-')) {
        html += `<tr class="claude-diff-del"><td class="claude-diff-ln">${oldLine++}</td><td>${escHtml(line.slice(1))}</td><td class="claude-diff-ln"></td><td></td></tr>`;
      } else if (line.startsWith('+')) {
        html += `<tr class="claude-diff-add"><td class="claude-diff-ln"></td><td></td><td class="claude-diff-ln">${newLine++}</td><td>${escHtml(line.slice(1))}</td></tr>`;
      } else {
        const content = line.startsWith(' ') ? line.slice(1) : line;
        html += `<tr><td class="claude-diff-ln">${oldLine++}</td><td>${escHtml(content)}</td><td class="claude-diff-ln">${newLine++}</td><td>${escHtml(content)}</td></tr>`;
      }
    }
  }

  html += '</tbody></table>';
  return html;
}

function shortProject(p) {
  if (!p) return '';
  return p.split('/').slice(-2).join('/');
}
