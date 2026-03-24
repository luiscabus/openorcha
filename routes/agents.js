const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const { AGENT_DEFS, listAllRecentSessions } = require('../lib/agentParsers');
const { getSessionResolver } = require('../lib/sessionResolvers');
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

function tmuxSessionNameFromMux(mux) {
  if (!mux || mux.type !== 'tmux') return null;
  return mux.target?.split(':')[0] || null;
}

function captureMuxText(mux, pid, startLine = -30) {
  try {
    if (mux?.type === 'tmux') {
      return execSync(`tmux capture-pane -t ${shellEscape(mux.target)} -p -S ${startLine} 2>/dev/null`, { encoding: 'utf8', timeout: 2000 });
    }
    if (mux?.type === 'screen') {
      const tmpFile = `/tmp/agent-orch-screen-${pid}-${Date.now()}`;
      execSync(`screen -S ${shellEscape(mux.session)} -X hardcopy ${shellEscape(tmpFile)}`, { timeout: 3000 });
      const content = fs.readFileSync(tmpFile, 'utf8');
      fs.unlinkSync(tmpFile);
      return content;
    }
  } catch {}
  return '';
}

function captureAgentPaneText(pid, procs = null, tmuxMap = null, screenMap = null, startLine = -80) {
  const procTable = procs || buildProcTable();
  const proc = procTable[String(pid)] || procTable[pid];
  const tty = proc?.tty;
  const mux = tty ? detectMultiplexer(String(pid), tty, procTable, tmuxMap || buildTmuxPaneMap(), screenMap || buildScreenMap()) : null;
  return captureMuxText(mux, pid, startLine);
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function detectCodexTerminalState(text) {
  const lines = stripAnsi(text)
    .split('\n')
    .map(line => line.replace(/\r/g, '').trim())
    .filter(Boolean)
    .slice(-12);

  for (const line of lines.reverse()) {
    const normalized = line
      .toLowerCase()
      .replace(/^status:\s*/, '')
      .replace(/^[|/\\\-⠁-⣿◐◓◑◒●•○·▪▸▹▶▷►>]+\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (/^(thinking|working)(?:\s*(?:\.\.\.|…))?$/.test(normalized)) return 'thinking';
  }

  return null;
}
// ─── Agent status inference ──────────────────────────────────────────────────

// Infer whether an agent is idle, thinking, or waiting for a permission prompt.
// Uses CPU usage and terminal output heuristics.
function inferAgentStatus(agent, procs, tmuxMap, screenMap) {
  if (agent.multiplexer) {
    const text = captureMuxText(agent.multiplexer, agent.pid, -60);
    if (text) {
      if (parsePermissionPrompt(text)) return 'waiting_input';
      if (agent.agentId === 'codex' && detectCodexTerminalState(text) === 'thinking') return 'thinking';
      const lines = text.split('\n').filter(l => l.trim());
      const lastLine = lines[lines.length - 1]?.trim() || '';
      if (/^[❯>]\s*$/.test(lastLine)) return 'idle';
    }
  }
  if (agent.cpu > 2) return 'thinking';
  return 'idle';
}

function findAgentHistorySessionId(agent, paneText = '') {
  if (!agent?.cwd || !agent?.pid) return null;
  const resolver = getSessionResolver(agent.agentId);
  if (!resolver?.resolveLiveSession || !resolver?.getHistorySessionId) return null;
  const resolved = resolver.resolveLiveSession({ cwd: agent.cwd, pid: agent.pid, args: agent.args || '', paneText });
  return resolver.getHistorySessionId(resolved);
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
      const paneText = ['claude', 'codex'].includes(a.agentId) ? captureMuxText(a.multiplexer, a.pid, -80) : '';
      a.historySessionId = findAgentHistorySessionId(a, paneText);
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
    const resolver = getSessionResolver(def.id);
    const paneText = ['claude', 'codex'].includes(def.id) ? captureAgentPaneText(pid) : '';
    const resolved = resolver?.resolveLiveSession
      ? resolver.resolveLiveSession({ cwd, pid, args: psOut, paneText })
      : null;
    if (resolved && resolver?.parseResolved) {
      sessionFile = resolved.sessionFile || null;
      parsed = resolver.parseResolved(resolved);
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
    const resolver = getSessionResolver(agentId);
    if (resolver?.listSessions) sessions = resolver.listSessions(cwd);

    res.json({ sessions, supportsResume: !!AGENT_RESUME_FLAG[agentId] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Agent Presets ────────────────────────────────────────────────────────────

const PRESETS_DIR = path.join(__dirname, '..', 'data', 'agent-presets');
const LEGACY_PRESETS_FILE = path.join(__dirname, '..', 'data', 'agent-presets.json');

function ensurePresetsDir() {
  fs.mkdirSync(PRESETS_DIR, { recursive: true });
}

function slugifyPresetFilename(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'preset';
}

function isValidPresetFilename(filename) {
  return /^[a-z0-9][a-z0-9.-]*$/.test(filename || '');
}

function presetFilePath(filename) {
  return path.join(PRESETS_DIR, `${filename}.json`);
}

function normalizePresetData(preset) {
  const name = String(preset?.name || '').trim();
  const agent = String(preset?.agent || '').trim();
  return {
    name,
    agent,
    icon: preset?.icon || name[0]?.toUpperCase() || '?',
    color: preset?.color || '#818cf8',
    description: preset?.description || '',
    flags: preset?.flags || '',
  };
}

function readPresetFile(filePath) {
  const parsed = readJsonSafe(filePath);
  if (!parsed || typeof parsed !== 'object') return null;
  const preset = normalizePresetData(parsed);
  if (!preset.name || !preset.agent) return null;
  return { filename: path.basename(filePath, '.json'), ...preset };
}

function writePresetFile(filename, preset) {
  ensurePresetsDir();
  const normalized = normalizePresetData(preset);
  fs.writeFileSync(presetFilePath(filename), JSON.stringify(normalized, null, 2));
  return { filename, ...normalized };
}

function migrateLegacyPresets() {
  ensurePresetsDir();
  const hasPresetFiles = fs.readdirSync(PRESETS_DIR).some(f => f.endsWith('.json'));
  if (hasPresetFiles || !fs.existsSync(LEGACY_PRESETS_FILE)) return;

  const legacy = readJsonSafe(LEGACY_PRESETS_FILE);
  if (!Array.isArray(legacy)) return;

  for (const preset of legacy) {
    const filename = slugifyPresetFilename(preset?.name || preset?.id || 'preset');
    writePresetFile(filename, preset);
  }
}

function loadPresets() {
  ensurePresetsDir();
  migrateLegacyPresets();

  return fs.readdirSync(PRESETS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => readPresetFile(path.join(PRESETS_DIR, f)))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name) || a.filename.localeCompare(b.filename));
}

router.get('/presets', (req, res) => {
  res.json({ presets: loadPresets() });
});

router.post('/presets', (req, res) => {
  try {
    const { name, agent, icon, color, description, flags } = req.body;
    if (!name || !agent) return res.status(400).json({ error: 'name and agent are required' });

    const filename = slugifyPresetFilename(name);
    if (loadPresets().find(p => p.filename === filename)) {
      return res.status(400).json({ error: `Preset "${filename}" already exists` });
    }

    const preset = writePresetFile(filename, { name, agent, icon, color, description, flags });
    res.json({ preset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/presets/:filename', (req, res) => {
  try {
    const currentFilename = decodeURIComponent(req.params.filename);
    if (!isValidPresetFilename(currentFilename)) return res.status(400).json({ error: 'Invalid preset filename' });

    const existing = readPresetFile(presetFilePath(currentFilename));
    if (!existing) return res.status(404).json({ error: 'Preset not found' });

    const { name, agent, icon, color, description, flags } = req.body;
    const updated = {
      name: name !== undefined ? name : existing.name,
      agent: agent !== undefined ? agent : existing.agent,
      icon: icon !== undefined ? icon : existing.icon,
      color: color !== undefined ? color : existing.color,
      description: description !== undefined ? description : existing.description,
      flags: flags !== undefined ? flags : existing.flags,
    };

    if (!updated.name || !updated.agent) {
      return res.status(400).json({ error: 'name and agent are required' });
    }

    const nextFilename = slugifyPresetFilename(updated.name);
    if (nextFilename !== currentFilename && fs.existsSync(presetFilePath(nextFilename))) {
      return res.status(400).json({ error: `Preset "${nextFilename}" already exists` });
    }

    const preset = writePresetFile(nextFilename, updated);
    if (nextFilename !== currentFilename && fs.existsSync(presetFilePath(currentFilename))) {
      fs.unlinkSync(presetFilePath(currentFilename));
    }

    res.json({ preset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/presets/:filename', (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    if (!isValidPresetFilename(filename)) return res.status(400).json({ error: 'Invalid preset filename' });
    const filePath = presetFilePath(filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Preset not found' });
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/launch', (req, res) => {
  try {
    let { agentId, cwd, sessionName, skipPermissions, resumeSessionId, presetFile } = req.body;

    // If launching from a preset, resolve the agent and extra flags
    let presetFlags = '';
    if (presetFile) {
      const preset = loadPresets().find(p => p.filename === presetFile);
      if (preset) {
        agentId = agentId || preset.agent;
        presetFlags = preset.flags || '';
        if (!sessionName) sessionName = `${preset.filename}-${path.basename(cwd || '')}`;
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

function runGit(cwd, args) {
  return execSync(`git -C ${shellEscape(cwd)} ${args}`, {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function getGitInfo(cwd) {
  if (!cwd) return { isRepo: false, note: 'No working directory found for this session.' };

  try {
    const root = runGit(cwd, 'rev-parse --show-toplevel');
    const branch = runGit(cwd, 'branch --show-current') || 'HEAD';
    let upstream = '';
    try {
      upstream = runGit(cwd, 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}');
    } catch {}

    let ahead = 0;
    let behind = 0;
    if (upstream) {
      try {
        const counts = runGit(cwd, `rev-list --left-right --count ${shellEscape(`${branch}...${upstream}`)}`);
        const [aheadStr, behindStr] = counts.split(/\s+/);
        ahead = parseInt(aheadStr, 10) || 0;
        behind = parseInt(behindStr, 10) || 0;
      } catch {}
    }

    const statusText = runGit(cwd, 'status --short');
    const files = statusText
      ? statusText.split('\n').filter(Boolean).map(line => ({
          code: line.slice(0, 2).trim() || '??',
          path: line.slice(3).trim(),
        }))
      : [];

    const stagedCount = files.filter(f => f.code[0] && f.code[0] !== '?').length;
    const untrackedCount = files.filter(f => f.code === '??').length;
    const changedCount = files.filter(f => f.code[1] && f.code[1] !== '?').length;

    return {
      isRepo: true,
      root,
      rootName: path.basename(root),
      branch,
      upstream,
      ahead,
      behind,
      stagedCount,
      changedCount,
      untrackedCount,
      files: files.slice(0, 80),
    };
  } catch {
    return { isRepo: false, note: 'This session is not inside a git repository.' };
  }
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

  // Helper: extract servers from a .mcp.json (handles mcpServers wrapper or flat)
  function extractMcpServers(data) {
    if (!data) return {};
    if (data.mcpServers && typeof data.mcpServers === 'object') return data.mcpServers;
    // Flat format (keys are server names directly)
    const result = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'object' && v !== null) result[k] = v;
    }
    return result;
  }

  // 1. OAuth-connected servers (claude.ai integrations)
  const mcpAuth = readJsonSafe(path.join(home, '.claude', 'mcp-needs-auth-cache.json'));
  if (mcpAuth) {
    for (const name of Object.keys(mcpAuth)) {
      activeServers.push({ name, type: 'oauth', source: 'claude.ai', scope: 'global', disabled: false });
    }
  }

  // 2. Project-level .mcp.json (configured for this project)
  if (cwd) {
    const projectMcpRaw = readJsonSafe(path.join(cwd, '.mcp.json'));
    const projectMcp = extractMcpServers(projectMcpRaw);
    for (const [name, conf] of Object.entries(projectMcp)) {
      activeServers.push({ name, type: conf.type || '—', source: '.mcp.json', scope: 'project', disabled: !!conf.disabled });
    }
  }

  // 3. Global .mcp.json (user-configured globally)
  const globalMcpRaw = readJsonSafe(path.join(home, '.claude', '.mcp.json'));
  const globalMcp = extractMcpServers(globalMcpRaw);
  for (const [name, conf] of Object.entries(globalMcp)) {
    activeServers.push({ name, type: conf.type || '—', source: '~/.claude/.mcp.json', scope: 'global', disabled: !!conf.disabled });
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

  // CLAUDE.md files — project root, parent directories, and global
  // Claude Code loads CLAUDE.md from cwd up to the git root (or home), plus ~/.claude/CLAUDE.md
  const claudeMdFiles = [];
  if (cwd) {
    // Find git root to know where to stop scanning
    let gitRoot = null;
    try { gitRoot = runGit(cwd, 'rev-parse --show-toplevel'); } catch {}

    // Walk from cwd upward to git root (or home)
    const stopAt = gitRoot || home;
    let dir = cwd;
    while (true) {
      const filePath = path.join(dir, 'CLAUDE.md');
      const content = readTextSafe(filePath);
      if (content) {
        const rel = dir === cwd ? 'CLAUDE.md' : path.relative(cwd, filePath);
        claudeMdFiles.push({ title: rel, scope: 'project', path: filePath, content });
      }
      // Also check .claude/CLAUDE.md in project directories
      const dotClaudeMd = readTextSafe(path.join(dir, '.claude', 'CLAUDE.md'));
      if (dotClaudeMd) {
        const rel = path.relative(cwd, path.join(dir, '.claude', 'CLAUDE.md'));
        claudeMdFiles.push({ title: rel, scope: 'project', path: path.join(dir, '.claude', 'CLAUDE.md'), content: dotClaudeMd });
      }
      if (dir === stopAt || dir === '/') break;
      dir = path.dirname(dir);
    }
  }

  // Global ~/.claude/CLAUDE.md
  const globalClaudeMd = readTextSafe(path.join(home, '.claude', 'CLAUDE.md'));
  if (globalClaudeMd) {
    claudeMdFiles.push({ title: '~/.claude/CLAUDE.md', scope: 'global', path: path.join(home, '.claude', 'CLAUDE.md'), content: globalClaudeMd });
  }

  for (const f of claudeMdFiles) {
    sections.push({ title: f.title, scope: f.scope, icon: 'doc', content: f.content });
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

// Toggle MCP server enabled/disabled
router.post('/:pid/mcp-toggle', (req, res) => {
  try {
    const { pid } = req.params;
    const { serverName, scope, disabled } = req.body;

    if (!serverName || typeof disabled !== 'boolean') {
      return res.status(400).json({ error: 'serverName and disabled (boolean) are required' });
    }

    const home = os.homedir();
    let mcpPath;

    if (scope === 'project') {
      const cwdMap = getCwdMap([pid]);
      const cwd = cwdMap[pid];
      if (!cwd) return res.status(400).json({ error: 'Cannot determine agent working directory' });
      mcpPath = path.join(cwd, '.mcp.json');
    } else {
      mcpPath = path.join(home, '.claude', '.mcp.json');
    }

    let data = readJsonSafe(mcpPath) || {};

    // Handle mcpServers wrapper format
    const hasMcpServers = data.mcpServers && typeof data.mcpServers === 'object';
    const servers = hasMcpServers ? data.mcpServers : data;

    if (!servers[serverName]) {
      return res.status(404).json({ error: `Server "${serverName}" not found in ${scope} config` });
    }

    if (disabled) {
      servers[serverName].disabled = true;
    } else {
      delete servers[serverName].disabled;
    }

    if (hasMcpServers) {
      data.mcpServers = servers;
    } else {
      data = servers;
    }

    fs.writeFileSync(mcpPath, JSON.stringify(data, null, 2) + '\n');
    res.json({ ok: true, serverName, disabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:pid/git', (req, res) => {
  try {
    const { pid } = req.params;
    const psOut = execSync(`ps -p ${pid} -o args= 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (!psOut) return res.status(404).json({ error: 'Process not found' });

    const cwdMap = getCwdMap([pid]);
    const cwd = cwdMap[pid] || null;
    res.json(getGitInfo(cwd));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Parse a tmux pane capture looking for a Claude Code permission prompt
function parsePermissionPrompt(text) {
  const allLines = text.split('\n');
  // Only scan the last 20 lines — a real prompt is always near the bottom.
  // This avoids false positives from conversation text scrolled up in the terminal.
  const startIdx = Math.max(0, allLines.length - 20);
  const lines = allLines.slice(startIdx);

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
      if (mux) {
        const text = captureMuxText(mux, pid, -30);
        if (text) {
          if (parsePermissionPrompt(text)) return { done: true, reason: 'waiting_input' };
          if (proc.args && /(^|\/)codex(\s|$)/.test(proc.args) && detectCodexTerminalState(text) === 'thinking') {
            return { done: false };
          }
          const lines = text.split('\n').filter(l => l.trim());
          const lastLine = lines[lines.length - 1]?.trim() || '';
          if (/^[❯>]\s*$/.test(lastLine) && cpu < 2) return { done: true, reason: 'idle' };
        }
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

        if (def?.id && cwd) {
          const resolver = getSessionResolver(def.id);
          const paneText = ['claude', 'codex'].includes(def.id) ? captureAgentPaneText(pid) : '';
          const resolved = resolver?.resolveLiveSession
            ? resolver.resolveLiveSession({ cwd, pid, args: psOut, paneText })
            : null;
          if (resolved && resolver?.parseResolved) {
            const parsed = resolver.parseResolved(resolved);
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
    const resolver = getSessionResolver(def.id);
    const paneText = ['claude', 'codex'].includes(def.id) ? captureAgentPaneText(pid) : '';
    const resolved = resolver?.resolveLiveSession
      ? resolver.resolveLiveSession({ cwd, pid: String(pid), args: psOut, paneText })
      : null;
    const sessionId = resolver?.getResumeSessionId ? resolver.getResumeSessionId(resolved) : null;

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
    const tmuxSession = tmuxSessionNameFromMux(mux);
    if (!tmuxSession) return res.status(400).json({ error: 'Relaunch currently requires the agent to be running in tmux' });

    // Kill the process
    try { execSync(`kill ${pid}`, { timeout: 2000 }); } catch {}
    try { execSync('sleep 0.5'); } catch {}

    // Kill the old tmux session
    try { execSync(`tmux kill-session -t ${shellEscape(tmuxSession)} 2>/dev/null`, { timeout: 3000 }); } catch {}
    try { execSync('sleep 0.3'); } catch {}

    // Ensure the original session name is actually free before recreating it.
    try {
      execSync(`tmux has-session -t ${shellEscape(tmuxSession)} 2>/dev/null`, { timeout: 2000 });
      return res.status(409).json({ error: `tmux session "${tmuxSession}" is still active; could not recreate it cleanly` });
    } catch {}

    // Relaunch in a new tmux session with the same name
    const sessionName = tmuxSession;
    const userShell = resolveUserShell();

    execSync(`tmux new-session -d -s ${shellEscape(sessionName)} -c ${shellEscape(cwd)} ${shellEscape(userShell)} -l`, { timeout: 5000 });

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
    execSync(`tmux set-buffer -- ${shellEscape(cmd)}`, { timeout: 3000 });
    execSync(`tmux paste-buffer -t ${shellEscape(sessionName)} -d`, { timeout: 3000 });
    execSync('sleep 0.15');
    execSync(`tmux send-keys -t ${shellEscape(sessionName)} Enter`, { timeout: 3000 });

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
    const tmuxSession = tmuxSessionNameFromMux(mux);
    if (tmuxSession) {
      try { execSync(`tmux kill-session -t ${shellEscape(tmuxSession)} 2>/dev/null`); } catch {}
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
