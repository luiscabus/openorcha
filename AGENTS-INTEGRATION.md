# AI Agent Integration Guide

This document contains everything needed to wire a new AI coding agent into the SSH Config UI's agent monitoring system.

---

## Architecture Overview

The system discovers running agent processes via `ps`, reads their session history from agent-specific storage, captures live terminal output via tmux/screen, and enables bidirectional communication. Each agent needs 5 integration points: detection, session parsing, API wiring, frontend metadata, and context/config reading.

```
┌─────────────┐     ┌──────────────┐     ┌───────────────────┐
│  ps -eo ... │────▶│ AGENT_DEFS   │────▶│ Agent Card Grid   │
│  (process)  │     │ match(bin,   │     │ (Interactive /    │
│             │     │        args) │     │  Background)      │
└─────────────┘     └──────────────┘     └────────┬──────────┘
                                                   │ click
                                         ┌─────────▼──────────┐
                                         │   Drawer (3 tabs)  │
                                         │                    │
                                         │ Messages │Terminal │Context│
                                         │ (parsed  │(tmux   │(config│
                                         │  JSONL)  │capture)│files) │
                                         └──────────────────────┘
```

---

## Step 1: Agent Detection — `lib/agentParsers.js`

Add an entry to the `AGENT_DEFS` array:

```javascript
const AGENT_DEFS = [
  // existing agents...
  { id: 'youragent', name: 'Your Agent', match: (bin, args) => bin === 'youragent' || /\/bin\/youragent(\s|$)/.test(args) },
];
```

**Contract:**
- `id` — unique lowercase identifier, used everywhere as the key
- `name` — display name shown in UI
- `match(bin, args)` — receives the process binary basename and full args string from `ps -eo args`; return `true` if this process is the agent

**How detection works:**
The `GET /api/agents` endpoint runs `ps -eo pid,pcpu,pmem,tty,etime,args`, iterates every process, and calls `def.match(bin, args)` for each `AGENT_DEFS` entry. Matched processes become agent cards. Deduplication groups by `agentId:tty` and keeps the root process (parent not in group), summing CPU/MEM across children.

---

## Step 2: Session Parsing — `lib/agentParsers.js`

Implement two functions: **find** the session file and **parse** it into messages.

### Find Function

```javascript
function findYourAgentSessionFile(cwd, pid) {
  // Use cwd and/or pid to locate the session file
  // Return absolute path to the file, or null if not found
  //
  // Common patterns:
  //   Claude: ~/.claude/projects/{encoded-cwd}/{uuid}.jsonl
  //   Codex:  ~/.codex/sessions/{uuid}.jsonl
  //   OpenCode: ~/.local/share/opencode/opencode.db (SQLite)
  //
  // Tip: use pid + process start time to disambiguate
  //   when multiple agents run in the same directory
  return '/path/to/session/file' || null;
}
```

### Parse Function

Return `{ messages, sessionMeta }`:

```javascript
function parseYourAgentSession(filePath) {
  const messages = [];
  // Parse your agent's session format...

  // Each message MUST have:
  messages.push({
    role: 'user' | 'assistant',   // required
    text: 'message content',       // required (can be '')
    tools: [{                      // required (can be [])
      id: 'optional-unique-id',   // used for linking results
      name: 'ToolName',           // displayed as pill
      input: { key: 'value' },    // shown as detail text
      result: 'output string',    // optional: collapsible output
      resultError: 'stderr',      // optional: shown in red
      patch: [{                   // optional: renders as diff view
        oldStart: 10, oldLines: 5,
        newStart: 10, newLines: 8,
        lines: [' context', '+added', '-removed', ' context']
      }]
    }],
    timestamp: 1710000000000,      // epoch ms or null

    // Optional (assistant messages only):
    usage: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheRead: 50000,
      cacheCreation: 10000,
    },
    model: 'model-name-string',
  });

  // Session metadata (optional but enables cost/context tracking):
  const sessionMeta = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheRead: 0,
    totalCacheCreation: 0,
    lastContextTokens: 0,  // latest message's total prompt size
    model: 'model-name',
    costUSD: 0.0,          // estimated cost
  };

  return { messages, sessionMeta };
}
```

**Export** both functions from the module and add them to the `module.exports` at the bottom.

### Tool Detail Text

The frontend extracts a readable detail string from `tool.input` based on tool name. See `toolDetailText()` in `public/js/tabs/agents.js` — it handles Read/Write/Edit (file path), Bash (command), Grep/Glob (pattern), Agent (description). For unknown tool names, it shows the first string value from input. Your agent's tools will work automatically if they use standard names or have string values in input.

---

## Step 3: Backend API Wiring — `routes/agents.js`

### 3a. Message Endpoint

In the `GET /:pid/messages` handler (~line 175), add your agent:

