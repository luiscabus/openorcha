const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const { AGENT_DEFS, findClaudeSessionFile, parseClaudeSession, findCodexSessionFile, parseCodexSession, parseOpenCodeSession, listClaudeSessions, listCodexSessions, listAllRecentSessions } = require('../lib/agentParsers');
const { buildProcTable, findAncestorApp, getCwdMap } = require('../lib/processTree');

const router = express.Router();

// ─── Multiplexer helpers ──────────────────────────────────────────────────────

function shellEscape(str) {
  return "'" + String(str).replace(/'/g, "'\\''") + "'";
}

function normalizeTtyPath(agentTty) {
  if (!agentTty || agentTty === '??') return null;
  const tty = String(agentTty).trim();
  if (!tty) return null;
  if (tty.startsWith('/dev/')) return tty;
  if (tty.startsWith('pts/')) return `/dev/${tty}`;
  if (tty.startsWith('tty')) return `/dev/${tty}`;
  if (/^\d+$/.test(tty)) return `/dev/pts/${tty}`;
  return `/dev/${tty}`;
}

function findTmuxTarget(agentTty, tmuxMap) {
  const ttyPath = normalizeTtyPath(agentTty);
  if (!ttyPath) return null;
  if (tmuxMap[ttyPath]) return tmuxMap[ttyPath];

  const normalized = ttyPath.replace(/^\/dev\//, '');
  for (const [paneTty, target] of Object.entries(tmuxMap)) {
    if (paneTty.replace(/^\/dev\//, '') === normalized) return target;
  }
  return null;
}

function resolveUserShell() {
  const candidates = [];
  if (process.env.SHELL) candidates.push(process.env.SHELL);
  candidates.push('/bin/bash', '/bin/sh', '/bin/zsh');

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (candidate.startsWith('/') && fs.existsSync(candidate)) return candidate;
    } catch {}
  }

  for (const name of ['bash', 'sh', 'zsh']) {
    try {
      const found = execSync(`command -v ${name} 2>/dev/null`, { encoding: 'utf8', timeout: 1000 }).trim();
      if (found) return found;
    } catch {}
  }

  return '/bin/sh';
}

function buildTmuxPaneMap() {
  try {
    const out = execSync('tmux list-panes -a -F "#{pane_tty} #{session_name}:#{window_index}.#{pane_index}" 2>/dev/null', { encoding: 'utf8', timeout: 2000 });
    const map = {};
    for (const line of out.trim().split('\n')) {
      const sp = line.indexOf(' ');
      if (sp >= 0) map[line.slice(0, sp)] = line.slice(sp + 1).trim();
    }
    return map;
  } catch { return {}; }
}

function buildScreenMap() {
  try {
    const out = execSync('screen -ls 2>/dev/null', { encoding: 'utf8', timeout: 2000 });
    const map = {};
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\.([\w.-]+)/);
      if (m) map[m[1]] = `${m[1]}.${m[2]}`;
    }
    return map;
  } catch { return {}; }
}

// Walk the process tree upward from agentPid looking for a tmux or screen ancestor.
function detectMultiplexer(agentPid, agentTty, procs, tmuxMap, screenMap) {
  let p = procs[procs[agentPid]?.ppid];
  let depth = 0;
  while (p && depth < 20) {
    const comm = path.basename(p.comm || '');
    if (comm === 'tmux' || comm.startsWith('tmux:')) {
      const target = findTmuxTarget(agentTty, tmuxMap);
      return target ? { type: 'tmux', target } : null;
    }
    if (comm === 'screen') {
      const session = screenMap[p.pid];
      return session ? { type: 'screen', session } : null;
    }
    p = procs[p.ppid];
    depth++;
  }
  return null;
}

// ─── Agent status inference ──────────────────────────────────────────────────

// Infer whether an agent is idle, thinking, or waiting for a permission prompt.
// Uses CPU usage and terminal output heuristics.
function inferAgentStatus(agent, procs, tmuxMap, screenMap) {
  // Check for permission prompt first (highest priority)
  if (agent.multiplexer?.type === 'tmux') {
    try {
      const text = execSync(`tmux capture-pane -t ${shellEscape(agent.multiplexer.target)} -p -S -30 2>/dev/null`, { encoding: 'utf8', timeout: 2000 });
      if (parsePermissionPrompt(text)) return 'waiting_input';
      // Check if the agent's input prompt is visible (last non-empty line is ❯ or >)
      const lines = text.split('\n').filter(l => l.trim());
      const lastLine = lines[lines.length - 1]?.trim() || '';
      if (/^[❯>]\s*$/.test(lastLine)) return 'idle';
    } catch {}
  }
  // CPU-based heuristic: if agent is using significant CPU, it's thinking
  if (agent.cpu > 2) return 'thinking';
  return 'idle';
}

// Debug: show all processes that nearly-match agent names (without strict AGENT_DEF filtering)
router.get('/debug', (req, res) => {
  try {
    const keywords = Object.values(AGENT_COMMANDS).join('|');
    const out = execSync(`ps -eo pid,tty,args 2>/dev/null | grep -iE '${keywords}' | grep -v grep`, { encoding: 'utf8' });
    res.json({ lines: out.trim().split('\n') });
  } catch {
    res.json({ lines: [] });
  }
});

