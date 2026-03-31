# Claude Code Tabs for OpenOrcha

Five new tabs under a "Claude Code" sidebar section, plus agent drawer enhancements. All tabs read from and write to `~/.claude/`.

## Decision Log

| Choice | Decision |
|--------|----------|
| Scope | Global tabs + agent-scoped context (both) |
| Diff viewer | Side-by-side visual diff with rollback |
| Session history | Activity feed default + drill into full conversation |
| Claude tasks vs todos | Separate tab with cross-link (promote to todo) |
| Memory editing | Full editing (CLAUDE.md and memory files) |
| Settings editing | Raw JSON editor |

## 1. Sidebar Navigation

A non-clickable "Claude Code" section header in the sidebar, with five tabs beneath it.

```
── existing tabs ──
  Agents
  Sessions
  Hosts
  Keys
  Known Hosts
  ...

── Claude Code ──────
  Memory
  History
  Tasks
  Settings
  File Diffs
```

Same activation pattern as existing tabs: click calls `load{Name}()`, shows `#tab-{name}`.

### Changes Required

- `public/index.html`: add section divider + five `<div id="tab-claude-*" class="tab-content">` containers and five nav items
- `public/js/main.js`: import and expose new tab modules
- `public/styles.css`: sidebar section header style (~10 lines)

## 2. Project Memory Tab

Browse and edit CLAUDE.md, MEMORY.md, and memory files across all projects.

### Backend

**New file:** `lib/claudeMemory.js`

Reads `~/.claude/projects/` directory. Decodes folder names to paths (e.g. `-home-ubuntu-soci-soci-dev` to `/home/ubuntu/soci/soci-dev`). Parses memory file frontmatter (name, description, type).

**New file:** `routes/claudeCode.js`

All five tabs share one route file mounted at `/api/claude`.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/claude/memory` | List all projects with memory file count and CLAUDE.md presence |
| GET | `/api/claude/memory/:project` | All memory data for a project: CLAUDE.md, MEMORY.md, memory files with parsed frontmatter |
| PUT | `/api/claude/memory/:project/claude-md` | Update CLAUDE.md content |
| PUT | `/api/claude/memory/:project/memory-md` | Update MEMORY.md index |
| POST | `/api/claude/memory/:project/file` | Create a new memory file |
| PUT | `/api/claude/memory/:project/file/:filename` | Update a memory file |
| DELETE | `/api/claude/memory/:project/file/:filename` | Delete a memory file |

The `:project` parameter is the encoded folder name (e.g. `-home-ubuntu-soci-soci-dev`).

### Frontend

**New file:** `public/js/tabs/claudeMemory.js`

- Left panel: project list with search filter. Each item shows decoded path and memory file count.
- Right panel: selected project contents.
  - CLAUDE.md textarea with Save button
  - MEMORY.md textarea with Save button
  - Memory files as expandable cards grouped by type (user, feedback, project, reference)
  - Each card: name, description, type badge. Click to expand and edit content textarea.
  - "New Memory" button: form with frontmatter fields (name, description, type dropdown) + content textarea

Plain textareas, no syntax highlighting. Consistent with existing raw-config tab.

## 3. Session History Tab

Activity feed and conversation browser for Claude Code sessions.

### Backend

**New file:** `lib/claudeHistory.js`

Parses `~/.claude/history.jsonl` (one JSON object per line). Scans `~/.claude/sessions/` for session metadata. Extracts actions from conversations: files edited, commands run, tools used. Groups entries by session, associates with projects.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/claude/history` | Paginated session list (newest first). Query: `?limit=50&offset=0&project=<encoded>&search=<term>` |
| GET | `/api/claude/history/activity` | Flat action feed across sessions. Query: `?limit=100&offset=0&project=<encoded>` |
| GET | `/api/claude/history/:sessionId` | Full conversation for one session |

Note: `/api/claude/history/activity` must be registered before `/api/claude/history/:sessionId` to avoid the param capturing "activity" as a session ID.

### Frontend

