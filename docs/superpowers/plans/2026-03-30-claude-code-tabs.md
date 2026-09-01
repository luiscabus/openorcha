# Claude Code Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five new tabs (Memory, History, Tasks, Settings, File Diffs) under a "Claude Code" sidebar section, plus agent drawer context enhancements.

**Architecture:** Express backend modules in `lib/claude*.js` read from `~/.claude/` directories, exposed via a single route file at `/api/claude`. Vanilla JS frontend tabs follow the existing pattern: module in `public/js/tabs/`, exposed to `window` via `main.js`, rendered into `tab-content` divs in `index.html`. One new npm dependency: `diff`.

**Tech Stack:** Node.js, Express, vanilla JS, `diff` npm package

---

### Task 1: Install `diff` dependency and scaffold route file

**Files:**
- Modify: `package.json`
- Create: `routes/claudeCode.js`
- Modify: `server.js`

- [ ] **Step 1: Install diff package**

Run: `cd /home/ubuntu/personal/agent-orch && npm install diff`

- [ ] **Step 2: Create the route file skeleton**

Create `routes/claudeCode.js`:

```js
const express = require('express');
const router = express.Router();

// Sub-routers will be added in subsequent tasks

module.exports = router;
```

- [ ] **Step 3: Mount the route in server.js**

In `server.js`, add before `app.listen`:

```js
app.use('/api/claude',      require('./routes/claudeCode'));
```

- [ ] **Step 4: Verify server starts**

Run: `cd /home/ubuntu/personal/agent-orch && node -e "require('./routes/claudeCode');" && echo "OK"`
Expected: "OK" (no errors)

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/personal/agent-orch
git add package.json package-lock.json routes/claudeCode.js server.js
git commit -m "scaffold Claude Code route and install diff dependency"
```

---

### Task 2: Sidebar navigation and tab containers

**Files:**
- Modify: `public/index.html`
- Modify: `public/styles.css`

- [ ] **Step 1: Add sidebar section header and nav items to index.html**

After the GitHub Issues `</li>` (line 75) and before the closing `</ul>` (line 76), add:

```html
        <li class="nav-section-divider">Claude Code</li>
        <li><a href="#" class="nav-item" data-tab="claude-memory">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 0 0-7 7c0 3 1.5 5 3 6.5V20a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-4.5c1.5-1.5 3-3.5 3-6.5a7 7 0 0 0-7-7z"/><line x1="10" y1="22" x2="14" y2="22"/></svg>
          Memory
        </a></li>
        <li><a href="#" class="nav-item" data-tab="claude-history">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          History
        </a></li>
        <li><a href="#" class="nav-item" data-tab="claude-tasks">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          Tasks
        </a></li>
        <li><a href="#" class="nav-item" data-tab="claude-settings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          Settings
        </a></li>
        <li><a href="#" class="nav-item" data-tab="claude-diffs">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M3 12h18"/></svg>
          File Diffs
        </a></li>
```

- [ ] **Step 2: Add tab-content containers to index.html**

Inside `<main class="main">`, after the last existing `tab-content` div, add:

```html
    <!-- Claude Code: Memory -->
    <div id="tab-claude-memory" class="tab-content">
      <div class="page-header">
        <h2>Project Memory</h2>
        <div class="page-actions">
          <input type="text" id="claude-memory-search" class="search-input" placeholder="Filter projects…" oninput="filterClaudeMemoryProjects()">
        </div>
      </div>
      <div class="claude-memory-layout">
        <div id="claude-memory-projects" class="claude-memory-projects"></div>
        <div id="claude-memory-detail" class="claude-memory-detail">
          <div class="drawer-empty">Select a project to view its memory.</div>
        </div>
      </div>
    </div>

    <!-- Claude Code: History -->
    <div id="tab-claude-history" class="tab-content">
      <div class="page-header">
        <h2>Session History</h2>
        <div class="page-actions">
          <select id="claude-history-project-filter" onchange="loadClaudeHistory()"><option value="">All projects</option></select>
          <input type="text" id="claude-history-search" class="search-input" placeholder="Search…" oninput="loadClaudeHistory()">
          <div class="toggle-group">
            <button class="btn btn-sm btn-toggle active" id="claude-history-view-activity" onclick="setClaudeHistoryView('activity')">Activity</button>
            <button class="btn btn-sm btn-toggle" id="claude-history-view-sessions" onclick="setClaudeHistoryView('sessions')">Sessions</button>
          </div>
        </div>
      </div>
      <div id="claude-history-list" class="claude-history-list"></div>
    </div>

    <!-- Claude Code: Tasks -->
    <div id="tab-claude-tasks" class="tab-content">
      <div class="page-header">
        <h2>Claude Tasks</h2>
        <div class="page-actions">
          <select id="claude-tasks-status-filter" onchange="loadClaudeTasks()">
            <option value="">All statuses</option>
            <option value="in_progress">In Progress</option>
            <option value="pending">Pending</option>
            <option value="completed">Completed</option>
          </select>
          <select id="claude-tasks-project-filter" onchange="loadClaudeTasks()"><option value="">All projects</option></select>
          <label class="auto-refresh-toggle"><input type="checkbox" id="claude-tasks-auto-refresh" onchange="toggleClaudeTasksAutoRefresh()"> Auto-refresh</label>
        </div>
      </div>
      <div id="claude-tasks-list" class="claude-tasks-list"></div>
    </div>

    <!-- Claude Code: Settings -->
    <div id="tab-claude-settings" class="tab-content">
      <div class="page-header">
        <h2>Claude Settings</h2>
      </div>
      <div class="claude-settings-layout">
        <div class="claude-settings-section">
          <h3>Global Settings <span class="settings-path">~/.claude/settings.json</span></h3>
          <textarea id="claude-settings-global" class="config-editor" rows="15"></textarea>
          <button class="btn btn-primary" onclick="saveClaudeSettings('global')">Save Global Settings</button>
        </div>
        <div class="claude-settings-section">
          <h3>Project Settings</h3>
          <select id="claude-settings-project" onchange="loadClaudeProjectSettings()"><option value="">Select project…</option></select>
          <div class="claude-settings-project-editors">
            <div>
              <h4>settings.json</h4>
              <textarea id="claude-settings-project-main" class="config-editor" rows="12"></textarea>
              <button class="btn btn-primary" onclick="saveClaudeSettings('project')">Save</button>
            </div>
            <div>
              <h4>settings.local.json</h4>
              <textarea id="claude-settings-project-local" class="config-editor" rows="12"></textarea>
              <button class="btn btn-primary" onclick="saveClaudeSettings('project-local')">Save</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Claude Code: File Diffs -->
    <div id="tab-claude-diffs" class="tab-content">
      <div class="page-header">
        <h2>File Diffs</h2>
        <div class="page-actions">
          <select id="claude-diffs-project-filter" onchange="loadClaudeDiffs()"><option value="">All projects</option></select>
        </div>
      </div>
      <div id="claude-diffs-list" class="claude-diffs-list"></div>
    </div>
```

- [ ] **Step 3: Add CSS for sidebar section divider**

Append to `public/styles.css`:

```css
/* ─── Claude Code sidebar section divider ─────────────────────────────────── */
.nav-section-divider {
  padding: 1.2rem 1rem 0.4rem;
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  pointer-events: none;
  border-top: 1px solid var(--border);
  margin-top: 0.5rem;
}
```

- [ ] **Step 4: Verify page loads**

Run: `cd /home/ubuntu/personal/agent-orch && node -e "
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const tabs = ['claude-memory','claude-history','claude-tasks','claude-settings','claude-diffs'];
tabs.forEach(t => {
  if (!html.includes('id=\"tab-' + t + '\"')) throw new Error('Missing tab: ' + t);
  if (!html.includes('data-tab=\"' + t + '\"')) throw new Error('Missing nav: ' + t);
});
if (!html.includes('nav-section-divider')) throw new Error('Missing divider');
console.log('All 5 tabs and nav items present');
"`