```javascript
} else if (def.id === 'youragent') {
  sessionFile = findYourAgentSessionFile(cwd, pid);
  if (sessionFile) parsed = parseYourAgentSession(sessionFile);
  // If your parser returns plain array instead of { messages, sessionMeta }:
  // parsed = { messages: msgs, sessionMeta: {} };
}
```

### 3b. Launch Command

Add your agent's CLI command to `AGENT_COMMANDS`:

```javascript
const AGENT_COMMANDS = {
  claude: 'claude',
  codex: 'codex',
  // ...
  youragent: 'youragent',  // the shell command to start it
};
```

If your agent supports a skip-permissions flag, add it:

```javascript
const AGENT_SKIP_PERMISSIONS_FLAG = {
  claude: '--dangerously-skip-permissions',
  youragent: '--no-confirm',  // if applicable
};
```

### 3c. Context Endpoint

Add a `getYourAgentContext(cwd)` function that returns an array of sections:

```javascript
function getYourAgentContext(cwd) {
  const home = os.homedir();
  const sections = [];

  // Global settings
  const config = readJsonSafe(path.join(home, '.youragent', 'config.json'));
  if (config) {
    sections.push({
      title: 'Settings',
      scope: 'global',        // 'global' | 'project' | 'mixed'
      icon: 'settings',       // settings | chart | plug | block | doc | brain
      items: [                // key-value pairs
        { label: 'Model', value: config.model || '—' },
        { label: 'Theme', value: config.theme || 'default' },
      ],
    });
  }

  // MCP / Plugin servers
  // sections.push({ title: 'Plugins', scope: 'mixed', icon: 'plug',
  //   servers: [{ name, type, plugin, scope }] });

  // Project instruction file
  if (cwd) {
    const instructions = readTextSafe(path.join(cwd, 'YOURAGENT.md'));
    if (instructions?.trim()) {
      sections.push({ title: 'YOURAGENT.md', scope: 'project', icon: 'doc', content: instructions });
    }
  }

  // Memory entries (if your agent has them)
  // sections.push({ title: 'Memory', scope: 'project', icon: 'brain',
  //   memories: [{ file, name, type, description, body }] });

  return sections;
}
```

Wire it in the `GET /:pid/context` handler:

```javascript
} else if (def.id === 'youragent') {
  sections = getYourAgentContext(cwd);
}
```

### Section Types Reference

| Type | Required Fields | Renders As |
|------|----------------|------------|
| Key-value | `items: [{ label, value }]` | Label/value rows |
| Servers | `servers: [{ name, type, plugin, scope }]` | Server table with scope badges |
| Document | `content: 'markdown text'` | Pre-formatted monospace block |
| Memory | `memories: [{ file, name, type, description?, body }]` | Collapsible entries with type badge |

All sections need: `title`, `scope` ('global'/'project'/'mixed'), `icon`.

---

## Step 4: Frontend — `public/js/tabs/agents.js`

### 4a. Agent Metadata

Add to `AGENT_META`:

```javascript
export const AGENT_META = {
  // existing...
  youragent: { label: 'Y', color: 'youragent', accent: '#hex-color' },
};
```

- `label` — single character shown in the icon circle
- `color` — CSS class suffix (used for `.agent-icon-youragent`)
- `accent` — hex color for summary pills

### 4b. Agent Full Name

Add to `agentFullName()`:

```javascript
const names = {
  // existing...
  youragent: 'Your Agent',
};
```

### 4c. Context Window Size (optional)

If your agent uses a known model, add to `contextWindowSize()`:

```javascript
if (m.includes('youragent-model')) return 128000;
```

---

## Step 5: HTML & CSS

### 5a. Launch Modal Option

In `public/index.html`, add to the `launch-agent-id` select (~line 401):

```html
<option value="youragent">Your Agent</option>
```

### 5b. Icon Color

In `public/styles.css`, add after the existing `.agent-icon-*` rules (~line 475):

```css
.agent-icon-youragent { background: rgba(YOUR_R, YOUR_G, YOUR_B, 0.15); color: #your-accent; }
```

---

## Known Agent Storage Locations

Reference for implementing session finders:

| Agent | Config | Sessions | Database | Instruction File |
|-------|--------|----------|----------|-----------------|
| **Claude Code** | `~/.claude/settings.json` | `~/.claude/projects/{encoded-cwd}/*.jsonl` | — | `CLAUDE.md` |
| **Codex** | `~/.codex/config.toml` | `~/.codex/sessions/*.jsonl` | `~/.codex/logs_1.sqlite` | `AGENTS.md` |
| **OpenCode** | `~/.config/opencode/` | — | `~/.local/share/opencode/opencode.db` | — |
| **Gemini** | `~/.gemini/settings.json` | `~/.gemini/antigravity/conversations/` | — | `GEMINI.md` |
| **Aider** | `~/.aider.conf.yml` | `.aider.chat.history.md` (in project) | — | `.aider*` |
| **Continue** | `~/.continue/config.json` | `~/.continue/sessions/` | — | `.continuerc.json` |
| **Cursor** | `~/.cursor/` | `~/.cursor/projects/` | — | `.cursorrules` |
| **Windsurf** | `~/.windsurf/` | — | — | `.windsurfrules` |
| **Copilot CLI** | `~/.config/github-copilot/` | — | — | — |
| **Amp** | `~/.amp/` | `~/.amp/sessions/` | — | `AMP.md` |
| **Roo Code** | `~/.roo/` | — | — | `.roorules` |

