const express = require('express');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { AGENT_DEFS, findClaudeSessionFile, parseClaudeSession, findCodexSessionFile, parseCodexSession, parseOpenCodeSession } = require('../lib/agentParsers');
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
      sessionFile = findClaudeSessionFile(cwd, pid);
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

router.post('/launch', (req, res) => {
  try {
    let { agentId, cwd, sessionName, skipPermissions } = req.body;
    let cmd = AGENT_COMMANDS[agentId];
    if (!cmd) return res.status(400).json({ error: `Unknown agent: ${agentId}` });
    if (!cwd || !cwd.trim()) return res.status(400).json({ error: 'Working directory is required' });

    cwd = cwd.trim().replace(/^~(?=\/|$)/, os.homedir());
    // Auto-generate session name if not provided
    if (!sessionName || !sessionName.trim()) {
      sessionName = `${agentId}-${path.basename(cwd)}`;
    }
    sessionName = sessionName.trim().replace(/[^a-zA-Z0-9_.\-]/g, '-');

    if (skipPermissions && AGENT_SKIP_PERMISSIONS_FLAG[agentId]) {
      cmd = `${cmd} ${AGENT_SKIP_PERMISSIONS_FLAG[agentId]}`;
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
      const cmd = noEnter
        ? `tmux send-keys -t ${shellEscape(mux.target)} ${shellEscape(message)}`
        : `tmux send-keys -t ${shellEscape(mux.target)} ${shellEscape(message)} Enter`;
      execSync(cmd, { timeout: 3000 });
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