Expected: "All 5 tabs and nav items present"

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/personal/agent-orch
git add public/index.html public/styles.css
git commit -m "add Claude Code sidebar section and tab containers"
```

---

### Task 3: Settings backend and frontend

Settings is the simplest tab — just reading/writing JSON files. Good to build first as a warm-up.

**Files:**
- Create: `lib/claudeSettings.js`
- Modify: `routes/claudeCode.js`
- Create: `public/js/tabs/claudeSettings.js`
- Modify: `public/js/main.js`
- Create: `test/claudeSettings.test.js`

- [ ] **Step 1: Write the test for claudeSettings.js**

Create `test/claudeSettings.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getGlobalSettings, getProjectList, getProjectSettings, writeSettings } = require('../lib/claudeSettings');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-settings-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('getGlobalSettings reads settings.json', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'opus' }));
    const result = getGlobalSettings(dir);
    assert.deepEqual(result, { model: 'opus' });
  } finally {
    cleanup(dir);
  }
});

test('getGlobalSettings returns empty object when file missing', () => {
  const dir = makeTempDir();
  try {
    const result = getGlobalSettings(dir);
    assert.deepEqual(result, {});
  } finally {
    cleanup(dir);
  }
});

test('getProjectList finds projects with settings', () => {
  const dir = makeTempDir();
  try {
    const projDir = path.join(dir, 'projects', '-home-ubuntu-myproj');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'settings.json'), '{}');
    const list = getProjectList(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].encoded, '-home-ubuntu-myproj');
    assert.equal(list[0].decoded, '/home/ubuntu/myproj');
  } finally {
    cleanup(dir);
  }
});

test('getProjectSettings reads both settings files', () => {
  const dir = makeTempDir();
  try {
    const projDir = path.join(dir, 'projects', '-home-ubuntu-myproj');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'settings.json'), '{"a":1}');
    fs.writeFileSync(path.join(projDir, 'settings.local.json'), '{"b":2}');
    const result = getProjectSettings(dir, '-home-ubuntu-myproj');
    assert.deepEqual(result.main, { a: 1 });
    assert.deepEqual(result.local, { b: 2 });
  } finally {
    cleanup(dir);
  }
});

test('writeSettings validates JSON and writes', () => {
  const dir = makeTempDir();
  const fp = path.join(dir, 'test.json');
  try {
    writeSettings(fp, '{"valid":true}');
    assert.deepEqual(JSON.parse(fs.readFileSync(fp, 'utf8')), { valid: true });
  } finally {
    cleanup(dir);
  }
});

test('writeSettings rejects invalid JSON', () => {
  const dir = makeTempDir();
  const fp = path.join(dir, 'test.json');
  try {
    assert.throws(() => writeSettings(fp, 'not json'), /Invalid JSON/);
    assert.equal(fs.existsSync(fp), false);
  } finally {
    cleanup(dir);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ubuntu/personal/agent-orch && node --test test/claudeSettings.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write lib/claudeSettings.js**

Create `lib/claudeSettings.js`:

```js
const fs = require('fs');
const path = require('path');

function readJsonSafe(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function decodeFolderName(encoded) {
  return encoded.replace(/^-/, '/').replace(/-/g, '/');
}

function getGlobalSettings(claudeDir) {
  return readJsonSafe(path.join(claudeDir, 'settings.json')) || {};
}

function getProjectList(claudeDir) {
  const projectsDir = path.join(claudeDir, 'projects');
  const results = [];
  try {
    for (const name of fs.readdirSync(projectsDir)) {
      if (name.startsWith('.')) continue;
      const dir = path.join(projectsDir, name);
      const hasSetting = fs.existsSync(path.join(dir, 'settings.json'))
        || fs.existsSync(path.join(dir, 'settings.local.json'));
      if (hasSetting) {
        results.push({ encoded: name, decoded: decodeFolderName(name) });
      }
    }
  } catch {}
  return results;
}

function getProjectSettings(claudeDir, projectEncoded) {
  const dir = path.join(claudeDir, 'projects', projectEncoded);
  return {
    main: readJsonSafe(path.join(dir, 'settings.json')),
    local: readJsonSafe(path.join(dir, 'settings.local.json')),
  };
}

function writeSettings(filePath, content) {
  try {
    JSON.parse(content);
  } catch {
    throw new Error('Invalid JSON');
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

module.exports = { readJsonSafe, decodeFolderName, getGlobalSettings, getProjectList, getProjectSettings, writeSettings };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ubuntu/personal/agent-orch && node --test test/claudeSettings.test.js`
Expected: All 6 tests pass

- [ ] **Step 5: Add routes to claudeCode.js**

Replace `routes/claudeCode.js` with:

```js
const express = require('express');
const path = require('path');
const os = require('os');
const router = express.Router();

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// ─── Settings ────────────────────────────────────────────────────────────────
const { getGlobalSettings, getProjectList, getProjectSettings, writeSettings } = require('../lib/claudeSettings');

router.get('/settings', (req, res) => {
  try {
    const global = getGlobalSettings(CLAUDE_DIR);
    const projects = getProjectList(CLAUDE_DIR);
    res.json({ global, projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/settings/:project', (req, res) => {
  try {
    const result = getProjectSettings(CLAUDE_DIR, req.params.project);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/settings/global', (req, res) => {
  try {
    const content = typeof req.body === 'string' ? req.body : JSON.stringify(req.body, null, 2);
    writeSettings(path.join(CLAUDE_DIR, 'settings.json'), content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/settings/:project', (req, res) => {
  try {
    const content = typeof req.body === 'string' ? req.body : JSON.stringify(req.body, null, 2);
    writeSettings(path.join(CLAUDE_DIR, 'projects', req.params.project, 'settings.json'), content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/settings/:project/local', (req, res) => {
  try {
    const content = typeof req.body === 'string' ? req.body : JSON.stringify(req.body, null, 2);
    writeSettings(path.join(CLAUDE_DIR, 'projects', req.params.project, 'settings.local.json'), content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 6: Write frontend tab**

Create `public/js/tabs/claudeSettings.js`:

```js
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
```

- [ ] **Step 7: Wire up in main.js**

Add import at top of `public/js/main.js`:

```js
import { loadClaudeSettings, loadClaudeProjectSettings, saveClaudeSettings } from './tabs/claudeSettings.js';
```

Add window exposures in the appropriate section:

```js
// Claude Code: Settings
window.loadClaudeSettings = loadClaudeSettings;
window.loadClaudeProjectSettings = loadClaudeProjectSettings;
window.saveClaudeSettings = saveClaudeSettings;
```

Add to `loadTab()` function:

```js
  else if (tab === 'claude-settings') loadClaudeSettings();
```

- [ ] **Step 8: Verify end to end**

Run: `cd /home/ubuntu/personal/agent-orch && node --test test/claudeSettings.test.js`
Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
cd /home/ubuntu/personal/agent-orch
git add lib/claudeSettings.js routes/claudeCode.js public/js/tabs/claudeSettings.js public/js/main.js test/claudeSettings.test.js
git commit -m "add Claude Settings tab with raw JSON editor"
```

---

### Task 4: Memory backend

**Files:**
- Create: `lib/claudeMemory.js`
- Create: `test/claudeMemory.test.js`
- Modify: `routes/claudeCode.js`

- [ ] **Step 1: Write tests for claudeMemory.js**

Create `test/claudeMemory.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listProjects, getProjectMemory, writeClaudeMd, writeMemoryFile, createMemoryFile, deleteMemoryFile } = require('../lib/claudeMemory');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-memory-test-'));
}
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test('listProjects returns decoded paths with counts', () => {
  const dir = makeTempDir();
  try {
    const projDir = path.join(dir, 'projects', '-home-ubuntu-myproj');
    fs.mkdirSync(path.join(projDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(projDir, 'memory', 'user_role.md'), '---\nname: Role\ntype: user\n---\nDev');
    fs.writeFileSync(path.join(projDir, 'CLAUDE.md'), '# Rules');
    const list = listProjects(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].decoded, '/home/ubuntu/myproj');
    assert.equal(list[0].memoryCount, 1);
    assert.equal(list[0].hasClaudeMd, true);
  } finally {
    cleanup(dir);
  }
});

test('getProjectMemory returns claudeMd, memoryMd, and parsed memory files', () => {
  const dir = makeTempDir();
  try {
    const projDir = path.join(dir, 'projects', '-home-ubuntu-myproj');
    fs.mkdirSync(path.join(projDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(projDir, 'CLAUDE.md'), '# Rules\nNo mocks');
    fs.writeFileSync(path.join(projDir, 'MEMORY.md'), '- [Role](memory/role.md)');
    fs.writeFileSync(path.join(projDir, 'memory', 'role.md'), '---\nname: User Role\ndescription: Dev role\ntype: user\n---\nSenior dev');
    const result = getProjectMemory(dir, '-home-ubuntu-myproj');
    assert.equal(result.claudeMd, '# Rules\nNo mocks');
    assert.equal(result.memoryMd, '- [Role](memory/role.md)');
    assert.equal(result.memories.length, 1);
    assert.equal(result.memories[0].name, 'User Role');
    assert.equal(result.memories[0].type, 'user');
    assert.equal(result.memories[0].body, 'Senior dev');
  } finally {
    cleanup(dir);
  }
});

test('writeClaudeMd creates and overwrites', () => {
  const dir = makeTempDir();
  try {
    const projDir = path.join(dir, 'projects', '-home-ubuntu-myproj');
    fs.mkdirSync(projDir, { recursive: true });
    writeClaudeMd(dir, '-home-ubuntu-myproj', '# New');
    assert.equal(fs.readFileSync(path.join(projDir, 'CLAUDE.md'), 'utf8'), '# New');
    writeClaudeMd(dir, '-home-ubuntu-myproj', '# Updated');
    assert.equal(fs.readFileSync(path.join(projDir, 'CLAUDE.md'), 'utf8'), '# Updated');
  } finally {
    cleanup(dir);
  }
});

test('createMemoryFile writes with frontmatter', () => {
  const dir = makeTempDir();
  try {
    const projDir = path.join(dir, 'projects', '-home-ubuntu-myproj');
    fs.mkdirSync(path.join(projDir, 'memory'), { recursive: true });
    const filename = createMemoryFile(dir, '-home-ubuntu-myproj', {
      name: 'Test', description: 'A test', type: 'feedback', body: 'Content here',
    });
    const content = fs.readFileSync(path.join(projDir, 'memory', filename), 'utf8');
    assert.ok(content.includes('name: Test'));
    assert.ok(content.includes('type: feedback'));
    assert.ok(content.includes('Content here'));
  } finally {
    cleanup(dir);
  }
});

test('deleteMemoryFile removes the file', () => {
  const dir = makeTempDir();
  try {
    const projDir = path.join(dir, 'projects', '-home-ubuntu-myproj');
    fs.mkdirSync(path.join(projDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(projDir, 'memory', 'test.md'), 'data');
    deleteMemoryFile(dir, '-home-ubuntu-myproj', 'test.md');
    assert.equal(fs.existsSync(path.join(projDir, 'memory', 'test.md')), false);
  } finally {
    cleanup(dir);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/ubuntu/personal/agent-orch && node --test test/claudeMemory.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write lib/claudeMemory.js**

Create `lib/claudeMemory.js`:

```js
const fs = require('fs');
const path = require('path');
const { readJsonSafe, decodeFolderName } = require('./claudeSettings');

function readTextSafe(fp) {
  try { return fs.readFileSync(fp, 'utf8'); } catch { return null; }
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)/);
  if (!match) return { meta: {}, body: content.trim() };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: match[2].trim() };
}

