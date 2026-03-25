const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const {
  buildProcTable,
  findAncestorApp,
  isShell,
  shellName,
  getITerm2Titles,
  getTerminals,
} = require('../lib/processTree');

function shellEscape(str) {
  return "'" + String(str).replace(/'/g, "'\\''") + "'";
}

const router = express.Router();

function listTmuxSessionNames() {
  let output = '';
  try { output = execSync('tmux list-sessions 2>/dev/null || true', { encoding: 'utf8' }); } catch {}

  const sessions = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^([^:]+): (\d+) windows?.*\(created (.+?)\)(.*)/);
    if (m) {
      sessions.push({
        name: m[1],
        windows: parseInt(m[2], 10),
        created: m[3],
        attached: m[4].includes('attached'),
      });
    }
  }
  return sessions;
}

function findActiveTmuxSessions(sessionNames) {
  const agentKeywords = ['claude', 'codex', 'gemini', 'opencode', 'aider', 'continue'];
  const activeSessions = new Set();

  for (const name of sessionNames) {
    try {
      const panes = execSync(`tmux list-panes -t ${shellEscape(name)} -F '#{pane_pid}' 2>/dev/null`, { encoding: 'utf8' }).trim();
      for (const panePid of panes.split('\n')) {
        const trimmedPanePid = panePid.trim();
        if (!trimmedPanePid) continue;
        try {
          const children = execSync(`pgrep -P ${trimmedPanePid} 2>/dev/null`, { encoding: 'utf8' }).trim();
          const pidsToCheck = [trimmedPanePid, ...children.split('\n')].filter(Boolean);
          for (const pid of pidsToCheck) {
            try {
              const args = execSync(`ps -p ${pid} -o args= 2>/dev/null`, { encoding: 'utf8' }).trim().toLowerCase();
              if (agentKeywords.some(k => args.includes(k))) {
                activeSessions.add(name);
                break;
              }
            } catch {}
          }
          if (activeSessions.has(name)) break;
        } catch {}
      }
    } catch {}
  }

  return activeSessions;
}

router.get('/terminals', (req, res) => {
  res.json({ terminals: getTerminals() });
});

router.get('/terminal-sessions', (req, res) => {
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

router.post('/focus', (req, res) => {
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

// Active outgoing SSH client processes
router.get('/ssh', (req, res) => {
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

router.delete('/ssh/:pid', (req, res) => {
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
router.get('/screen', (req, res) => {
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

router.post('/screen', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !/^[\w.-]+$/.test(name)) return res.status(400).json({ error: 'Invalid name' });
    execSync(`screen -dmS "${name}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/screen/:id', (req, res) => {
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
router.get('/tmux', (req, res) => {
  try {
    let installed = false;
    try { execSync('which tmux 2>/dev/null'); installed = true; } catch {}
    if (!installed) return res.json({ installed: false, sessions: [] });

    const sessions = listTmuxSessionNames();
    const activeSessions = findActiveTmuxSessions(sessions.map(s => s.name));
    for (const session of sessions) {
      session.stale = !activeSessions.has(session.name);
    }
    res.json({ installed: true, sessions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/tmux', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !/^[\w.-]+$/.test(name)) return res.status(400).json({ error: 'Invalid name' });
    execSync(`tmux new-session -d -s "${name}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/tmux/:name', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    if (!/^[\w.-]+$/.test(name)) return res.status(400).json({ error: 'Invalid name' });
    execSync(`tmux kill-session -t "${name}"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/tmux-stale', (req, res) => {
  try {
    const sessionNames = listTmuxSessionNames().map(s => s.name);
    const activeSessions = findActiveTmuxSessions(sessionNames);

    // Kill sessions that have no active agent
    const killed = [];
    for (const name of sessionNames) {
      if (activeSessions.has(name)) continue;
      try {
        execSync(`tmux kill-session -t ${shellEscape(name)} 2>/dev/null`);
        killed.push(name);
      } catch {}
    }

    res.json({ ok: true, killed, kept: sessionNames.length - killed.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Launch SSH command in a local terminal app via AppleScript
router.post('/launch', (req, res) => {
  try {
    const { command, terminal } = req.body;
    const ALLOWED_PREFIXES = ['ssh', 'tmux', 'screen'];
    if (!command || !ALLOWED_PREFIXES.some(p => command.trim().startsWith(p))) {
      return res.status(400).json({ error: 'Only ssh, tmux, and screen commands are allowed' });
    }
    // Block shell metacharacters that could cause injection
    if (/[;&|`$(){}<>!\n\r]/.test(command)) {
      return res.status(400).json({ error: 'Command contains invalid characters' });
    }
    const cmd = command.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    let script;

    let appName = 'Terminal';
    if (terminal === 'iterm') {
      appName = 'iTerm';
      script = [
        'tell application id "com.googlecode.iterm2"',
        '  activate',
        '  set newWindow to (create window with default profile)',
        '  tell current session of newWindow',
        `    write text "${cmd}"`,
        '  end tell',
        'end tell',
      ].join('\n');
    } else if (terminal === 'warp') {
      appName = 'Warp';
      script = 'do shell script "open -na \'Warp\'"';
    } else {
      script = [
        'tell application "Terminal"',
        `  do script "${cmd}"`,
        '  activate',
        'end tell',
      ].join('\n');
    }

    const tmpFile = path.join(os.tmpdir(), `launch-${Date.now()}.applescript`);
    fs.writeFileSync(tmpFile, script);
    try {
      execSync(`osascript ${shellEscape(tmpFile)}`, { timeout: 10000 });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    res.json({
      ok: true,
      note: terminal === 'warp' ? 'New Warp window opened — command is in your clipboard, just paste' : undefined,
    });
  } catch (e) {
    if (String(e.message || '').includes('Not authorized to send Apple events') || String(e.message || '').includes('(-1743)')) {
      const { command, terminal } = req.body || {};
      const appName = terminal === 'iterm' ? 'iTerm' : terminal === 'warp' ? 'Warp' : 'Terminal';
      let appOpened = false;
      try {
        if (terminal === 'iterm') {
          execSync('open -b com.googlecode.iterm2', { timeout: 5000 });
          appOpened = true;
        } else if (terminal === 'terminal') {
          execSync('open -a Terminal', { timeout: 5000 });
          appOpened = true;
        }
      } catch {}
      return res.status(403).json({
        error: `${appName} automation is blocked by macOS. Allow automation in System Settings > Privacy & Security > Automation, or run the command manually.`,
        code: 'MAC_AUTOMATION_DENIED',
        appName,
        appOpened,
        command: String(command || '').trim(),
      });
    }
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
