const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const { AGENT_DEFS, listAllRecentSessions } = require('../lib/agentParsers');
const { getSessionResolver } = require('../lib/sessionResolvers');
const { buildProcTable, findAncestorApp, getCwdMap } = require('../lib/processTree');
const { getCachedSession, setCachedSession } = require('../lib/sessionCache');
const { readJsonSafe, readTextSafe, getGitInfo, getClaudeContext, getCodexContext, getGeminiContext } = require('../lib/agentContext');
const {
  shellEscape,
  uniqueTmuxSessionName,
  resolveUserShell,
  buildTmuxPaneMap,
  buildScreenMap,
  detectMultiplexer,
  tmuxSessionNameFromMux,
  captureMuxText,
  captureAgentPaneText,
  detectCodexTerminalState,
  parsePermissionPrompt,
} = require('../lib/multiplexer');
const { router: presetsRouter, loadPresets } = require('./agentPresets');

const router = express.Router();

// Mount presets sub-router
router.use('/presets', presetsRouter);

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

// ─── Constants ───────────────────────────────────────────────────────────────

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

const AGENT_RESUME_FLAG = {
  claude: (sessionId) => `--resume ${sessionId}`,
  codex:  (sessionId) => `resume ${sessionId}`,
};

// ─── Routes ──────────────────────────────────────────────────────────────────

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

    // Use cached session file if available — avoids re-running heuristic matching
    const cached = getCachedSession(pid);
    if (cached && cached.agentId === def.id && cached.cwd === cwd && cached.sessionFile) {
      sessionFile = cached.sessionFile;
      const resolved = { sessionFile };
      parsed = resolver?.parseResolved ? resolver.parseResolved(resolved) : null;
    } else {
      const paneText = ['claude', 'codex'].includes(def.id) ? captureAgentPaneText(pid) : '';
      const resolved = resolver?.resolveLiveSession
        ? resolver.resolveLiveSession({ cwd, pid, args: psOut, paneText })
        : null;
      if (resolved && resolver?.parseResolved) {
        sessionFile = resolved.sessionFile || null;
        parsed = resolver.parseResolved(resolved);
        // Cache the resolved session file for this PID
        setCachedSession(pid, sessionFile, def.id, cwd);
      }
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

// ─── Session history ─────────────────────────────────────────────────────────

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

// ─── Launch ──────────────────────────────────────────────────────────────────

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
    sessionName = uniqueTmuxSessionName(sessionName);

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

    execSync(`tmux new-session -d -s ${shellEscape(sessionName)} -c ${shellEscape(cwd)} ${shellEscape(userShell)} -l`, { timeout: 5000 });
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

// ─── Agent Context / Config ──────────────────────────────────────────────────

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

// ─── Prompt / Terminal / Send ────────────────────────────────────────────────

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
      content = fs.readFileSync(tmpFile, 'utf8');
      fs.unlinkSync(tmpFile);
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

// ─── Relaunch / Kill ─────────────────────────────────────────────────────────

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