router.get('/', (req, res) => {
  try {
    const out = execSync('ps -eo pid,pcpu,pmem,tty,etime,args 2>/dev/null', { encoding: 'utf8' });
    const procs = buildProcTable();
    const matched = [];

    for (const line of out.trim().split('\n').slice(1)) {
      const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(.*)/);
      if (!m) continue;
      const [, pid, cpu, mem, tty, etime, args] = m;
      const bin = path.basename(args.split(/\s+/)[0]);
      const def = AGENT_DEFS.find(d => d.match(bin, args));
      if (!def) continue;
      matched.push({ pid, cpu, mem, tty, etime, args, bin, def });
    }

    const cwdMap = getCwdMap(matched.map(m => m.pid));

    const raw = matched.map(({ pid, cpu, mem, tty, etime, args, bin, def }) => {
      const proc = procs[pid];
      let terminalApp = null;
      if (proc && proc.tty !== '??') {
        terminalApp = findAncestorApp(proc.ppid, procs) || null;
      }
      const cwd = cwdMap[pid] || null;
      const project = cwd ? path.basename(cwd) : null;

      return {
        agentId: def.id,
        agentName: def.name,
        pid,
        cpu: parseFloat(cpu),
        mem: parseFloat(mem),
        tty: tty === '??' ? null : tty,
        etime,
        cwd,
        project,
        terminalApp,
        args,
      };
    });

    // Deduplicate: each agent session (tty+agentId) may spawn multiple processes.
    // Group them and keep only the root (parent not in the same group).
    const groups = {};
    for (const a of raw) {
      const key = `${a.agentId}:${a.tty || a.pid}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(a);
    }

    const agents = [];
    for (const group of Object.values(groups)) {
      if (group.length === 1) {
        agents.push(group[0]);
      } else {
        const pids = new Set(group.map(a => a.pid));
        // Root = the one whose parent PID is not in this group
        const root = group.find(a => !pids.has(procs[a.pid]?.ppid)) || group[0];
        // Sum CPU/MEM across all processes in the group
        root.cpu = group.reduce((s, a) => s + a.cpu, 0);
        root.mem = group.reduce((s, a) => s + a.mem, 0);
        agents.push(root);
      }
    }

    agents.sort((a, b) => a.agentId.localeCompare(b.agentId) || (a.cwd || '').localeCompare(b.cwd || ''));

    // Attach multiplexer info (tmux/screen) for each agent
    const tmuxMap = buildTmuxPaneMap();
    const screenMap = buildScreenMap();
    for (const a of agents) {
      a.multiplexer = detectMultiplexer(a.pid, a.tty, procs, tmuxMap, screenMap);
      a.status = inferAgentStatus(a, procs, tmuxMap, screenMap);
    }

    res.json({ agents });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:pid/messages', (req, res) => {
  try {
    const { pid } = req.params;
    const psOut = execSync(`ps -p ${pid} -o args= 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (!psOut) return res.status(404).json({ error: 'Process not found' });

    const bin = path.basename(psOut.split(/\s+/)[0]);
    const def = AGENT_DEFS.find(d => d.match(bin, psOut));
    if (!def) return res.status(400).json({ error: 'Not a recognized agent' });

    const cwdMap = getCwdMap([pid]);
    const cwd = cwdMap[pid];
    if (!cwd) return res.json({ messages: [], cwd: null, note: 'Could not determine working directory' });

    let parsed = null;
    let sessionFile = null;

    if (def.id === 'claude') {
      sessionFile = findClaudeSessionFile(cwd, pid, psOut);
      if (sessionFile) parsed = parseClaudeSession(sessionFile);
    } else if (def.id === 'codex') {
      sessionFile = findCodexSessionFile(cwd, pid, psOut);
      if (sessionFile) {
        const msgs = parseCodexSession(sessionFile);
        parsed = { messages: msgs, sessionMeta: {} };
      }
    } else if (def.id === 'opencode') {
      const msgs = parseOpenCodeSession(cwd);
      parsed = msgs !== null ? { messages: msgs, sessionMeta: {} } : null;
    }

    if (parsed === null) {
      return res.json({ messages: [], cwd, note: 'No session data found' });
    }

    // Get process info for session metadata
    let cpu = null, mem = null, etime = null;
    try {
      const info = execSync(`ps -p ${pid} -o pcpu=,pmem=,etime= 2>/dev/null`, { encoding: 'utf8' }).trim();
      const m = info.match(/^\s*([\d.]+)\s+([\d.]+)\s+(\S+)/);
      if (m) { cpu = parseFloat(m[1]); mem = parseFloat(m[2]); etime = m[3]; }
    } catch {}

    // If the last message is from the user, the agent is working on a response
    const lastMsg = parsed.messages[parsed.messages.length - 1];
    const isWorking = lastMsg?.role === 'user';

    res.json({
      agentId: def.id,
      agentName: def.name,
      cwd,
      sessionFile: sessionFile ? path.basename(sessionFile) : null,
      messages: parsed.messages.slice(-150),
      total: parsed.messages.length,
      isWorking,
      sessionMeta: {
        ...parsed.sessionMeta,
        pid,
        cpu,
        mem,
        etime,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const AGENT_COMMANDS = {
  claude:   'claude',
  codex:    'codex',
  gemini:   'gemini',
  opencode: 'opencode',
  aider:    'aider',
};

const AGENT_SKIP_PERMISSIONS_FLAG = {
  claude: '--dangerously-skip-permissions',
};

// ─── List previous sessions for resume ────────────────────────────────────────

const AGENT_RESUME_FLAG = {
  claude: (sessionId) => `--resume ${sessionId}`,
  codex:  (sessionId) => `resume ${sessionId}`,
};

router.get('/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const sessions = listAllRecentSessions(Math.min(limit, 100));
    res.json({ sessions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/sessions', (req, res) => {
  try {
    let { agentId, cwd } = req.query;
    if (!agentId || !cwd) return res.status(400).json({ error: 'agentId and cwd are required' });
    cwd = cwd.trim().replace(/^~(?=\/|$)/, os.homedir());

    let sessions = [];
    if (agentId === 'claude') sessions = listClaudeSessions(cwd);
    else if (agentId === 'codex') sessions = listCodexSessions(cwd);

    res.json({ sessions, supportsResume: !!AGENT_RESUME_FLAG[agentId] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Agent Presets ────────────────────────────────────────────────────────────

const PRESETS_FILE = path.join(__dirname, '..', 'data', 'agent-presets.json');

function loadPresets() {
  return readJsonSafe(PRESETS_FILE) || [];
}

function savePresets(presets) {
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2));
}

router.get('/presets', (req, res) => {
  res.json({ presets: loadPresets() });
});

router.post('/presets', (req, res) => {
  try {
    const { name, agent, icon, color, description, flags } = req.body;
    if (!name || !agent) return res.status(400).json({ error: 'name and agent are required' });
    const presets = loadPresets();
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (presets.find(p => p.id === id)) return res.status(400).json({ error: `Preset "${id}" already exists` });
    const preset = { id, name, agent, icon: icon || name[0].toUpperCase(), color: color || '#818cf8', description: description || '', flags: flags || '' };
    presets.push(preset);
    savePresets(presets);
    res.json({ preset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/presets/:id', (req, res) => {
  try {
    const presets = loadPresets();
    const idx = presets.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Preset not found' });
    const { name, agent, icon, color, description, flags } = req.body;
    if (name) presets[idx].name = name;
    if (agent) presets[idx].agent = agent;
    if (icon !== undefined) presets[idx].icon = icon;
    if (color !== undefined) presets[idx].color = color;
    if (description !== undefined) presets[idx].description = description;
    if (flags !== undefined) presets[idx].flags = flags;
    savePresets(presets);
    res.json({ preset: presets[idx] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/presets/:id', (req, res) => {
  try {
    const presets = loadPresets();
    const idx = presets.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Preset not found' });
    presets.splice(idx, 1);
    savePresets(presets);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/launch', (req, res) => {
  try {
    let { agentId, cwd, sessionName, skipPermissions, resumeSessionId, presetId } = req.body;

    // If launching from a preset, resolve the agent and extra flags
    let presetFlags = '';
    if (presetId) {
      const preset = loadPresets().find(p => p.id === presetId);
      if (preset) {
        agentId = agentId || preset.agent;
        presetFlags = preset.flags || '';
        if (!sessionName) sessionName = `${preset.id}-${path.basename(cwd || '')}`;
      }
    }

    const isTerminal = agentId === 'terminal';
    let cmd = isTerminal ? null : AGENT_COMMANDS[agentId];
    if (!isTerminal && !cmd) return res.status(400).json({ error: `Unknown agent: ${agentId}` });
    if (!cwd || !cwd.trim()) cwd = os.homedir();

    cwd = cwd.trim().replace(/^~(?=\/|$)/, os.homedir());
    if (!fs.existsSync(cwd)) return res.status(400).json({ error: `Directory does not exist: ${cwd}` });

    // Auto-generate session name if not provided
    if (!sessionName || !sessionName.trim()) {
      sessionName = `${agentId}-${path.basename(cwd)}`;
    }
    sessionName = sessionName.trim().replace(/[^a-zA-Z0-9_.\-]/g, '-');

    if (!isTerminal) {
      if (skipPermissions && AGENT_SKIP_PERMISSIONS_FLAG[agentId]) {
        cmd = `${cmd} ${AGENT_SKIP_PERMISSIONS_FLAG[agentId]}`;
      }

      // Append resume flag if resuming a previous session
      if (resumeSessionId && AGENT_RESUME_FLAG[agentId]) {
        cmd = `${cmd} ${AGENT_RESUME_FLAG[agentId](resumeSessionId)}`;
      }

      // Append preset flags
      if (presetFlags) {
        cmd = `${cmd} ${presetFlags}`;
      }
    }

    // Use a login shell so the user's PATH (~/.zshrc, nvm, homebrew, etc.) is sourced
    const userShell = resolveUserShell();

    // Create tmux session (or new window if session already exists)
    try {
      execSync(`tmux new-session -d -s ${shellEscape(sessionName)} -c ${shellEscape(cwd)} ${shellEscape(userShell)} -l`, { timeout: 5000 });
    } catch {
      // Session name taken — add a new window instead
      execSync(`tmux new-window -t ${shellEscape(sessionName)} -c ${shellEscape(cwd)} ${shellEscape(userShell)} -l`, { timeout: 5000 });
    }
    // For terminal-only sessions, just leave the shell open; otherwise send the agent command
    if (!isTerminal) {
      // Wait for shell prompt to be ready (handles oh-my-zsh updates, slow init, etc.)
      const maxWait = 10000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        execSync('sleep 0.5');
        try {
          const pane = execSync(`tmux capture-pane -t ${shellEscape(sessionName)} -p 2>/dev/null`, { encoding: 'utf8', timeout: 2000 });
          const lines = pane.split('\n').filter(l => l.trim());
          const last = lines[lines.length - 1]?.trim() || '';
          // Shell prompt indicators: ends with $, %, >, ❯, ➜, or #
          if (/[$%>❯➜#]\s*$/.test(last)) break;
        } catch {}
      }
      execSync(`tmux send-keys -t ${shellEscape(sessionName)} ${shellEscape(cmd)} Enter`, { timeout: 5000 });
    }

    res.json({ ok: true, sessionName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Tmux session terminal (no PID needed) ──────────────────────────────────

router.get('/tmux-terminal/:session', (req, res) => {
  try {
    const session = req.params.session;
    const content = execSync(`tmux capture-pane -t ${shellEscape(session)} -p -S -200 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/tmux-terminal/:session/send', (req, res) => {
  try {
    const session = req.params.session;
    const { message, noEnter } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    if (noEnter) {
      execSync(`tmux send-keys -t ${shellEscape(session)} ${shellEscape(message)}`, { timeout: 3000 });
    } else {
      execSync(`tmux set-buffer -- ${shellEscape(message)}`, { timeout: 3000 });
      execSync(`tmux paste-buffer -t ${shellEscape(session)} -d`, { timeout: 3000 });
      execSync('sleep 0.15');
      execSync(`tmux send-keys -t ${shellEscape(session)} Enter`, { timeout: 3000 });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Agent Context / Config endpoint ─────────────────────────────────────────

function readJsonSafe(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function readTextSafe(fp) {
  try { return fs.readFileSync(fp, 'utf8'); } catch { return null; }
}

function readTomlSafe(fp) {
  try {
    const text = fs.readFileSync(fp, 'utf8');
    // Simple TOML parser for flat + section keys
    const result = {};
    let section = null;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const secMatch = trimmed.match(/^\[(.+)\]$/);
      if (secMatch) { section = secMatch[1]; result[section] = result[section] || {}; continue; }
      const kvMatch = trimmed.match(/^([\w.-]+)\s*=\s*"?(.*?)"?\s*$/);
      if (kvMatch) {
        const target = section ? (result[section] = result[section] || {}) : result;
        target[kvMatch[1]] = kvMatch[2];
      }
    }
    return result;
  } catch { return null; }
}

function getClaudeContext(cwd) {
  const home = os.homedir();
  const sections = [];

  // Global settings
  const settings = readJsonSafe(path.join(home, '.claude', 'settings.json'));
  if (settings) {
    sections.push({
      title: 'Settings',
      scope: 'global',
      icon: 'settings',
      items: [
        { label: 'Model', value: settings.model || '—' },
        ...(settings.statusLine ? [{ label: 'Status Line', value: settings.statusLine.command ? 'Custom command' : settings.statusLine.type || 'enabled' }] : []),
      ],
    });
  }

  // Global stats
  const stats = readJsonSafe(path.join(home, '.claude', 'stats-cache.json'));
  if (stats) {
    const models = stats.modelUsage ? Object.keys(stats.modelUsage) : [];
    sections.push({
      title: 'Usage Stats',
      scope: 'global',
      icon: 'chart',
      items: [
        { label: 'Total Sessions', value: String(stats.totalSessions || 0) },
        { label: 'Total Messages', value: String(stats.totalMessages || 0) },
        { label: 'First Session', value: stats.firstSessionDate ? new Date(stats.firstSessionDate).toLocaleDateString() : '—' },
        { label: 'Models Used', value: models.map(m => m.replace('claude-', '').replace(/-\d{8}$/, '')).join(', ') || '—' },
      ],
    });
  }

  // Active MCP Servers — actually configured and usable
  const activeServers = [];

  // 1. OAuth-connected servers (claude.ai integrations)
  const mcpAuth = readJsonSafe(path.join(home, '.claude', 'mcp-needs-auth-cache.json'));
  if (mcpAuth) {
    for (const name of Object.keys(mcpAuth)) {
      activeServers.push({ name, type: 'oauth', source: 'claude.ai', scope: 'global' });
    }
  }

  // 2. Project-level .mcp.json (configured for this project)
  if (cwd) {
    const projectMcp = readJsonSafe(path.join(cwd, '.mcp.json'));
    if (projectMcp) {
      for (const [name, conf] of Object.entries(projectMcp)) {
        activeServers.push({ name, type: conf.type || '—', source: '.mcp.json', scope: 'project' });
      }
    }
  }

  // 3. Global .mcp.json (user-configured globally)
  const globalMcp = readJsonSafe(path.join(home, '.claude', '.mcp.json'));
  if (globalMcp) {
    for (const [name, conf] of Object.entries(globalMcp)) {
      activeServers.push({ name, type: conf.type || '—', source: '~/.claude/.mcp.json', scope: 'global' });
    }
  }

  if (activeServers.length) {
    sections.push({
      title: 'Active MCP Servers',
      scope: activeServers.some(s => s.scope === 'project') ? 'mixed' : 'global',
      icon: 'plug',
      servers: activeServers,
    });
  }

  // Available marketplace plugins (downloaded, not necessarily active)
  const availablePlugins = [];
  const pluginsDir = path.join(home, '.claude', 'plugins', 'marketplaces');
  try {
    const marketplaces = fs.readdirSync(pluginsDir);
    for (const mp of marketplaces) {
      const extDir = path.join(pluginsDir, mp, 'external_plugins');
      if (!fs.existsSync(extDir)) continue;
      for (const plugin of fs.readdirSync(extDir)) {
        const mcpFile = path.join(extDir, plugin, '.mcp.json');
        const pluginMeta = readJsonSafe(path.join(extDir, plugin, '.claude-plugin', 'plugin.json'));
        const mcp = readJsonSafe(mcpFile);
        const isActive = activeServers.some(s => s.name === plugin || s.source === plugin);
        availablePlugins.push({
          name: pluginMeta?.name || plugin,
          description: pluginMeta?.description || '',
          hasMcp: !!mcp,
          active: isActive,
        });
      }
    }
  } catch {}

  // Also check built-in plugins (non-external)
  const builtinDir = path.join(pluginsDir, 'claude-plugins-official', 'plugins');
  try {
    for (const plugin of fs.readdirSync(builtinDir)) {
      const pluginMeta = readJsonSafe(path.join(builtinDir, plugin, '.claude-plugin', 'plugin.json'));
      if (pluginMeta) {
        availablePlugins.push({
          name: pluginMeta.name || plugin,
          description: pluginMeta.description || '',
          hasMcp: false,
          active: false,
          builtin: true,
        });
      }
    }
  } catch {}

  if (availablePlugins.length) {
    sections.push({
      title: 'Marketplace Plugins',
      scope: 'global',
      icon: 'block',
      plugins: availablePlugins,
    });
  }

  // Blocked plugins
  const blocklist = readJsonSafe(path.join(home, '.claude', 'plugins', 'blocklist.json'));
  if (blocklist && Array.isArray(blocklist) && blocklist.length) {
    sections.push({
      title: 'Blocked Plugins',
      scope: 'global',
      icon: 'block',
      items: blocklist.map(b => ({
        label: typeof b === 'string' ? b : b.name || b.id || JSON.stringify(b),
        value: typeof b === 'object' && b.reason ? b.reason : '',
      })),
    });
  }

  // CLAUDE.md (project)
  if (cwd) {
    const claudeMd = readTextSafe(path.join(cwd, 'CLAUDE.md'));
    if (claudeMd) {
      sections.push({ title: 'CLAUDE.md', scope: 'project', icon: 'doc', content: claudeMd });
    }
  }

  // Memory (project)
  if (cwd) {
    const encoded = cwd.replace(/\//g, '-');
    const memDir = path.join(home, '.claude', 'projects', encoded, 'memory');
    const memoryMd = readTextSafe(path.join(home, '.claude', 'projects', encoded, 'MEMORY.md'));
    const memories = [];
    try {
      for (const f of fs.readdirSync(memDir)) {
        if (!f.endsWith('.md')) continue;
        const content = readTextSafe(path.join(memDir, f));
        if (content) {
          // Parse frontmatter
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)/);
          if (fmMatch) {
            const meta = {};
            for (const line of fmMatch[1].split('\n')) {
              const kv = line.match(/^(\w+):\s*(.+)/);
              if (kv) meta[kv[1]] = kv[2];
            }
            memories.push({ file: f, name: meta.name || f, type: meta.type || '—', description: meta.description || '', body: fmMatch[2].trim() });
          } else {
            memories.push({ file: f, name: f, type: '—', body: content.trim() });
          }
        }
      }
    } catch {}
    if (memories.length || memoryMd) {
      sections.push({ title: 'Memory', scope: 'project', icon: 'brain', memories, index: memoryMd || null });
    }
  }

  return sections;
}

function getCodexContext(cwd) {
  const home = os.homedir();
  const sections = [];
  const config = readTomlSafe(path.join(home, '.codex', 'config.toml'));
  if (config) {
    const items = [];
    if (config.personality) items.push({ label: 'Personality', value: config.personality });
    if (config.model) items.push({ label: 'Model', value: config.model });
    if (config.model_reasoning_effort) items.push({ label: 'Reasoning Effort', value: config.model_reasoning_effort });

    // Trusted projects
    const trusted = Object.entries(config).filter(([k]) => k.startsWith('projects.'));
    if (trusted.length) {
      items.push({ label: 'Trusted Projects', value: trusted.map(([k]) => path.basename(k.replace('projects.', '').replace(/"/g, ''))).join(', ') });
    }
    sections.push({ title: 'Settings', scope: 'global', icon: 'settings', items });
  }

  // AGENTS.md
  if (cwd) {
    const agentsMd = readTextSafe(path.join(cwd, 'AGENTS.md'));
    if (agentsMd && agentsMd.trim()) {
      sections.push({ title: 'AGENTS.md', scope: 'project', icon: 'doc', content: agentsMd });
    }
  }

  return sections;
}

function getGeminiContext(cwd) {
  const home = os.homedir();
  const sections = [];
  const settings = readJsonSafe(path.join(home, '.gemini', 'settings.json'));
  if (settings) {
    const items = [];
    if (settings.security?.auth?.selectedType) items.push({ label: 'Auth', value: settings.security.auth.selectedType });
    if (settings.general?.previewFeatures != null) items.push({ label: 'Preview Features', value: String(settings.general.previewFeatures) });
    sections.push({ title: 'Settings', scope: 'global', icon: 'settings', items });
  }

  // GEMINI.md
  const geminiMd = readTextSafe(path.join(home, '.gemini', 'GEMINI.md'));
  if (geminiMd && geminiMd.trim()) {
    sections.push({ title: 'GEMINI.md', scope: 'global', icon: 'doc', content: geminiMd });
  }

  if (cwd) {
    const projectGemini = readTextSafe(path.join(cwd, 'GEMINI.md'));
    if (projectGemini && projectGemini.trim()) {
      sections.push({ title: 'GEMINI.md', scope: 'project', icon: 'doc', content: projectGemini });
    }
  }

  return sections;
}

router.get('/:pid/context', (req, res) => {
  try {
    const { pid } = req.params;
    const psOut = execSync(`ps -p ${pid} -o args= 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (!psOut) return res.status(404).json({ error: 'Process not found' });

    const bin = path.basename(psOut.split(/\s+/)[0]);
    const def = AGENT_DEFS.find(d => d.match(bin, psOut));
    if (!def) return res.status(400).json({ error: 'Not a recognized agent' });

    const cwdMap = getCwdMap([pid]);
    const cwd = cwdMap[pid] || null;

    let sections = [];
    if (def.id === 'claude') sections = getClaudeContext(cwd);
    else if (def.id === 'codex') sections = getCodexContext(cwd);
    else if (def.id === 'gemini') sections = getGeminiContext(cwd);
    // Other agents: minimal info
    else {
      if (cwd) {
        // Check for generic instruction files
        for (const name of ['AGENTS.md', '.agents.md', 'INSTRUCTIONS.md']) {
          const content = readTextSafe(path.join(cwd, name));
          if (content && content.trim()) {
            sections.push({ title: name, scope: 'project', icon: 'doc', content });
          }
        }
      }
    }

    res.json({ agentId: def.id, agentName: def.name, cwd, sections });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Parse a tmux pane capture looking for a Claude Code permission prompt
function parsePermissionPrompt(text) {
  const lines = text.split('\n');

  // Find the question/trigger line — prefer the question over a trailing confirm hint
  let triggerIdx = -1;
  let confirmIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/press enter to confirm|press .* to cancel/i.test(lines[i])) {
      if (confirmIdx === -1) confirmIdx = i;
      continue;
    }
    if (/do you want to|would you like to|allow this|proceed\?/i.test(lines[i])) {
      triggerIdx = i;
      break;
    }
  }
  // If we only found a confirm hint, use that (scan backwards for options)
  if (triggerIdx === -1 && confirmIdx !== -1) triggerIdx = confirmIdx;
  if (triggerIdx === -1) return null;

  // Collect context: strip box-drawing chars from lines above trigger
  const contextLines = [];
  for (let i = Math.max(0, triggerIdx - 15); i < triggerIdx; i++) {
    const l = lines[i].replace(/[╭╮╰╯│─]/g, '').trim();
    if (l) contextLines.push(l);
  }

  // Parse options from lines around the trigger
  const options = [];
  let selectedIdx = 0;
  let isNumbered = false;

  function scanLines(start, end, step) {
    for (let i = start; step > 0 ? i < end : i >= end; i += step) {
      const line = lines[i];
      const numbered = line.match(/^\s*[›»]?\s*(\d+)[.)]\s+(.+)/);
      const selectedArrow = line.match(/[❯>]\s+(.+)/);
      const unselectedArrow = line.match(/^ {2,}([A-Za-z].+)/);

      if (numbered) {
        isNumbered = true;
        if (/^\s*[›»]/.test(line)) selectedIdx = options.length;
        options.push({ label: numbered[2].trim(), key: numbered[1] });
      } else if (selectedArrow && !isNumbered) {
        selectedIdx = options.length;
        options.push({ label: selectedArrow[1].trim(), key: null });
      } else if (unselectedArrow && options.length > 0 && !isNumbered) {
        options.push({ label: unselectedArrow[1].trim(), key: null });
      } else if (line.trim() === '' && options.length > 0) {
        break;
      }
    }
  }

  // Scan forward from trigger
  scanLines(triggerIdx + 1, Math.min(lines.length, triggerIdx + 12), 1);

  // If no options found forward, scan backward (confirm line at bottom, options above)
  if (!options.length) {
    scanLines(triggerIdx - 1, Math.max(0, triggerIdx - 12), -1);
    options.reverse(); // restore top-to-bottom order
    // Recalculate selectedIdx after reverse
    const selLabel = options[options.length - 1 - selectedIdx]?.label;
    if (selLabel) selectedIdx = options.findIndex(o => o.label === selLabel);
  }

  if (!options.length) return null;

  return {
    context: contextLines.slice(-5).join('\n'), // last 5 context lines
    question: lines[triggerIdx].trim(),
    options,
    selectedIdx,
    isNumbered,
  };
}

router.get('/:pid/prompt', (req, res) => {
  try {
    const { pid } = req.params;
    const procs = buildProcTable();
    if (!procs[pid]) return res.status(404).json({ error: 'Process not found' });

    const tty = procs[pid]?.tty;
    const mux = detectMultiplexer(pid, tty, procs, buildTmuxPaneMap(), buildScreenMap());
    if (!mux || mux.type !== 'tmux') return res.json({ hasPrompt: false });

    const text = execSync(`tmux capture-pane -t ${shellEscape(mux.target)} -p -S -60 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
    const prompt = parsePermissionPrompt(text);
    if (!prompt) return res.json({ hasPrompt: false });

    res.json({ hasPrompt: true, ...prompt });
  } catch (e) {
    res.json({ hasPrompt: false });
  }
});

router.get('/:pid/terminal', (req, res) => {
  try {
    const { pid } = req.params;
    const procs = buildProcTable();
    if (!procs[pid]) return res.status(404).json({ error: 'Process not found' });

    const tty = procs[pid]?.tty;
    const mux = detectMultiplexer(pid, tty, procs, buildTmuxPaneMap(), buildScreenMap());
    if (!mux) return res.status(400).json({ error: 'Not in tmux or screen' });

    let content = '';
    if (mux.type === 'tmux') {
      content = execSync(`tmux capture-pane -t ${shellEscape(mux.target)} -p -S -200 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
    } else if (mux.type === 'screen') {
      const tmpFile = `/tmp/screen-dump-${pid}`;
      execSync(`screen -S ${shellEscape(mux.session)} -X hardcopy ${shellEscape(tmpFile)}`, { timeout: 3000 });
      content = require('fs').readFileSync(tmpFile, 'utf8');
      require('fs').unlinkSync(tmpFile);
    }

    res.json({ content, muxType: mux.type });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:pid/send', (req, res) => {
  try {
    // Support both JSON { message: "..." } and plain text body
    const contentType = req.headers['content-type'] || '';
    let message, noEnter;
    if (contentType.includes('text/plain')) {
      message = typeof req.body === 'string' ? req.body : String(req.body);
      noEnter = false;
    } else {
      ({ message, noEnter } = req.body);
    }
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

    const { pid } = req.params;
    const procs = buildProcTable();
    if (!procs[pid]) return res.status(404).json({ error: 'Process not found' });

    const tty = procs[pid]?.tty;
    const mux = detectMultiplexer(pid, tty, procs, buildTmuxPaneMap(), buildScreenMap());
    if (!mux) return res.status(400).json({ error: 'Agent is not running inside tmux or screen — sending not supported' });
    if (mux.type === 'tmux') {
      if (noEnter) {
        execSync(`tmux send-keys -t ${shellEscape(mux.target)} ${shellEscape(message)}`, { timeout: 3000 });
      } else {
        // Pasting text is more reliable for CLIs like Codex than send-keys text + Enter.
        execSync(`tmux set-buffer -- ${shellEscape(message)}`, { timeout: 3000 });
        execSync(`tmux paste-buffer -t ${shellEscape(mux.target)} -d`, { timeout: 3000 });
        // Small delay so the pasted text is fully processed before Enter
        execSync('sleep 0.15');
        execSync(`tmux send-keys -t ${shellEscape(mux.target)} Enter`, { timeout: 3000 });
      }
    } else if (mux.type === 'screen') {
      const payload = noEnter ? message : message + '\n';
      execSync(`screen -S ${shellEscape(mux.session)} -X stuff ${shellEscape(payload)}`, { timeout: 3000 });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Wait for agent to become idle ───────────────────────────────────────────
// Long-polls until the agent finishes its current task.
// Query params:
//   timeout  — max wait in ms (default 30000, max 120000)
//   interval — poll interval in ms (default 2000)
// Returns the last few messages once idle, or { timedOut: true } on timeout.

router.get('/:pid/wait', async (req, res) => {
  const { pid } = req.params;
  const timeout = Math.min(parseInt(req.query.timeout) || 30000, 120000);
  const interval = Math.max(parseInt(req.query.interval) || 2000, 500);
  const start = Date.now();

  const checkIdle = () => {
    try {
      // Verify process still exists
      const psOut = execSync(`ps -p ${pid} -o pcpu= 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (!psOut) return { done: true, reason: 'process_exited' };

      const cpu = parseFloat(psOut);
      const procs = buildProcTable();
      const proc = procs[pid];
      if (!proc) return { done: true, reason: 'process_exited' };

      const tty = proc.tty;
      const mux = detectMultiplexer(pid, tty, procs, buildTmuxPaneMap(), buildScreenMap());

      // Check terminal for idle prompt or permission prompt
      if (mux?.type === 'tmux') {
        const text = execSync(`tmux capture-pane -t ${shellEscape(mux.target)} -p -S -30 2>/dev/null`, { encoding: 'utf8', timeout: 2000 });
        if (parsePermissionPrompt(text)) return { done: true, reason: 'waiting_input' };
        const lines = text.split('\n').filter(l => l.trim());
        const lastLine = lines[lines.length - 1]?.trim() || '';
        if (/^[❯>]\s*$/.test(lastLine) && cpu < 2) return { done: true, reason: 'idle' };
      }

      // CPU-based fallback
      if (cpu < 2) return { done: true, reason: 'idle' };

      return { done: false };
    } catch {
      return { done: true, reason: 'error' };
    }
  };

  // Poll loop
  while (Date.now() - start < timeout) {
    const result = checkIdle();
    if (result.done) {
      // Fetch latest messages to return
      try {
        const psOut = execSync(`ps -p ${pid} -o args= 2>/dev/null`, { encoding: 'utf8' }).trim();
        const bin = path.basename(psOut.split(/\s+/)[0]);
        const def = AGENT_DEFS.find(d => d.match(bin, psOut));
        const cwdMap = getCwdMap([pid]);
        const cwd = cwdMap[pid];
        let lastMessages = [];

        if (def?.id === 'claude' && cwd) {
          const sessionFile = findClaudeSessionFile(cwd, pid, psOut);
          if (sessionFile) {
            const parsed = parseClaudeSession(sessionFile);
            lastMessages = parsed.messages.slice(-5);
          }
        }

        return res.json({ status: result.reason, messages: lastMessages, elapsed: Date.now() - start });
      } catch {
        return res.json({ status: result.reason, messages: [], elapsed: Date.now() - start });
      }
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  res.json({ status: 'timeout', messages: [], elapsed: Date.now() - start });
});

router.post('/:pid/relaunch', (req, res) => {
  try {
    const pid = parseInt(req.params.pid, 10);
    if (!pid || pid <= 1) return res.status(400).json({ error: 'Invalid PID' });

    // Gather info before killing
    const psOut = execSync(`ps -p ${pid} -o args= 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (!psOut) return res.status(404).json({ error: 'Process not found' });

    const bin = path.basename(psOut.split(/\s+/)[0]);
    const def = AGENT_DEFS.find(d => d.match(bin, psOut));
    if (!def) return res.status(400).json({ error: 'Not a recognized agent' });

    const cwdMap = getCwdMap([String(pid)]);
    const cwd = cwdMap[String(pid)];
    if (!cwd) return res.status(400).json({ error: 'Could not determine working directory' });

    // Find the session file to resume
    let sessionId = null;
    if (def.id === 'claude') {
      const sessionFile = findClaudeSessionFile(cwd, String(pid), psOut);
      if (sessionFile) sessionId = path.basename(sessionFile, '.jsonl');
    } else if (def.id === 'codex') {
      const sessionFile = findCodexSessionFile(cwd, String(pid), psOut);
      if (sessionFile) {
        const meta = require('./agents').readCodexSessionMeta ? null : null;
        // Extract session ID from codex file metadata
        try {
          const first = fs.readFileSync(sessionFile, 'utf8').split('\n')[0];
          const m = JSON.parse(first);
          if (m.type === 'session_meta' && m.payload?.id) sessionId = m.payload.id;
        } catch {}
        if (!sessionId) sessionId = path.basename(sessionFile, '.jsonl');
      }
    }

    // Reconstruct the command — use the original args but replace/add --resume
    let cmd = psOut;
    // Strip any existing --resume flag (we'll add ours)
    cmd = cmd.replace(/--resume\s+[0-9a-f-]+/i, '').trim();
    // For codex, strip 'resume <id>' subcommand
    cmd = cmd.replace(/\bresume\s+[0-9a-f-]+/i, '').trim();
    // Add resume flag if we found a session
    if (sessionId && AGENT_RESUME_FLAG[def.id]) {
      cmd = `${cmd} ${AGENT_RESUME_FLAG[def.id](sessionId)}`;
    }

    // Get tmux session info
    const procs = buildProcTable();
    const tty = procs[pid]?.tty;
    const mux = tty ? detectMultiplexer(pid, tty, procs, buildTmuxPaneMap(), buildScreenMap()) : null;
    const tmuxSession = mux?.type === 'tmux' ? mux.target?.split(':')[0] : null;

    // Kill the process
    execSync(`kill ${pid}`);
    // Wait for it to die
    try { execSync(`sleep 1`); } catch {}

    // Kill the old tmux session
    if (tmuxSession) {
      try { execSync(`tmux kill-session -t ${shellEscape(tmuxSession)} 2>/dev/null`); } catch {}
    }

    // Relaunch in a new tmux session
    const sessionName = tmuxSession || `${def.id}-${path.basename(cwd)}`;
    const userShell = resolveUserShell();

    try {
      execSync(`tmux new-session -d -s ${shellEscape(sessionName)} -c ${shellEscape(cwd)} ${shellEscape(userShell)} -l`, { timeout: 5000 });
    } catch {
      // Session name taken — add suffix
      const altName = `${sessionName}-${Date.now() % 10000}`;
      execSync(`tmux new-session -d -s ${shellEscape(altName)} -c ${shellEscape(cwd)} ${shellEscape(userShell)} -l`, { timeout: 5000 });
    }
    // Wait for shell prompt before sending command
    const maxWait = 10000;
    const startWait = Date.now();
    while (Date.now() - startWait < maxWait) {
      execSync('sleep 0.5');
      try {
        const pane = execSync(`tmux capture-pane -t ${shellEscape(sessionName)} -p 2>/dev/null`, { encoding: 'utf8', timeout: 2000 });
        const pLines = pane.split('\n').filter(l => l.trim());
        const last = pLines[pLines.length - 1]?.trim() || '';
        if (/[$%>❯➜#]\s*$/.test(last)) break;
      } catch {}
    }
    execSync(`tmux send-keys -t ${shellEscape(sessionName)} ${shellEscape(cmd)} Enter`, { timeout: 5000 });

    res.json({ ok: true, sessionName, cmd, sessionId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:pid', (req, res) => {
  try {
    const pid = parseInt(req.params.pid, 10);
    if (!pid || pid <= 1) return res.status(400).json({ error: 'Invalid PID' });

    // Find the tmux session this process runs in, so we can kill it too
    const procs = buildProcTable();
    const tty = procs[pid]?.tty;
    const mux = tty ? detectMultiplexer(pid, tty, procs, buildTmuxPaneMap(), buildScreenMap()) : null;

    execSync(`kill ${pid}`);

    // Kill the tmux session if the agent was running in one
    if (mux?.type === 'tmux' && mux.session) {
      try { execSync(`tmux kill-session -t ${shellEscape(mux.session)} 2>/dev/null`); } catch {}
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