function listProjects(claudeDir) {
  const projectsDir = path.join(claudeDir, 'projects');
  const results = [];
  try {
    for (const name of fs.readdirSync(projectsDir)) {
      if (name.startsWith('.')) continue;
      const dir = path.join(projectsDir, name);
      let stat;
      try { stat = fs.statSync(dir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const memDir = path.join(dir, 'memory');
      let memoryCount = 0;
      try {
        memoryCount = fs.readdirSync(memDir).filter(f => f.endsWith('.md')).length;
      } catch {}
      const hasClaudeMd = fs.existsSync(path.join(dir, 'CLAUDE.md'));
      const hasMemoryMd = fs.existsSync(path.join(dir, 'MEMORY.md'));
      if (memoryCount === 0 && !hasClaudeMd && !hasMemoryMd) continue;
      results.push({
        encoded: name,
        decoded: decodeFolderName(name),
        memoryCount,
        hasClaudeMd,
        hasMemoryMd,
      });
    }
  } catch {}
  return results;
}

function getProjectMemory(claudeDir, projectEncoded) {
  const dir = path.join(claudeDir, 'projects', projectEncoded);
  const claudeMd = readTextSafe(path.join(dir, 'CLAUDE.md'));
  const memoryMd = readTextSafe(path.join(dir, 'MEMORY.md'));
  const memories = [];
  const memDir = path.join(dir, 'memory');
  try {
    for (const f of fs.readdirSync(memDir)) {
      if (!f.endsWith('.md')) continue;
      const content = readTextSafe(path.join(memDir, f));
      if (!content) continue;
      const { meta, body } = parseFrontmatter(content);
      memories.push({
        file: f,
        name: meta.name || f.replace('.md', ''),
        description: meta.description || '',
        type: meta.type || 'unknown',
        body,
      });
    }
  } catch {}
  return { claudeMd, memoryMd, memories };
}

function writeClaudeMd(claudeDir, projectEncoded, content) {
  const fp = path.join(claudeDir, 'projects', projectEncoded, 'CLAUDE.md');
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, 'utf8');
}

function writeMemoryMd(claudeDir, projectEncoded, content) {
  const fp = path.join(claudeDir, 'projects', projectEncoded, 'MEMORY.md');
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, 'utf8');
}

function writeMemoryFile(claudeDir, projectEncoded, filename, content) {
  const fp = path.join(claudeDir, 'projects', projectEncoded, 'memory', filename);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, 'utf8');
}

function createMemoryFile(claudeDir, projectEncoded, { name, description, type, body }) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
  const filename = `${type}_${slug}.md`;
  const content = `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`;
  writeMemoryFile(claudeDir, projectEncoded, filename, content);
  return filename;
}

function deleteMemoryFile(claudeDir, projectEncoded, filename) {
  const fp = path.join(claudeDir, 'projects', projectEncoded, 'memory', filename);
  fs.unlinkSync(fp);
}

module.exports = {
  listProjects,
  getProjectMemory,
  writeClaudeMd,
  writeMemoryMd,
  writeMemoryFile,
  createMemoryFile,
  deleteMemoryFile,
};
```

- [ ] **Step 4: Run tests**

Run: `cd /home/ubuntu/personal/agent-orch && node --test test/claudeMemory.test.js`
Expected: All 5 tests pass

- [ ] **Step 5: Add memory routes to claudeCode.js**

Add to `routes/claudeCode.js` after the settings section:

```js
// ─── Memory ──────────────────────────────────────────────────────────────────
const { listProjects, getProjectMemory, writeClaudeMd, writeMemoryMd, writeMemoryFile, createMemoryFile, deleteMemoryFile } = require('../lib/claudeMemory');