### Claude JSONL Format

Each line is a JSON object:

```jsonc
// User message
{ "type": "user", "message": { "role": "user", "content": "..." }, "timestamp": "...", "cwd": "...", "sessionId": "..." }

// Assistant message (has usage + model)
{ "type": "assistant", "message": { "role": "assistant", "content": [...], "model": "claude-sonnet-4-6", "usage": { "input_tokens": 3, "output_tokens": 500, "cache_read_input_tokens": 50000, "cache_creation_input_tokens": 10000 } }, "timestamp": "..." }

// Tool result (user message with toolUseResult)
{ "type": "user", "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_xxx", "content": "" }] }, "toolUseResult": { "stdout": "...", "stderr": "...", "content": "...", "structuredPatch": [...], "filePath": "..." }, "sourceToolAssistantUUID": "..." }

// Other types (not parsed for messages): "file-history-snapshot", "progress", "system", "queue-operation", "last-prompt"
```

### Codex JSONL Format

```jsonc
// Session metadata (first line)
{ "type": "session_meta", "payload": { "cwd": "/path" } }

// Messages
{ "type": "response_item", "payload": { "role": "user"|"assistant", "content": [{ "type": "input_text"|"output_text", "text": "..." }, { "type": "function_call", "name": "tool", "arguments": {...} }] }, "timestamp": "..." }
```

---

## Multiplexer Integration

Agents running in **tmux** or **screen** get extra capabilities:

- Live terminal capture (`GET /:pid/terminal`)
- Send input/keys (`POST /:pid/send`)
- Permission prompt detection (`GET /:pid/prompt`)
- Grouped under "Interactive" in the card list

Detection walks the process tree from agent PID upward looking for a tmux/screen ancestor. No agent-specific code needed — this works automatically for any agent.

**Prompt detection** currently parses tmux pane output looking for patterns like "Do you want to proceed?" followed by option lines. If your agent uses similar permission prompts, they'll be detected. To add agent-specific prompt patterns, modify `parsePermissionPrompt()` in `routes/agents.js`.

---

## Utilities Available

### Backend (`routes/agents.js`)
- `readJsonSafe(path)` — parse JSON file, returns null on error
- `readTextSafe(path)` — read text file, returns null on error
- `readTomlSafe(path)` — basic TOML parser (flat keys + sections)
- `shellEscape(str)` — shell-safe quoting for execSync
- `buildProcTable()` — full process tree as `{ pid: { pid, ppid, tty, comm } }`
- `getCwdMap([pids])` — working directories via lsof
- `detectMultiplexer(pid, tty, procs, tmuxMap, screenMap)` — find tmux/screen session

### Frontend (`public/js/utils.js`)
- `escHtml(str)` / `escAttr(str)` — safe escaping for HTML/attributes
- `api(method, path, body)` — fetch wrapper with error handling
- `toast(msg, type)` — notification popup
- `closeModal(id)` — hide modal overlay

### Frontend (`public/js/tabs/agents.js`)
- `tildefy(path)` — replace `/Users/xxx` with `~`
- `formatEtime(etime)` — format `[[DD-]HH:]MM:SS` to human readable
- `simpleMarkdown(text)` — basic markdown → HTML (code blocks, bold, newlines)

---

## Testing a New Agent

1. Start your agent in a terminal: `youragent` in a project directory
2. Verify detection: `curl localhost:3000/api/agents | jq` — should see your agent in the list
3. Verify messages: `curl localhost:3000/api/agents/{pid}/messages | jq` — should see parsed conversation
4. Verify context: `curl localhost:3000/api/agents/{pid}/context | jq` — should see config sections
5. Test in tmux: launch via the UI's "Launch Agent" modal, verify terminal view and send work
6. Check the drawer: click the agent card, verify all 3 tabs render correctly

---

## File Reference

| File | Purpose |
|------|---------|
| `lib/agentParsers.js` | Agent definitions, session finders, message parsers |
| `lib/processTree.js` | Process table, cwd lookup, terminal app detection |
| `routes/agents.js` | All `/api/agents/*` endpoints, multiplexer helpers, context readers |
| `public/js/tabs/agents.js` | Frontend: cards, drawer, messages, terminal, context rendering |
| `public/js/main.js` | Tab wiring, window function exports |
| `public/js/utils.js` | Shared utilities (escaping, API calls, toasts) |
| `public/index.html` | HTML structure (drawer, modals, tabs) |
| `public/styles.css` | All styles (cards, drawer, messages, diffs, context sections) |