**New file:** `public/js/tabs/claudeHistory.js`

- Default view: **Activity Feed**. Timeline of actions with type icons (file edit, command, tool use, error). Each entry: timestamp, project badge, action description, "View session" link.
- Toggle to **Session List** view. Session cards: timestamp, project, message count, duration. Click to expand.
- Session detail: messages as chat log (user vs assistant styled differently). Tool calls as collapsible blocks.
- Search bar at top filters both views by keyword.
- Project filter dropdown.
- "Load more" button for pagination.

## 4. Claude Code Tasks Tab

Read-only view of Claude Code background tasks with promote-to-todo action.

### Backend

**New file:** `lib/claudeTasks.js`

Scans `~/.claude/tasks/` directory. Each subdirectory is a task group with JSON files. Parses task fields: subject, description, status, owner, metadata, timestamps. Associates with projects where possible.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/claude/tasks` | All tasks. Query: `?status=<pending\|in_progress\|completed>&project=<encoded>` |
| GET | `/api/claude/tasks/:groupId` | Tasks within a group |
| GET | `/api/claude/tasks/:groupId/:taskId` | Single task detail |
| POST | `/api/claude/tasks/:groupId/:taskId/promote` | Copy task to OpenOrcha todo format. Returns the new todo item. |

### Frontend

**New file:** `public/js/tabs/claudeTasks.js`

- Tasks grouped by status: **In Progress** (top), **Pending**, **Completed** (collapsed by default).
- Each card: subject, description preview, status badge, project badge, owner, timestamps.
- Click to expand full detail (description, metadata, blockers).
- "Add to Todo" button on each task. Calls promote endpoint, shows toast, adds link icon.
- Project filter dropdown and status filter.
- Auto-refresh checkbox (polls every 15s). Same pattern as agents tab.

No editing of Claude Code tasks. They are managed by Claude Code itself.

## 5. Settings Tab

Raw JSON editor for global and per-project Claude Code settings.

### Backend

**New file:** `lib/claudeSettings.js`

Reads `~/.claude/settings.json` (global), `~/.claude/projects/<encoded>/settings.json` and `settings.local.json` (per-project).

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/claude/settings` | Global settings JSON + list of projects with settings |
| GET | `/api/claude/settings/:project` | Project settings.json and settings.local.json |
| PUT | `/api/claude/settings/global` | Overwrite global settings.json. Server validates JSON before writing. |
| PUT | `/api/claude/settings/:project` | Overwrite project settings.json |
| PUT | `/api/claude/settings/:project/local` | Overwrite project settings.local.json |

### Frontend

**New file:** `public/js/tabs/claudeSettings.js`

- Top: **Global Settings** textarea with Save button.
- Below: **Project Settings** with project dropdown. Two textareas side by side: `settings.json` and `settings.local.json`, each with Save.
- Client-side JSON validation before submit (`try { JSON.parse(content) }`). Error toast on invalid JSON.

## 6. File Diffs Tab

Visual side-by-side diff viewer with rollback.

### Backend

**New file:** `lib/claudeDiffs.js`

Scans `~/.claude/file-history/` (timestamped file snapshots per project) and `~/.claude/backups/` (pre-edit backups). For each entry: identifies original file path, timestamp, project. Generates diffs comparing backup to current file on disk.

