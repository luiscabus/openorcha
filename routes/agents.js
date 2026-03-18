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
      if (!agentTty || agentTty === '??') return null;
      // ps tty column gives "ttys006"; tmux uses "/dev/ttys006"
      const ttyPath = agentTty.startsWith('/')   ? agentTty
                    : agentTty.startsWith('tty') ? `/dev/${agentTty}`
                    : `/dev/tty${agentTty}`;
      const target = tmuxMap[ttyPath];
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
      sessionFile = findCodexSessionFile(cwd, psOut);
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

    res.json({
      agentId: def.id,
      agentName: def.name,
      cwd,
      sessionFile: sessionFile ? path.basename(sessionFile) : null,
      messages: parsed.messages.slice(-150),
      total: parsed.messages.length,
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

    let cmd = AGENT_COMMANDS[agentId];
    if (!cmd) return res.status(400).json({ error: `Unknown agent: ${agentId}` });
    if (!cwd || !cwd.trim()) return res.status(400).json({ error: 'Working directory is required' });

    cwd = cwd.trim().replace(/^~(?=\/|$)/, os.homedir());
    if (!fs.existsSync(cwd)) return res.status(400).json({ error: `Directory does not exist: ${cwd}` });

    // Auto-generate session name if not provided
    if (!sessionName || !sessionName.trim()) {
      sessionName = `${agentId}-${path.basename(cwd)}`;
    }
    sessionName = sessionName.trim().replace(/[^a-zA-Z0-9_.\-]/g, '-');

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

    // Use a login shell so the user's PATH (~/.zshrc, nvm, homebrew, etc.) is sourced
    const userShell = process.env.SHELL || '/bin/zsh';

    // Create tmux session (or new window if session already exists)
    try {
      execSync(`tmux new-session -d -s ${shellEscape(sessionName)} -c ${shellEscape(cwd)} ${shellEscape(userShell)} -l`, { timeout: 5000 });
    } catch {
      // Session name taken — add a new window instead
      execSync(`tmux new-window -t ${shellEscape(sessionName)} -c ${shellEscape(cwd)} ${shellEscape(userShell)} -l`, { timeout: 5000 });
    }
    // Small wait for the login shell to finish initializing before sending the command
    execSync('sleep 0.5');
    execSync(`tmux send-keys -t ${shellEscape(sessionName)} ${shellEscape(cmd)} Enter`, { timeout: 5000 });

    res.json({ ok: true, sessionName });
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

  // Find the "Do you want to proceed?" (or similar) trigger line
  let triggerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/do you want to|allow this|proceed\?/i.test(lines[i])) {
      triggerIdx = i;
      break;
    }
  }
  if (triggerIdx === -1) return null;

  // Collect context: strip box-drawing chars from lines above trigger
  const contextLines = [];
  for (let i = Math.max(0, triggerIdx - 15); i < triggerIdx; i++) {
    const l = lines[i].replace(/[╭╮╰╯│─]/g, '').trim();
    if (l) contextLines.push(l);
  }

  // Parse options that follow the trigger
  const options = [];
  let selectedIdx = 0;
  let isNumbered = false;

  for (let i = triggerIdx + 1; i < Math.min(lines.length, triggerIdx + 12); i++) {
    const line = lines[i];
    // Arrow-key style: ❯ selected option
    const selectedArrow = line.match(/[❯>]\s+(.+)/);
    // Arrow-key style: unselected option (2+ leading spaces, no ❯)
    const unselectedArrow = line.match(/^ {2,}([A-Za-z].+)/);
    // Numbered style: 1. option
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.+)/);

    if (numbered) {
      isNumbered = true;
      options.push({ label: numbered[2].trim(), key: numbered[1] });
    } else if (selectedArrow) {
      selectedIdx = options.length;
      options.push({ label: selectedArrow[1].trim(), key: null });
    } else if (unselectedArrow && options.length > 0 && !isNumbered) {
      options.push({ label: unselectedArrow[1].trim(), key: null });
    } else if (line.trim() === '' && options.length > 0) {
      break;
    }
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
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

    const { pid } = req.params;
    const procs = buildProcTable();
    if (!procs[pid]) return res.status(404).json({ error: 'Process not found' });

    const tty = procs[pid]?.tty;
    const mux = detectMultiplexer(pid, tty, procs, buildTmuxPaneMap(), buildScreenMap());
    if (!mux) return res.status(400).json({ error: 'Agent is not running inside tmux or screen — sending not supported' });

    const { noEnter } = req.body;
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

router.delete('/:pid', (req, res) => {
  try {
    const pid = parseInt(req.params.pid, 10);
    if (!pid || pid <= 1) return res.status(400).json({ error: 'Invalid PID' });
    execSync(`kill ${pid}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
