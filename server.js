const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const os = require('os');

const app = express();
const PORT = 3456;
const SSH_DIR = path.join(os.homedir(), '.ssh');
const CONFIG_FILE = path.join(SSH_DIR, 'config');
const KNOWN_HOSTS_FILE = path.join(SSH_DIR, 'known_hosts');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── SSH Config Parser ────────────────────────────────────────────────────────

function parseSSHConfig(content) {
  const blocks = [];
  let current = null;
  let globalLines = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      if (current) current.comments.push(line);
      else globalLines.push(line);
      continue;
    }

    const match = trimmed.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, key, value] = match;

    if (key.toLowerCase() === 'host') {
      current = { Host: value, options: {}, comments: [], raw: [] };
      blocks.push(current);
    } else if (key.toLowerCase() === 'include' && !current) {
      globalLines.push(line);
    } else if (current) {
      current.options[key] = value;
      current.raw.push(line);
    } else {
      globalLines.push(line);
    }
  }

  return { blocks, globalLines };
}

function serializeSSHConfig(blocks, globalLines) {
  const parts = [];

  // Write global lines first (includes, comments, global options)
  for (const line of globalLines) {
    parts.push(line);
  }

  if (globalLines.length > 0 && blocks.length > 0) parts.push('');

  for (const block of blocks) {
    for (const comment of block.comments) {
      parts.push(comment);
    }
    parts.push(`Host ${block.Host}`);
    for (const [key, value] of Object.entries(block.options)) {
      parts.push(`    ${key} ${value}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { blocks: [], globalLines: [] };
  return parseSSHConfig(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function writeConfig(blocks, globalLines) {
  fs.writeFileSync(CONFIG_FILE, serializeSSHConfig(blocks, globalLines), 'utf8');
}

// ─── Config API ───────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  try {
    const { blocks, globalLines } = readConfig();
    res.json({ blocks, globalLines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/config/raw', (req, res) => {
  try {
    const content = fs.existsSync(CONFIG_FILE)
      ? fs.readFileSync(CONFIG_FILE, 'utf8')
      : '';
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/config/raw', (req, res) => {
  try {
    const { content } = req.body;
    fs.writeFileSync(CONFIG_FILE, content, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/config/host', (req, res) => {
  try {
    const { Host, options, originalHost } = req.body;
    const { blocks, globalLines } = readConfig();

    const existingIdx = blocks.findIndex(b =>
      b.Host === (originalHost || Host)
    );

    if (existingIdx >= 0) {
      blocks[existingIdx] = { Host, options, comments: blocks[existingIdx].comments, raw: [] };
    } else {
      blocks.push({ Host, options, comments: [], raw: [] });
    }

    writeConfig(blocks, globalLines);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/config/host/:name', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const { blocks, globalLines } = readConfig();
    const filtered = blocks.filter(b => b.Host !== name);
    writeConfig(filtered, globalLines);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Known Hosts API ─────────────────────────────────────────────────────────

app.get('/api/known-hosts', (req, res) => {
  try {
    if (!fs.existsSync(KNOWN_HOSTS_FILE)) return res.json({ entries: [] });
    const lines = fs.readFileSync(KNOWN_HOSTS_FILE, 'utf8').split('\n');
    const entries = lines
      .map((line, i) => ({ line: line.trimEnd(), index: i }))
      .filter(e => e.line && !e.line.startsWith('#'));
    res.json({ entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/known-hosts', (req, res) => {
  try {
    const { host } = req.body;
    execSync(`ssh-keygen -R "${host}" 2>/dev/null || true`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SSH Keys API ─────────────────────────────────────────────────────────────

function getKeys() {
  if (!fs.existsSync(SSH_DIR)) return [];
  const files = fs.readdirSync(SSH_DIR);
  const pubFiles = files.filter(f => f.endsWith('.pub'));

  return pubFiles.map(pubFile => {
    const name = pubFile.replace('.pub', '');
    const pubPath = path.join(SSH_DIR, pubFile);
    const privPath = path.join(SSH_DIR, name);
    const pubContent = fs.readFileSync(pubPath, 'utf8').trim();
    const parts = pubContent.split(' ');
    const type = parts[0] || 'unknown';
    const comment = parts[2] || '';
    const stat = fs.statSync(pubPath);

    return {
      name,
      type,
      comment,
      publicKey: pubContent,
      hasPrivate: fs.existsSync(privPath),
      created: stat.birthtime,
      modified: stat.mtime,
      pubPath,
      privPath: fs.existsSync(privPath) ? privPath : null,
    };
  });
}

app.get('/api/keys', (req, res) => {
  try {
    res.json({ keys: getKeys() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/keys/generate', (req, res) => {
  try {
    const { name, type = 'ed25519', comment = '', passphrase = '' } = req.body;
    if (!name || !/^[\w.-]+$/.test(name)) {
      return res.status(400).json({ error: 'Invalid key name' });
    }

    const keyPath = path.join(SSH_DIR, name);
    if (fs.existsSync(keyPath)) {
      return res.status(400).json({ error: `Key "${name}" already exists` });
    }

    const cmd = [
      'ssh-keygen',
      `-t ${type}`,
      type === 'rsa' ? '-b 4096' : '',
      `-f "${keyPath}"`,
      `-N "${passphrase}"`,
      comment ? `-C "${comment}"` : '',
    ].filter(Boolean).join(' ');

    execSync(cmd);
    res.json({ ok: true, keys: getKeys() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/keys/:name', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    if (!/^[\w.-]+$/.test(name)) {
      return res.status(400).json({ error: 'Invalid key name' });
    }

    const pubPath = path.join(SSH_DIR, `${name}.pub`);
    const privPath = path.join(SSH_DIR, name);

    if (fs.existsSync(pubPath)) fs.unlinkSync(pubPath);
    if (fs.existsSync(privPath)) fs.unlinkSync(privPath);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AI Agents ────────────────────────────────────────────────────────────────

const AGENT_DEFS = [
  { id: 'claude',    name: 'Claude Code', match: (bin, args) => bin === 'claude'    || /\/bin\/claude(-code)?(\s|$)/.test(args) },
  { id: 'codex',     name: 'Codex',       match: (bin, args) => bin === 'codex'     || /\/bin\/codex(\s|$)/.test(args) },
  { id: 'gemini',    name: 'Gemini',      match: (bin, args) => bin === 'gemini'    || /\/bin\/gemini(\s|$)/.test(args) },
  { id: 'opencode',  name: 'OpenCode',    match: (bin, args) => bin === 'opencode'  || /\/bin\/opencode(\s|$)/.test(args) },
  { id: 'aider',     name: 'Aider',       match: (bin, args) => bin === 'aider'     || /\/bin\/aider(\s|$)/.test(args) },
  { id: 'continue',  name: 'Continue',    match: (bin, args) => bin === 'continue'  || /\/bin\/continue(\s|$)/.test(args) },
];

function getCwdMap(pids) {
  if (!pids.length) return {};
  try {
    const joined = pids.join(',');
    const out = execSync(`lsof -p ${joined} -a -d cwd -Fn 2>/dev/null`, { encoding: 'utf8', timeout: 4000 });
    const map = {};
    let currentPid = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) currentPid = line.slice(1).trim();
      else if (line.startsWith('n') && currentPid) map[currentPid] = line.slice(1).trim();
    }
    return map;
  } catch { return {}; }
}

app.get('/api/agents', (req, res) => {
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
    res.json({ agents });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/agents/:pid', (req, res) => {
  try {
    const pid = parseInt(req.params.pid, 10);
    if (!pid || pid <= 1) return res.status(400).json({ error: 'Invalid PID' });
    execSync(`kill ${pid}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Terminal Sessions ────────────────────────────────────────────────────────

// macOS ps comm can be a full path; match by suffix/includes
function appFromComm(comm) {
  if (!comm) return null;
  // Warp: binary is "stable" inside Warp.app
  if (comm === 'stable' || comm.endsWith('/stable') || comm.includes('Warp.app')) return 'Warp';
  if (comm === 'iTerm2' || comm.includes('iTerm2')) return 'iTerm2';
  if (comm === 'Terminal' || comm.includes('Terminal.app')) return 'Terminal';
  return null;
}

const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh']);
function isShell(comm) {
  // login shells have a leading "-" (e.g. "-zsh")
  return SHELLS.has(comm.replace(/^-/, ''));
}
function shellName(comm) {
  return comm.replace(/^-/, '');
}

function buildProcTable() {
  const out = execSync('ps -eo pid,ppid,tty,comm 2>/dev/null', { encoding: 'utf8' });
  const procs = {};
  for (const line of out.trim().split('\n').slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 4) continue;
    const [pid, ppid, tty, ...rest] = p;
    const comm = rest.join(' ').trim();
    procs[pid] = { pid, ppid, tty, comm };
  }
  return procs;
}

function findAncestorApp(pid, procs, depth = 0) {
  if (depth > 25 || !procs[pid]) return null;
  const p = procs[pid];
  const app = appFromComm(p.comm);
  if (app) return app;
  if (p.ppid === '0' || p.ppid === '1' || p.ppid === p.pid) return null;
  return findAncestorApp(p.ppid, procs, depth + 1);
}

function getITerm2Titles() {
  try {
    const script = [
      'tell application "iTerm2"',
      '  set out to ""',
      '  repeat with w in windows',
      '    repeat with t in tabs of w',
      '      repeat with s in sessions of t',
      '        set out to out & (tty of s) & "|" & (name of s) & "\n"',
      '      end repeat',
      '    end repeat',
      '  end repeat',
      '  return out',
      'end tell',
    ].join('\n');
    const tmp = path.join(os.tmpdir(), `iterm-titles-${Date.now()}.scpt`);
    fs.writeFileSync(tmp, script);
    const raw = execSync(`osascript "${tmp}" 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim();
    fs.unlinkSync(tmp);
    const map = {};
    for (const line of raw.split('\n')) {
      const idx = line.indexOf('|');
      if (idx < 0) continue;
      const tty = line.slice(0, idx).trim(); // e.g. "ttys003"
      map[tty] = line.slice(idx + 1).trim();
      map[tty.replace(/^tty/, '')] = line.slice(idx + 1).trim(); // also index by "s003"
    }
    return map;
  } catch {
    return {};
  }
}

app.get('/api/sessions/terminal-sessions', (req, res) => {
  try {
    const procs = buildProcTable();

    // Collect all shell processes that belong to a known terminal app
    const shellsByTty = {};
    for (const [pid, proc] of Object.entries(procs)) {
      if (proc.tty === '??' || proc.tty === '?' || !isShell(proc.comm)) continue;
      const app = findAncestorApp(proc.ppid, procs);
      if (!app) continue;
      if (!shellsByTty[proc.tty]) shellsByTty[proc.tty] = [];
      shellsByTty[proc.tty].push({ ...proc, app });
    }

    const iterm2Titles = getITerm2Titles();
    const sessions = [];

    for (const [tty, shells] of Object.entries(shellsByTty)) {
      // Pick the leaf shell on this TTY (no shell children on same TTY)
      const shellPids = new Set(shells.map(s => s.pid));
      const leaf = shells.find(s => !shells.some(o => o.ppid === s.pid)) || shells[0];

      // Find foreground non-shell process on this TTY
      const fg = Object.values(procs).find(p =>
        p.ppid === leaf.pid && p.tty === tty && !isShell(p.comm)
      );

      let command = null;
      if (fg) {
        try {
          command = execSync(`ps -p ${fg.pid} -o args= 2>/dev/null`, { encoding: 'utf8' }).trim();
        } catch {}
      }

      const itermTitle = iterm2Titles[tty] || iterm2Titles[`tty${tty}`] || null;

      sessions.push({
        tty,
        app: leaf.app,
        shell: shellName(leaf.comm),
        pid: leaf.pid,
        fgComm: fg?.comm || null,
        command,
        idle: !fg,
        title: itermTitle,
      });
    }

    // Sort: non-idle first, then by app name, then tty
    sessions.sort((a, b) => {
      if (a.idle !== b.idle) return a.idle ? 1 : -1;
      return a.app.localeCompare(b.app) || a.tty.localeCompare(b.tty);
    });

    res.json({ sessions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sessions/focus', (req, res) => {
  try {
    const { tty, app } = req.body;
    // tty from ps is like "s003"; iTerm2 AppleScript uses "ttys003"
    const safeTtySuffix = (tty || '').replace(/[^a-z0-9]/g, '');
    let script;

    if (app === 'iTerm2') {
      script = [
        'tell application "iTerm2"',
        '  activate',
        '  repeat with w in windows',
        '    repeat with t in tabs of w',
        '      repeat with s in sessions of t',
        `        if tty of s ends with "${safeTtySuffix}" then`,
        '          tell w to select',
        '          set selected of t to true',
        '          return',
        '        end if',
        '      end repeat',
        '    end repeat',
        '  end repeat',
        'end tell',
      ].join('\n');
    } else if (app === 'Warp') {
      script = 'tell application "Warp" to activate';
    } else {
      script = 'tell application "Terminal" to activate';
    }

    const tmp = path.join(os.tmpdir(), `focus-${Date.now()}.scpt`);
    fs.writeFileSync(tmp, script);
    try { execSync(`osascript "${tmp}"`); } finally { fs.unlinkSync(tmp); }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Sessions API ─────────────────────────────────────────────────────────────

function getTerminals() {
  const apps = [];
  if (fs.existsSync('/Applications/iTerm.app')) apps.push({ id: 'iterm', name: 'iTerm2' });
  if (fs.existsSync('/Applications/Warp.app')) apps.push({ id: 'warp', name: 'Warp' });
  apps.push({ id: 'terminal', name: 'Terminal' });
  return apps;
}

app.get('/api/sessions/terminals', (req, res) => {
  res.json({ terminals: getTerminals() });
});

// Active outgoing SSH client processes
app.get('/api/sessions/ssh', (req, res) => {
  try {
    const output = execSync('ps aux 2>/dev/null', { encoding: 'utf8' });
    const processes = output.split('\n')
      .filter(l => /\bssh\b/.test(l) && !l.includes('sshd') && !l.includes('grep') && !l.includes('node '))
      .map(line => {
        const parts = line.trim().split(/\s+/);
        return {
          user: parts[0],
          pid: parts[1],
          cpu: parts[2],
          mem: parts[3],
          started: parts[8],
          time: parts[9],
          command: parts.slice(10).join(' '),
        };
      })
      .filter(p => p.pid && /^\d+$/.test(p.pid));
    res.json({ processes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/sessions/ssh/:pid', (req, res) => {
  try {
    const pid = parseInt(req.params.pid, 10);
    if (!pid || pid <= 1) return res.status(400).json({ error: 'Invalid PID' });
    execSync(`kill ${pid}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Screen sessions
app.get('/api/sessions/screen', (req, res) => {
  try {
    let installed = false;
    try { execSync('which screen 2>/dev/null'); installed = true; } catch {}
    if (!installed) return res.json({ installed: false, sessions: [] });

    let output = '';
    try { output = execSync('screen -list 2>&1 || true', { encoding: 'utf8' }); } catch {}

    const sessions = [];
    for (const line of output.split('\n')) {
      const m = line.match(/^\s+(\d+)\.(\S+)\s+\((\w[\w\s]*)\)/);
      if (m) {
        sessions.push({ id: `${m[1]}.${m[2]}`, pid: m[1], name: m[2], status: m[3].trim() });
      }
    }
    res.json({ installed: true, sessions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sessions/screen', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !/^[\w.-]+$/.test(name)) return res.status(400).json({ error: 'Invalid name' });
    execSync(`screen -dmS "${name}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/sessions/screen/:id', (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    if (!/^[\w.-]+$/.test(id)) return res.status(400).json({ error: 'Invalid id' });
    execSync(`screen -S "${id}" -X quit 2>/dev/null || true`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Tmux sessions
app.get('/api/sessions/tmux', (req, res) => {
  try {
    let installed = false;
    try { execSync('which tmux 2>/dev/null'); installed = true; } catch {}
    if (!installed) return res.json({ installed: false, sessions: [] });

    let output = '';
    try { output = execSync('tmux list-sessions 2>/dev/null || true', { encoding: 'utf8' }); } catch {}

    const sessions = [];
    for (const line of output.split('\n')) {
      const m = line.match(/^([^:]+): (\d+) windows?.*\(created (.+?)\)(.*)/);
      if (m) {
        sessions.push({
          name: m[1],
          windows: parseInt(m[2]),
          created: m[3],
          attached: m[4].includes('attached'),
        });
      }
    }
    res.json({ installed: true, sessions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sessions/tmux', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !/^[\w.-]+$/.test(name)) return res.status(400).json({ error: 'Invalid name' });
    execSync(`tmux new-session -d -s "${name}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/sessions/tmux/:name', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    if (!/^[\w.-]+$/.test(name)) return res.status(400).json({ error: 'Invalid name' });
    execSync(`tmux kill-session -t "${name}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Launch SSH command in a local terminal app via AppleScript
app.post('/api/sessions/launch', (req, res) => {
  try {
    const { command, terminal } = req.body;
    if (!command || !command.trim().startsWith('ssh')) {
      return res.status(400).json({ error: 'Only SSH commands are allowed' });
    }
    // Block shell metacharacters that could cause injection
    if (/[;&|`$(){}<>!\n\r]/.test(command)) {
      return res.status(400).json({ error: 'Command contains invalid characters' });
    }
    const cmd = command.trim().replace(/"/g, '\\"');
    let script;

    if (terminal === 'iterm') {
      script = `tell application "iTerm2"\n  activate\n  create window with default profile command "${cmd}"\nend tell`;
    } else if (terminal === 'warp') {
      // Warp has no AppleScript command support — open a new window, user pastes
      script = `do shell script "open -na 'Warp'"`;
    } else {
      script = `tell application "Terminal"\n  do script "${cmd}"\n  activate\nend tell`;
    }

    const tmpFile = path.join(os.tmpdir(), `ssh-launch-${Date.now()}.scpt`);
    fs.writeFileSync(tmpFile, script);
    try {
      execSync(`osascript "${tmpFile}"`);
    } finally {
      fs.unlinkSync(tmpFile);
    }

    res.json({
      ok: true,
      note: terminal === 'warp' ? 'New Warp window opened — command is in your clipboard, just paste' : undefined,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Server ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`SSH Config UI running at http://localhost:${PORT}`);
});