**New dependency:** `diff` npm package. Pure JS, ~50KB, zero transitive deps. Used for structured diff generation.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/claude/diffs` | List of tracked file changes: path, project, timestamp, type. Query: `?project=<encoded>&limit=50&offset=0` |
| GET | `/api/claude/diffs/:id` | Diff detail: old content, new content, unified diff. `:id` is base64-encoded composite of project + filepath + timestamp. |
| POST | `/api/claude/diffs/:id/rollback` | Restore backup over current file. Creates safety backup of current version first. |

### Frontend

**New file:** `public/js/tabs/claudeDiffs.js`

- File change list: cards with file path, project badge, timestamp, change type badge (green=created, yellow=modified, red=deleted).
- Project filter dropdown and date range filter.
- Click card to expand **side-by-side diff viewer**:
  - Left pane: old content (backup). Right pane: current content.
  - Changed lines highlighted (green additions, red deletions).
  - Line numbers on both sides.
  - Plain HTML/CSS table with two `<td>` columns, rows aligned by line, colored backgrounds.
  - No third-party diff viewer component.
- **Rollback deferred.** File-history stores content by hash, not by original file path. Since the hash-to-path mapping is internal to Claude Code and not reversible, rollback requires knowing which file a hash refers to. This may be added later if Claude Code exposes that mapping. For now, the tab is a read-only version history browser with diffs.

## 7. Agent Context Drawer Enhancement

Three new sections added to the existing Context tab in the agent drawer. Only shown for Claude agents (`agentId === 'claude'`).

### New Sections

1. **Recent Tasks** -- up to 5 in-progress/pending tasks for the agent's project. Subject, status badge, description preview. Footer: "View all in Tasks tab" link.

2. **Recent File Changes** -- up to 5 most recent file changes for the project. Filename, timestamp, change type badge. Footer: "View all in File Diffs tab" link.

3. **Session Activity** -- up to 5 most recent actions from history for the project. Action type icon, description, timestamp. Footer: "View all in History tab" link.

### Implementation

These sections reuse the global tab API endpoints with `?project=<encoded>&limit=5`. No duplicate backend logic.

Project is resolved from the agent's `cwd` (already available) encoded to the `~/.claude/projects/` folder name format. If no matching project folder exists, the sections are omitted.

### Changes Required

- `lib/agentContext.js`: add `getClaudeDrawerExtras(cwd)` function that calls the history, tasks, and diffs modules
- `public/js/tabs/agentContext.js`: render three new collapsible sections using existing `renderContextBlock()` pattern
- Footer links use `window.switchToTab('claude-tasks')` (or equivalent) to navigate to the global tab with project pre-filtered

### Other Agents

The new sections are Claude-specific. The existing Codex (`getCodexContext`) and Gemini (`getGeminiContext`) context functions are unchanged. If those agents add similar data directories in the future, the same section pattern can be added to their context functions without frontend changes.

## New Files Summary

| File | Type | Purpose |
|------|------|---------|
| `lib/claudeMemory.js` | Backend | Memory/CLAUDE.md reading and writing |
| `lib/claudeHistory.js` | Backend | Session history and activity parsing |
| `lib/claudeTasks.js` | Backend | Task directory scanning and promote action |
| `lib/claudeSettings.js` | Backend | Settings reading and writing |
| `lib/claudeDiffs.js` | Backend | File history scanning and diff generation |
| `routes/claudeCode.js` | Backend | Single route file for all `/api/claude/*` endpoints |
| `public/js/tabs/claudeMemory.js` | Frontend | Memory tab UI |
| `public/js/tabs/claudeHistory.js` | Frontend | History tab UI |
| `public/js/tabs/claudeTasks.js` | Frontend | Tasks tab UI |
| `public/js/tabs/claudeSettings.js` | Frontend | Settings tab UI |
| `public/js/tabs/claudeDiffs.js` | Frontend | File diffs tab UI |

## Modified Files Summary

| File | Change |
|------|--------|
| `server.js` | Mount `routes/claudeCode.js` at `/api/claude` |
| `public/index.html` | Add sidebar section header + 5 tab containers + 5 nav items |
| `public/js/main.js` | Import and expose 5 new tab modules |
| `public/styles.css` | Sidebar section header style, diff viewer styles, memory editor styles |
| `lib/agentContext.js` | Add `getClaudeDrawerExtras()` calling new modules |
| `public/js/tabs/agentContext.js` | Render 3 new drawer sections with "View in tab" links |
| `package.json` | Add `diff` dependency |

## Dependencies

One new npm dependency: `diff` (pure JS, ~50KB, zero transitive deps). Used by `lib/claudeDiffs.js` for structured diff generation.