router.get('/memory', (req, res) => {
  try {
    res.json({ projects: listProjects(CLAUDE_DIR) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/memory/:project', (req, res) => {
  try {
    res.json(getProjectMemory(CLAUDE_DIR, req.params.project));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/memory/:project/claude-md', (req, res) => {
  try {
    writeClaudeMd(CLAUDE_DIR, req.params.project, req.body.content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/memory/:project/memory-md', (req, res) => {
  try {
    writeMemoryMd(CLAUDE_DIR, req.params.project, req.body.content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/memory/:project/file', (req, res) => {
  try {
    const filename = createMemoryFile(CLAUDE_DIR, req.params.project, req.body);
    res.json({ ok: true, filename });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/memory/:project/file/:filename', (req, res) => {
  try {
    writeMemoryFile(CLAUDE_DIR, req.params.project, req.params.filename, req.body.content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/memory/:project/file/:filename', (req, res) => {
  try {
    deleteMemoryFile(CLAUDE_DIR, req.params.project, req.params.filename);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

- [ ] **Step 6: Run all tests**

Run: `cd /home/ubuntu/personal/agent-orch && node --test test/claudeMemory.test.js && node --test test/claudeSettings.test.js`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/personal/agent-orch
git add lib/claudeMemory.js routes/claudeCode.js test/claudeMemory.test.js
git commit -m "add Memory backend with project listing and CRUD"
```

---

### Task 5: Memory frontend

**Files:**
- Create: `public/js/tabs/claudeMemory.js`
- Modify: `public/js/main.js`
- Modify: `public/styles.css`

- [ ] **Step 1: Write the frontend tab module**

Create `public/js/tabs/claudeMemory.js`:

```js
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
```

- [ ] **Step 2: Add CSS for memory layout**

Append to `public/styles.css`:

```css
/* ─── Claude Memory tab ───────────────────────────────────────────────────── */
.claude-memory-layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 1rem;
  height: calc(100vh - 140px);
}
.claude-memory-projects {
  overflow-y: auto;
  border-right: 1px solid var(--border);
  padding-right: 1rem;
}
.claude-memory-project-item {
  padding: 0.6rem 0.8rem;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.claude-memory-project-item:hover { background: var(--bg-hover); }
.claude-memory-project-item.active { background: var(--bg-active); }
.claude-memory-project-path { font-size: 0.82rem; word-break: break-all; }
.claude-memory-project-meta { display: flex; gap: 0.4rem; flex-wrap: wrap; }
.claude-memory-detail { overflow-y: auto; padding-bottom: 2rem; }
.claude-memory-block { margin-bottom: 1.5rem; }
.claude-memory-block h3 { margin-bottom: 0.5rem; font-size: 0.95rem; }
.claude-memory-type-group { margin-top: 1rem; }
.claude-memory-type-label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  margin-bottom: 0.4rem;
}
.claude-memory-entry { margin-bottom: 0.5rem; border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem 0.8rem; }
.claude-memory-entry summary { cursor: pointer; display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
.claude-memory-entry-name { font-weight: 500; }
.claude-memory-entry-desc { color: var(--text-muted); font-size: 0.78rem; flex: 1; }
.claude-memory-entry-file { font-size: 0.7rem; color: var(--text-muted); font-family: monospace; }
.claude-memory-entry-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
.claude-memory-new-form { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.5rem; padding: 0.8rem; border: 1px solid var(--border); border-radius: 6px; }
```

- [ ] **Step 3: Wire up in main.js**

Add import:

```js
import {
  loadClaudeMemory,
  filterClaudeMemoryProjects,
  loadClaudeMemoryProject,
  openNewMemoryForm,
  createClaudeMemory,
  saveClaudeMemoryFile,
  saveClaudeMemoryEntry,
  deleteClaudeMemory,
} from './tabs/claudeMemory.js';
```

Add window exposures:

```js
// Claude Code: Memory
window.loadClaudeMemory = loadClaudeMemory;
window.filterClaudeMemoryProjects = filterClaudeMemoryProjects;
window.loadClaudeMemoryProject = loadClaudeMemoryProject;
window.openNewMemoryForm = openNewMemoryForm;
window.createClaudeMemory = createClaudeMemory;
window.saveClaudeMemoryFile = saveClaudeMemoryFile;
window.saveClaudeMemoryEntry = saveClaudeMemoryEntry;
window.deleteClaudeMemory = deleteClaudeMemory;
```

Add to `loadTab()`:

```js
  else if (tab === 'claude-memory') loadClaudeMemory();
```

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/personal/agent-orch
git add public/js/tabs/claudeMemory.js public/js/main.js public/styles.css
git commit -m "add Memory tab with project browser and CRUD editor"
```

---

### Task 6: History backend

**Files:**
- Create: `lib/claudeHistory.js`
- Create: `test/claudeHistory.test.js`
- Modify: `routes/claudeCode.js`

- [ ] **Step 1: Write tests**

Create `test/claudeHistory.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseHistory, getSessions, getSessionDetail } = require('../lib/claudeHistory');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-history-test-'));
}
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test('parseHistory parses JSONL lines with filtering', () => {
  const dir = makeTempDir();
  try {
    const fp = path.join(dir, 'history.jsonl');
    const lines = [
      JSON.stringify({ display: 'fix the bug', pastedContents: {}, timestamp: 1000, project: '/home/ubuntu/proj', sessionId: 'aaa' }),
      JSON.stringify({ display: 'add tests', pastedContents: {}, timestamp: 2000, project: '/home/ubuntu/proj', sessionId: 'aaa' }),
      JSON.stringify({ display: 'deploy it', pastedContents: {}, timestamp: 3000, project: '/home/ubuntu/other', sessionId: 'bbb' }),
    ];
    fs.writeFileSync(fp, lines.join('\n') + '\n');

    const all = parseHistory(fp, {});
    assert.equal(all.length, 3);
    assert.equal(all[0].display, 'deploy it'); // newest first

    const filtered = parseHistory(fp, { project: '/home/ubuntu/proj' });
    assert.equal(filtered.length, 2);

    const searched = parseHistory(fp, { search: 'deploy' });
    assert.equal(searched.length, 1);
  } finally {
    cleanup(dir);
  }
});

test('getSessions groups history by sessionId with cwd from session files', () => {
  const dir = makeTempDir();
  try {
    const fp = path.join(dir, 'history.jsonl');
    const lines = [
      JSON.stringify({ display: 'msg1', pastedContents: {}, timestamp: 1000, project: '/home/ubuntu/proj', sessionId: 'sess-1' }),
      JSON.stringify({ display: 'msg2', pastedContents: {}, timestamp: 2000, project: '/home/ubuntu/proj', sessionId: 'sess-1' }),
      JSON.stringify({ display: 'msg3', pastedContents: {}, timestamp: 5000, project: '/home/ubuntu/other', sessionId: 'sess-2' }),
    ];
    fs.writeFileSync(fp, lines.join('\n') + '\n');

    const sessDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, '100.json'), JSON.stringify({
      pid: 100, sessionId: 'sess-1', cwd: '/home/ubuntu/proj', startedAt: 500,
    }));

    const sessions = getSessions(dir, {});
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].sessionId, 'sess-2'); // newest first
    assert.equal(sessions[1].sessionId, 'sess-1');
    assert.equal(sessions[1].messageCount, 2);
  } finally {
    cleanup(dir);
  }
});

test('getSessionDetail returns entries for a specific session', () => {
  const dir = makeTempDir();
  try {
    const fp = path.join(dir, 'history.jsonl');
    const lines = [
      JSON.stringify({ display: 'msg1', pastedContents: {}, timestamp: 1000, project: '/proj', sessionId: 'target' }),
      JSON.stringify({ display: 'msg2', pastedContents: {}, timestamp: 2000, project: '/proj', sessionId: 'other' }),
      JSON.stringify({ display: 'msg3', pastedContents: {}, timestamp: 3000, project: '/proj', sessionId: 'target' }),
    ];
    fs.writeFileSync(fp, lines.join('\n') + '\n');
    const entries = getSessionDetail(fp, 'target');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].display, 'msg1'); // chronological
  } finally {
    cleanup(dir);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/ubuntu/personal/agent-orch && node --test test/claudeHistory.test.js`
Expected: FAIL

- [ ] **Step 3: Write lib/claudeHistory.js**

Create `lib/claudeHistory.js`:

```js
const fs = require('fs');
const path = require('path');

function readLines(fp) {
  try {
    return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function parseHistory(historyPath, { project, search, limit, offset } = {}) {
  let entries = readLines(historyPath);
  if (project) {
    entries = entries.filter(e => e.project === project);
  }
  if (search) {
    const term = search.toLowerCase();
    entries = entries.filter(e => (e.display || '').toLowerCase().includes(term));
  }
  entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const start = offset || 0;
  const end = limit ? start + limit : entries.length;
  return entries.slice(start, end);
}

function getSessions(claudeDir, { project, search, limit, offset } = {}) {
  const historyPath = path.join(claudeDir, 'history.jsonl');
  const entries = readLines(historyPath);

  // Build session map from session files
  const sessionMeta = {};
  const sessDir = path.join(claudeDir, 'sessions');
  try {
    for (const f of fs.readdirSync(sessDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
        if (data.sessionId) sessionMeta[data.sessionId] = data;
      } catch {}
    }
  } catch {}

  // Group by sessionId
  const groups = {};
  for (const e of entries) {
    const sid = e.sessionId;
    if (!sid) continue;
    if (!groups[sid]) {
      groups[sid] = {
        sessionId: sid,
        project: e.project,
        messages: [],
        firstTimestamp: e.timestamp,
        lastTimestamp: e.timestamp,
      };
    }
    groups[sid].messages.push(e);
    if (e.timestamp < groups[sid].firstTimestamp) groups[sid].firstTimestamp = e.timestamp;
    if (e.timestamp > groups[sid].lastTimestamp) groups[sid].lastTimestamp = e.timestamp;
  }

  let sessions = Object.values(groups).map(g => ({
    sessionId: g.sessionId,
    project: g.project,
    messageCount: g.messages.length,
    firstTimestamp: g.firstTimestamp,
    lastTimestamp: g.lastTimestamp,
    cwd: sessionMeta[g.sessionId]?.cwd || g.project,
    startedAt: sessionMeta[g.sessionId]?.startedAt || g.firstTimestamp,
  }));

  if (project) {
    sessions = sessions.filter(s => s.project === project || s.cwd === project);
  }
  if (search) {
    const term = search.toLowerCase();
    const histEntries = parseHistory(path.join(claudeDir, 'history.jsonl'), { search });
    const matchIds = new Set(histEntries.map(e => e.sessionId));
    sessions = sessions.filter(s => matchIds.has(s.sessionId));
  }

  sessions.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
  const start = offset || 0;
  const end = limit ? start + limit : sessions.length;
  return sessions.slice(start, end);
}

function getSessionDetail(historyPath, sessionId) {
  const entries = readLines(historyPath);
  return entries
    .filter(e => e.sessionId === sessionId)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

module.exports = { parseHistory, getSessions, getSessionDetail };
```

- [ ] **Step 4: Run tests**

Run: `cd /home/ubuntu/personal/agent-orch && node --test test/claudeHistory.test.js`
Expected: All 3 tests pass

- [ ] **Step 5: Add history routes to claudeCode.js**

Add to `routes/claudeCode.js`:

```js
// ─── History ─────────────────────────────────────────────────────────────────
const { parseHistory, getSessions, getSessionDetail } = require('../lib/claudeHistory');

router.get('/history/activity', (req, res) => {
  try {
    const fp = path.join(CLAUDE_DIR, 'history.jsonl');
    const entries = parseHistory(fp, {
      project: req.query.project,
      search: req.query.search,
      limit: parseInt(req.query.limit) || 100,
      offset: parseInt(req.query.offset) || 0,
    });
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/history/sessions', (req, res) => {
  try {
    const sessions = getSessions(CLAUDE_DIR, {
      project: req.query.project,
      search: req.query.search,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0,
    });
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/history/:sessionId', (req, res) => {
  try {
    const fp = path.join(CLAUDE_DIR, 'history.jsonl');
    const entries = getSessionDetail(fp, req.params.sessionId);
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

Note: `/history/activity` and `/history/sessions` are registered before `/history/:sessionId` to avoid param capture.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/personal/agent-orch
git add lib/claudeHistory.js routes/claudeCode.js test/claudeHistory.test.js
git commit -m "add History backend with activity feed and session grouping"
```

---

### Task 7: History frontend

**Files:**
- Create: `public/js/tabs/claudeHistory.js`
- Modify: `public/js/main.js`
- Modify: `public/styles.css`

- [ ] **Step 1: Write the frontend module**

Create `public/js/tabs/claudeHistory.js`:

```js
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
```

- [ ] **Step 2: Add CSS**

Append to `public/styles.css`:

```css
/* ─── Claude History tab ──────────────────────────────────────────────────── */
.claude-history-list { display: flex; flex-direction: column; gap: 0.25rem; }
.claude-history-entry {
  display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.8rem;
  border-bottom: 1px solid var(--border); font-size: 0.85rem;
}
.claude-history-time { color: var(--text-muted); font-size: 0.75rem; white-space: nowrap; min-width: 140px; }
.claude-history-display { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.claude-history-session-link { font-size: 0.75rem; white-space: nowrap; }
.claude-history-session-card {
  padding: 0.8rem; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; margin-bottom: 0.5rem;
}
.claude-history-session-card:hover { background: var(--bg-hover); }
.claude-history-session-header { display: flex; align-items: center; gap: 0.6rem; font-size: 0.85rem; }
.claude-history-msg-count { color: var(--text-muted); font-size: 0.78rem; }
.claude-history-conversation { display: flex; flex-direction: column; gap: 0.5rem; }
.claude-history-msg { padding: 0.6rem 0.8rem; border-radius: 6px; background: var(--bg-secondary); font-size: 0.85rem; }
.claude-history-msg .claude-history-time { display: block; margin-bottom: 0.3rem; }
.toggle-group { display: flex; gap: 0; }
.toggle-group .btn-toggle { border-radius: 0; border: 1px solid var(--border); }
.toggle-group .btn-toggle:first-child { border-radius: 4px 0 0 4px; }
.toggle-group .btn-toggle:last-child { border-radius: 0 4px 4px 0; }
.toggle-group .btn-toggle.active { background: var(--primary); color: white; border-color: var(--primary); }
```

- [ ] **Step 3: Wire up in main.js**

Add import:

```js
import {
  loadClaudeHistory,
  setClaudeHistoryView,
  loadClaudeSessionDetail,
  populateClaudeHistoryProjects,
} from './tabs/claudeHistory.js';
```

Add window exposures:

```js
// Claude Code: History
window.loadClaudeHistory = loadClaudeHistory;
window.setClaudeHistoryView = setClaudeHistoryView;
window.loadClaudeSessionDetail = loadClaudeSessionDetail;
```

Add to `loadTab()`:

```js
  else if (tab === 'claude-history') { populateClaudeHistoryProjects(); loadClaudeHistory(); }
```

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/personal/agent-orch
git add public/js/tabs/claudeHistory.js public/js/main.js public/styles.css
git commit -m "add History tab with activity feed and session browser"
```

---

### Task 8: Tasks backend

**Files:**
- Create: `lib/claudeTasks.js`
- Create: `test/claudeTasks.test.js`
- Modify: `routes/claudeCode.js`

- [ ] **Step 1: Write tests**

Create `test/claudeTasks.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listAllTasks, getSessionTasks, promoteTask } = require('../lib/claudeTasks');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-tasks-test-'));
}
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test('listAllTasks finds tasks across session dirs', () => {
  const dir = makeTempDir();
  try {
    const sessDir = path.join(dir, 'tasks', 'sess-aaa');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, '1.json'), JSON.stringify({
      id: '1', subject: 'Fix bug', description: 'Fix the login bug', status: 'in_progress', blocks: [], blockedBy: [],
    }));
    fs.writeFileSync(path.join(sessDir, '2.json'), JSON.stringify({
      id: '2', subject: 'Add tests', description: 'Unit tests', status: 'completed', blocks: [], blockedBy: [],
    }));
    fs.writeFileSync(path.join(sessDir, '.highwatermark'), '2');

    // Also put a session file to map sess-aaa to a project
    const sessions = path.join(dir, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, '100.json'), JSON.stringify({
      pid: 100, sessionId: 'sess-aaa', cwd: '/home/ubuntu/proj', startedAt: 1000,
    }));

    const all = listAllTasks(dir, {});
    assert.equal(all.length, 2);
    assert.equal(all[0].subject, 'Fix bug');

    const filtered = listAllTasks(dir, { status: 'completed' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].subject, 'Add tests');
  } finally {
    cleanup(dir);
  }
});

test('getSessionTasks returns tasks for a specific session', () => {
  const dir = makeTempDir();
  try {
    const sessDir = path.join(dir, 'tasks', 'sess-bbb');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, '1.json'), JSON.stringify({
      id: '1', subject: 'Deploy', status: 'pending', blocks: [], blockedBy: [],
    }));

    const tasks = getSessionTasks(dir, 'sess-bbb');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].subject, 'Deploy');
  } finally {
    cleanup(dir);
  }
});

test('promoteTask returns a todo item', () => {
  const dir = makeTempDir();
  try {
    const sessDir = path.join(dir, 'tasks', 'sess-ccc');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, '3.json'), JSON.stringify({
      id: '3', subject: 'Review PR', description: 'Review the auth PR', status: 'pending', blocks: [], blockedBy: [],
    }));
    const todo = promoteTask(dir, 'sess-ccc', '3');
    assert.equal(todo.text, 'Review PR');
    assert.equal(todo.description, 'Review the auth PR');
    assert.equal(todo.source, 'claude-tasks');
  } finally {
    cleanup(dir);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/ubuntu/personal/agent-orch && node --test test/claudeTasks.test.js`
Expected: FAIL

- [ ] **Step 3: Write lib/claudeTasks.js**

Create `lib/claudeTasks.js`:

```js
const fs = require('fs');
const path = require('path');

function readJsonSafe(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function buildSessionProjectMap(claudeDir) {
  const map = {};
  const sessDir = path.join(claudeDir, 'sessions');
  try {
    for (const f of fs.readdirSync(sessDir)) {
      if (!f.endsWith('.json')) continue;
      const data = readJsonSafe(path.join(sessDir, f));
      if (data && data.sessionId) map[data.sessionId] = data.cwd || '';
    }
  } catch {}
  return map;
}

function readSessionTasks(tasksDir, sessionId) {
  const sessDir = path.join(tasksDir, sessionId);
  const tasks = [];
  try {
    for (const f of fs.readdirSync(sessDir)) {
      if (!f.endsWith('.json')) continue;
      const data = readJsonSafe(path.join(sessDir, f));
      if (data && data.id) {
        data.sessionId = sessionId;
        tasks.push(data);
      }
    }
  } catch {}
  return tasks;
}

function listAllTasks(claudeDir, { status, project } = {}) {
  const tasksDir = path.join(claudeDir, 'tasks');
  const sessionProjectMap = buildSessionProjectMap(claudeDir);
  let all = [];

  try {
    for (const sessionId of fs.readdirSync(tasksDir)) {
      const sessPath = path.join(tasksDir, sessionId);
      let stat;
      try { stat = fs.statSync(sessPath); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const tasks = readSessionTasks(tasksDir, sessionId);
      for (const t of tasks) {
        t.project = sessionProjectMap[sessionId] || '';
      }
      all.push(...tasks);
    }
  } catch {}

  if (status) {
    all = all.filter(t => t.status === status);
  }
  if (project) {
    all = all.filter(t => t.project === project);
  }

  // Sort: in_progress first, then pending, then completed
  const statusOrder = { in_progress: 0, pending: 1, completed: 2 };
  all.sort((a, b) => (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3));

  return all;
}

function getSessionTasks(claudeDir, sessionId) {
  return readSessionTasks(path.join(claudeDir, 'tasks'), sessionId);
}

function promoteTask(claudeDir, sessionId, taskId) {
  const fp = path.join(claudeDir, 'tasks', sessionId, `${taskId}.json`);
  const task = readJsonSafe(fp);
  if (!task) throw new Error('Task not found');
  return {
    text: task.subject || `Task ${taskId}`,
    description: task.description || '',
    status: 'todo',
    source: 'claude-tasks',
    sourceSession: sessionId,
    sourceTaskId: taskId,
  };
}

module.exports = { listAllTasks, getSessionTasks, promoteTask };
```

- [ ] **Step 4: Run tests**

Run: `cd /home/ubuntu/personal/agent-orch && node --test test/claudeTasks.test.js`
Expected: All 3 tests pass

- [ ] **Step 5: Add task routes to claudeCode.js**

Add to `routes/claudeCode.js`:

```js
// ─── Tasks ───────────────────────────────────────────────────────────────────
const { listAllTasks, getSessionTasks, promoteTask } = require('../lib/claudeTasks');

router.get('/tasks', (req, res) => {
  try {
    const tasks = listAllTasks(CLAUDE_DIR, {
      status: req.query.status,
      project: req.query.project,
    });
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/tasks/:sessionId', (req, res) => {
  try {
    const tasks = getSessionTasks(CLAUDE_DIR, req.params.sessionId);
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tasks/:sessionId/:taskId/promote', (req, res) => {
  try {
    const todo = promoteTask(CLAUDE_DIR, req.params.sessionId, req.params.taskId);
    res.json(todo);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/personal/agent-orch
git add lib/claudeTasks.js routes/claudeCode.js test/claudeTasks.test.js
git commit -m "add Tasks backend with listing and promote-to-todo"
```

---

### Task 9: Tasks frontend

**Files:**
- Create: `public/js/tabs/claudeTasks.js`
- Modify: `public/js/main.js`
- Modify: `public/styles.css`

- [ ] **Step 1: Write the frontend module**

Create `public/js/tabs/claudeTasks.js`:

```js
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
```

- [ ] **Step 2: Add CSS**

Append to `public/styles.css`:

```css
/* ─── Claude Tasks tab ────────────────────────────────────────────────────── */
.claude-tasks-list { display: flex; flex-direction: column; gap: 1rem; }
.claude-tasks-group-header {
  font-size: 0.85rem; text-transform: capitalize; cursor: pointer;
  display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0;
}
.claude-tasks-count { font-size: 0.75rem; color: var(--text-muted); }
.claude-tasks-collapsed .claude-tasks-group-body { display: none; }
.claude-task-card {
  border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem 0.8rem; margin-bottom: 0.3rem;
}
.claude-task-card summary { cursor: pointer; display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
.claude-task-subject { font-weight: 500; flex: 1; }
.claude-task-owner { font-size: 0.75rem; color: var(--text-muted); }
.claude-task-detail { padding-top: 0.5rem; font-size: 0.83rem; }
.claude-task-detail p { margin: 0.3rem 0; }
.claude-task-active { color: var(--text-muted); }
.claude-task-status-in_progress { background: var(--warning-bg, #fef3c7); color: var(--warning-text, #92400e); }
.claude-task-status-pending { background: var(--info-bg, #dbeafe); color: var(--info-text, #1e40af); }
.claude-task-status-completed { background: var(--success-bg, #d1fae5); color: var(--success-text, #065f46); }
```

- [ ] **Step 3: Wire up in main.js**

Add import:

```js
import {
  loadClaudeTasks,
  promoteClaudeTask,
  toggleClaudeTasksAutoRefresh,
  clearClaudeTasksAutoRefresh,
} from './tabs/claudeTasks.js';
```

Add window exposures:

```js
// Claude Code: Tasks
window.loadClaudeTasks = loadClaudeTasks;
window.promoteClaudeTask = promoteClaudeTask;
window.toggleClaudeTasksAutoRefresh = toggleClaudeTasksAutoRefresh;
```

Add to `loadTab()`:

```js
  else if (tab === 'claude-tasks') loadClaudeTasks();
```

Update the auto-refresh clearing at the top of `loadTab()`:

```js
  if (tab !== 'agents') clearAgentAutoRefresh();
  if (tab !== 'claude-tasks') clearClaudeTasksAutoRefresh();
```

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/personal/agent-orch
git add public/js/tabs/claudeTasks.js public/js/main.js public/styles.css
git commit -m "add Claude Tasks tab with status groups and promote-to-todo"
```

---

### Task 10: File Diffs backend

The file-history hashes cannot be reversed to file paths. Instead, we correlate session IDs to projects and show version history per file hash with content previews. The `diff` npm package generates structured diffs between consecutive versions.

**Files:**
- Create: `lib/claudeDiffs.js`
- Create: `test/claudeDiffs.test.js`
- Modify: `routes/claudeCode.js`

- [ ] **Step 1: Write tests**

Create `test/claudeDiffs.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listFileChanges, getVersionDiff } = require('../lib/claudeDiffs');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-diffs-test-'));
}
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test('listFileChanges finds versioned files grouped by hash', () => {
  const dir = makeTempDir();
  try {
    const sessDir = path.join(dir, 'file-history', 'sess-aaa');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'abc123@v1'), 'function hello() {}');
    fs.writeFileSync(path.join(sessDir, 'abc123@v2'), 'function hello() { return 1; }');
    fs.writeFileSync(path.join(sessDir, 'def456@v1'), 'const x = 1;');

    // Session metadata
    const sessions = path.join(dir, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, '100.json'), JSON.stringify({
      pid: 100, sessionId: 'sess-aaa', cwd: '/home/ubuntu/proj', startedAt: 1000,
    }));

    const changes = listFileChanges(dir, {});
    assert.equal(changes.length, 2); // two distinct file hashes
    const abc = changes.find(c => c.hash === 'abc123');
    assert.equal(abc.versions, 2);
    assert.equal(abc.project, '/home/ubuntu/proj');
    assert.ok(abc.preview.includes('function hello'));
  } finally {
    cleanup(dir);
  }
});

test('getVersionDiff returns diff between two versions', () => {
  const dir = makeTempDir();
  try {
    const sessDir = path.join(dir, 'file-history', 'sess-bbb');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'abc123@v1'), 'line1\nline2\n');
    fs.writeFileSync(path.join(sessDir, 'abc123@v2'), 'line1\nline2 changed\nline3\n');

    const result = getVersionDiff(dir, 'sess-bbb', 'abc123', 1, 2);
    assert.ok(result.oldContent.includes('line2'));
    assert.ok(result.newContent.includes('line2 changed'));
    assert.ok(result.hunks.length > 0);
  } finally {
    cleanup(dir);
  }
});

test('getVersionDiff returns diff from empty for v1', () => {
  const dir = makeTempDir();
  try {
    const sessDir = path.join(dir, 'file-history', 'sess-ccc');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'xyz789@v1'), 'new file content\n');

    const result = getVersionDiff(dir, 'sess-ccc', 'xyz789', 0, 1);
    assert.equal(result.oldContent, '');
    assert.ok(result.newContent.includes('new file content'));
  } finally {
    cleanup(dir);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/ubuntu/personal/agent-orch && node --test test/claudeDiffs.test.js`
Expected: FAIL

- [ ] **Step 3: Write lib/claudeDiffs.js**

Create `lib/claudeDiffs.js`:

```js
const fs = require('fs');
const path = require('path');
const { structuredPatch } = require('diff');

function readTextSafe(fp) {
  try { return fs.readFileSync(fp, 'utf8'); } catch { return null; }
}

function readJsonSafe(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function buildSessionProjectMap(claudeDir) {
  const map = {};
  const sessDir = path.join(claudeDir, 'sessions');
  try {
    for (const f of fs.readdirSync(sessDir)) {
      if (!f.endsWith('.json')) continue;
      const data = readJsonSafe(path.join(sessDir, f));
      if (data && data.sessionId) map[data.sessionId] = data.cwd || '';
    }
  } catch {}
  return map;
}

function listFileChanges(claudeDir, { project } = {}) {
  const fileHistDir = path.join(claudeDir, 'file-history');
  const sessionProjectMap = buildSessionProjectMap(claudeDir);
  const results = [];

  try {
    for (const sessionId of fs.readdirSync(fileHistDir)) {
      const sessDir = path.join(fileHistDir, sessionId);
      let stat;
      try { stat = fs.statSync(sessDir); } catch { continue; }
      if (!stat.isDirectory()) continue;

      const sessionProject = sessionProjectMap[sessionId] || '';
      if (project && sessionProject !== project) continue;

      // Group files by hash
      const byHash = {};
      try {
        for (const f of fs.readdirSync(sessDir)) {
          const match = f.match(/^([a-f0-9]+)@v(\d+)$/);
          if (!match) continue;
          const hash = match[1];
          const version = parseInt(match[2]);
          if (!byHash[hash]) byHash[hash] = [];
          byHash[hash].push({ version, file: f });
        }
      } catch { continue; }

      for (const [hash, versions] of Object.entries(byHash)) {
        versions.sort((a, b) => a.version - b.version);
        const latestFile = versions[versions.length - 1].file;
        const content = readTextSafe(path.join(sessDir, latestFile)) || '';
        const firstLine = content.split('\n')[0] || '';

        // Get mtime of latest version as the timestamp
        let mtime = 0;
        try {
          mtime = fs.statSync(path.join(sessDir, latestFile)).mtimeMs;
        } catch {}

        results.push({
          hash,
          sessionId,
          project: sessionProject,
          versions: versions.length,
          latestVersion: versions[versions.length - 1].version,
          preview: firstLine.slice(0, 120),
          mtime,
        });
      }
    }
  } catch {}

  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

function getVersionDiff(claudeDir, sessionId, hash, fromVersion, toVersion) {
  const sessDir = path.join(claudeDir, 'file-history', sessionId);
  const oldContent = fromVersion > 0
    ? readTextSafe(path.join(sessDir, `${hash}@v${fromVersion}`)) || ''
    : '';
  const newContent = readTextSafe(path.join(sessDir, `${hash}@v${toVersion}`)) || '';

  const patch = structuredPatch(
    `v${fromVersion}`, `v${toVersion}`,
    oldContent, newContent,
    '', '', { context: 3 }
  );

  return {
    oldContent,
    newContent,
    hunks: patch.hunks,
  };
}

module.exports = { listFileChanges, getVersionDiff };
```

- [ ] **Step 4: Run tests**

Run: `cd /home/ubuntu/personal/agent-orch && node --test test/claudeDiffs.test.js`
Expected: All 3 tests pass

- [ ] **Step 5: Add diff routes to claudeCode.js**

Add to `routes/claudeCode.js`:

```js
// ─── File Diffs ──────────────────────────────────────────────────────────────
const { listFileChanges, getVersionDiff } = require('../lib/claudeDiffs');

router.get('/diffs', (req, res) => {
  try {
    const changes = listFileChanges(CLAUDE_DIR, { project: req.query.project });
    res.json({ changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/diffs/:sessionId/:hash', (req, res) => {
  try {
    const from = parseInt(req.query.from) || 0;
    const to = parseInt(req.query.to) || 1;
    const result = getVersionDiff(CLAUDE_DIR, req.params.sessionId, req.params.hash, from, to);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/personal/agent-orch
git add lib/claudeDiffs.js routes/claudeCode.js test/claudeDiffs.test.js
git commit -m "add File Diffs backend with version history and diff generation"
```

---

### Task 11: File Diffs frontend

**Files:**
- Create: `public/js/tabs/claudeDiffs.js`
- Modify: `public/js/main.js`
- Modify: `public/styles.css`

- [ ] **Step 1: Write the frontend module**

Create `public/js/tabs/claudeDiffs.js`:

```js
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

  const oldLines = data.oldContent.split('\n');
  const newLines = data.newContent.split('\n');

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
```

- [ ] **Step 2: Add CSS for diff viewer**

Append to `public/styles.css`:

```css
/* ─── Claude File Diffs tab ───────────────────────────────────────────────── */
.claude-diffs-list { display: flex; flex-direction: column; gap: 0.5rem; }
.claude-diff-card { border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem 0.8rem; }
.claude-diff-card summary { cursor: pointer; display: flex; align-items: center; gap: 0.6rem; font-size: 0.85rem; }
.claude-diff-hash { font-family: monospace; font-size: 0.8rem; color: var(--primary); min-width: 70px; }
.claude-diff-versions { font-size: 0.75rem; color: var(--text-muted); white-space: nowrap; }
.claude-diff-preview { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: 0.78rem; font-family: monospace; }
.claude-diff-time { font-size: 0.72rem; color: var(--text-muted); white-space: nowrap; }
.claude-diff-body { margin-top: 0.8rem; }
.claude-diff-version-controls { display: flex; gap: 1rem; margin-bottom: 0.5rem; font-size: 0.82rem; }
.claude-diff-version-controls select { font-size: 0.82rem; padding: 0.2rem 0.4rem; }
.claude-diff-table { width: 100%; border-collapse: collapse; font-family: monospace; font-size: 0.78rem; table-layout: fixed; }
.claude-diff-table th { text-align: left; padding: 0.3rem 0.5rem; background: var(--bg-secondary); font-size: 0.72rem; }
.claude-diff-table td { padding: 0 0.5rem; white-space: pre-wrap; word-break: break-all; vertical-align: top; border-bottom: 1px solid var(--border-light, rgba(128,128,128,0.1)); }
.claude-diff-ln { width: 40px; color: var(--text-muted); text-align: right; user-select: none; font-size: 0.72rem; }
.claude-diff-table th:nth-child(2), .claude-diff-table td:nth-child(2) { width: calc(50% - 40px); }
.claude-diff-table th:nth-child(4), .claude-diff-table td:nth-child(4) { width: calc(50% - 40px); }
.claude-diff-del td { background: rgba(239, 68, 68, 0.12); }
.claude-diff-add td { background: rgba(34, 197, 94, 0.12); }
.claude-diff-hunk-header td { background: var(--bg-secondary); color: var(--text-muted); font-size: 0.72rem; padding: 0.2rem 0.5rem; }
```

- [ ] **Step 3: Wire up in main.js**

Add import:

```js
import {
  loadClaudeDiffs,
  loadDiffOnExpand,
  reloadDiff,
} from './tabs/claudeDiffs.js';
```

Add window exposures:

```js
// Claude Code: File Diffs
window.loadClaudeDiffs = loadClaudeDiffs;
window.loadDiffOnExpand = loadDiffOnExpand;
window.reloadDiff = reloadDiff;
```

Add to `loadTab()`:

```js
  else if (tab === 'claude-diffs') loadClaudeDiffs();
```

- [ ] **Step 4: Commit**

```bash
cd /home/ubuntu/personal/agent-orch
git add public/js/tabs/claudeDiffs.js public/js/main.js public/styles.css
git commit -m "add File Diffs tab with side-by-side diff viewer"
```

---

### Task 12: Agent drawer context enhancement

**Files:**
- Modify: `lib/agentContext.js`
- Modify: `public/js/tabs/agentContext.js`
- Modify: `public/js/main.js`

- [ ] **Step 1: Add getClaudeDrawerExtras to lib/agentContext.js**

Add at the top of `lib/agentContext.js`, after the existing requires:

```js
const { listAllTasks } = require('./claudeTasks');
const { listFileChanges } = require('./claudeDiffs');
const { parseHistory } = require('./claudeHistory');
```

Add this function before `module.exports`:

```js
function getClaudeDrawerExtras(cwd) {
  const home = os.homedir();
  const claudeDir = path.join(home, '.claude');
  const extras = [];

  // Recent tasks for this project
  try {
    const tasks = listAllTasks(claudeDir, { project: cwd })
      .filter(t => t.status === 'in_progress' || t.status === 'pending')
      .slice(0, 5);
    if (tasks.length) {
      extras.push({
        title: 'Recent Tasks',
        scope: 'project',
        icon: 'doc',
        drawerExtra: 'tasks',
        items: tasks.map(t => ({
          label: t.subject || 'Untitled',
          value: t.status,
        })),
      });
    }
  } catch {}

  // Recent file changes for this project
  try {
    const changes = listFileChanges(claudeDir, { project: cwd }).slice(0, 5);
    if (changes.length) {
      extras.push({
        title: 'Recent File Changes',
        scope: 'project',
        icon: 'doc',
        drawerExtra: 'diffs',
        items: changes.map(c => ({
          label: `${c.hash.slice(0, 8)} (${c.versions}v)`,
          value: c.preview.slice(0, 60),
        })),
      });
    }
  } catch {}

  // Recent activity for this project
  try {
    const historyPath = path.join(claudeDir, 'history.jsonl');
    const entries = parseHistory(historyPath, { project: cwd, limit: 5 });
    if (entries.length) {
      extras.push({
        title: 'Recent Activity',
        scope: 'project',
        icon: 'chart',
        drawerExtra: 'history',
        items: entries.map(e => ({
          label: (e.display || '').slice(0, 80),
          value: new Date(e.timestamp).toLocaleString(),
        })),
      });
    }
  } catch {}

  return extras;
}
```

Update `module.exports` to include the new function:

```js
module.exports = {
  readJsonSafe,
  readTextSafe,
  getGitInfo,
  getClaudeContext,
  getClaudeDrawerExtras,
  getCodexContext,
  getGeminiContext,
};
```

- [ ] **Step 2: Update the agents route to include drawer extras**

Find where the agent context endpoint calls `getClaudeContext` in `routes/agents.js` and add the drawer extras to the response. Search for the endpoint:

Run: `cd /home/ubuntu/personal/agent-orch && grep -n 'getClaudeContext\|agentContext\|/context' routes/agents.js | head -10`

In the context endpoint handler, after the line that sets `sections` from `getClaudeContext(cwd)`, add:

```js
const { getClaudeDrawerExtras } = require('../lib/agentContext');
// ... inside the handler, after sections are built for claude:
if (agentId === 'claude') {
  const extras = getClaudeDrawerExtras(cwd);
  sections.push(...extras);
}
```

- [ ] **Step 3: Add "View in tab" links in agentContext.js frontend**

In `public/js/tabs/agentContext.js`, update `renderContextSection` to detect `drawerExtra` sections and add a footer link.

Find the closing `</div>` of `bodyHtml` for `section.items` rendering (around the `else if (section.items)` block), and wrap it to add a footer when `section.drawerExtra` exists:

```js
  // After bodyHtml is set from section.items:
  if (section.drawerExtra) {
    const tabMap = { tasks: 'claude-tasks', diffs: 'claude-diffs', history: 'claude-history' };
    const tabName = tabMap[section.drawerExtra] || '';
    if (tabName) {
      bodyHtml += `<div class="ctx-section-footer"><a href="#" onclick="event.preventDefault();document.querySelector('[data-tab=${tabName}]').click()">View all in tab →</a></div>`;
    }
  }
```

- [ ] **Step 4: Add CSS for the footer link**

Append to `public/styles.css`:

```css
.ctx-section-footer { padding: 0.4rem 0 0; text-align: right; }
.ctx-section-footer a { font-size: 0.75rem; color: var(--primary); text-decoration: none; }
.ctx-section-footer a:hover { text-decoration: underline; }
```

- [ ] **Step 5: Run all tests**

Run: `cd /home/ubuntu/personal/agent-orch && node --test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/personal/agent-orch
git add lib/agentContext.js routes/agents.js public/js/tabs/agentContext.js public/styles.css
git commit -m "add Claude tasks, diffs, and activity to agent context drawer"
```

---

### Task 13: CSS for settings and shared components

**Files:**
- Modify: `public/styles.css`

- [ ] **Step 1: Add remaining CSS for settings and shared components**

Append to `public/styles.css`:

```css
/* ─── Claude Settings tab ─────────────────────────────────────────────────── */
.claude-settings-layout { display: flex; flex-direction: column; gap: 2rem; }
.claude-settings-section h3 { margin-bottom: 0.5rem; font-size: 0.95rem; }
.claude-settings-section h4 { margin-bottom: 0.3rem; font-size: 0.85rem; color: var(--text-muted); }
.settings-path { font-size: 0.72rem; font-family: monospace; color: var(--text-muted); margin-left: 0.5rem; }
.claude-settings-project-editors { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 0.5rem; }

/* ─── Shared auto-refresh ─────────────────────────────────────────────────── */
.auto-refresh-toggle { display: flex; align-items: center; gap: 0.3rem; font-size: 0.82rem; cursor: pointer; }
```

- [ ] **Step 2: Commit**

```bash
cd /home/ubuntu/personal/agent-orch
git add public/styles.css
git commit -m "add CSS for settings layout and shared components"
```

---

### Task 14: Integration test and final verification

**Files:**
- No new files

- [ ] **Step 1: Run all tests**

Run: `cd /home/ubuntu/personal/agent-orch && node --test`
Expected: All tests pass (existing + 4 new test files)

- [ ] **Step 2: Verify server starts**

Run: `cd /home/ubuntu/personal/agent-orch && timeout 3 node server.js 2>&1 || true`
Expected: "OpenOrcha running at http://127.0.0.1:3456" (then timeout)

- [ ] **Step 3: Verify all API endpoints respond**

Run: `cd /home/ubuntu/personal/agent-orch && node -e "
const http = require('http');
const endpoints = [
  '/api/claude/settings',
  '/api/claude/memory',
  '/api/claude/history/activity',
  '/api/claude/history/sessions',
  '/api/claude/tasks',
  '/api/claude/diffs',
];
// Start server temporarily
const app = require('./server-test-helper');
// Or just verify routes load:
const router = require('./routes/claudeCode');
console.log('Route file loads OK');
console.log('Registered routes:', router.stack.filter(r => r.route).map(r => r.route.path));
"`

- [ ] **Step 4: Commit any fixes**

If any issues found, fix and commit.
