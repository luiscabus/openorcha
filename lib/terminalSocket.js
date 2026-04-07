const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const { URL } = require('url');
const {
  tmuxSessionExists,
  getTmuxTargetForPid,
  tmuxSessionNameFromMux,
} = require('./multiplexer');

function clamp(value, min, max) {
  const num = parseInt(value, 10);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

function safeJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function resolveTmuxBinary() {
  const candidates = [];
  if (process.env.TMUX_BIN) candidates.push(process.env.TMUX_BIN);
  candidates.push('/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux');

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }

  try {
    const found = execSync('command -v tmux 2>/dev/null', { encoding: 'utf8', timeout: 1000 }).trim();
    if (found) return found;
  } catch {}

  return null;
}

function resolveSessionName(searchParams) {
  const rawSession = (searchParams.get('session') || '').trim();
  if (rawSession) {
    const sessionName = rawSession.split(':')[0];
    return tmuxSessionExists(sessionName) ? sessionName : null;
  }

  const pid = (searchParams.get('pid') || '').trim();
  if (!pid) return null;
  const target = getTmuxTargetForPid(pid);
  if (!target) return null;
  return tmuxSessionNameFromMux({ type: 'tmux', target });
}

function decodeTmuxEscapes(text) {
  return String(text || '').replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function splitBufferLines(buffer) {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  return {
    lines: parts.slice(0, -1),
    rest: parts[parts.length - 1] || '',
  };
}

function encodeKeys(data) {
  return Buffer.from(String(data || ''), 'utf8')
    .toString('hex')
    .match(/.{1,2}/g) || [];
}

function attachTerminalSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let parsed;
    try {
      parsed = new URL(req.url, 'http://127.0.0.1');
    } catch {
      socket.destroy();
      return;
    }

    if (parsed.pathname !== '/ws/terminal') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, parsed);
    });
  });

  wss.on('connection', (ws, parsedUrl) => {
    const sessionName = resolveSessionName(parsedUrl.searchParams);
    if (!sessionName) {
      safeJson(ws, { type: 'error', message: 'Could not resolve a tmux session for this terminal.' });
      ws.close();
      return;
    }

    const tmuxBin = resolveTmuxBinary();
    if (!tmuxBin) {
      safeJson(ws, { type: 'error', message: 'tmux is not installed or not available to the server process.' });
      ws.close();
      return;
    }

    const cols = clamp(parsedUrl.searchParams.get('cols') || '120', 40, 320);
    const rows = clamp(parsedUrl.searchParams.get('rows') || '34', 10, 120);
    const child = spawn(tmuxBin, ['-C', 'attach-session', '-t', sessionName], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TERM: 'screen-256color',
        COLORTERM: 'truecolor',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let currentPane = null;
    let stdoutBuffer = '';
    const pending = [];
    let activeCommand = null;

    function sendCommand(command, onComplete) {
      if (!child.stdin.destroyed) child.stdin.write(`${command}\n`);
      pending.push(onComplete || null);
    }

    function finishActiveCommand(kind) {
      if (!activeCommand) return;
      const handler = activeCommand.handler;
      const lines = activeCommand.lines.slice();
      activeCommand = null;
      if (typeof handler === 'function') handler(lines, kind);
    }

    function handleControlLine(rawLine) {
      const line = rawLine.replace(/\r/g, '');
      if (!line) return;

      if (line.startsWith('%begin ')) {
        activeCommand = {
          handler: pending.shift() || null,
          lines: [],
        };
        return;
      }
      if (line.startsWith('%end ')) {
        finishActiveCommand('end');
        return;
      }
      if (line.startsWith('%error ')) {
        finishActiveCommand('error');
        return;
      }
      if (activeCommand) {
        activeCommand.lines.push(line);
        return;
      }

      if (line.startsWith('%output ')) {
        const match = line.match(/^%output\s+(\%\d+)\s(.*)$/);
        if (!match) return;
        const paneId = match[1];
        if (!currentPane || paneId === currentPane) {
          safeJson(ws, { type: 'output', data: decodeTmuxEscapes(match[2]) });
        }
        return;
      }

      if (line.startsWith('%session-changed ')) {
        const match = line.match(/^%session-changed\s+\$\d+\s+(.+)$/);
        if (match) safeJson(ws, { type: 'ready', sessionName: match[1] });
        return;
      }

      if (line.startsWith('%window-pane-changed ')) {
        const match = line.match(/^%window-pane-changed\s+@\d+\s+(\%\d+)$/);
        if (match) currentPane = match[1];
      }
    }

    function refreshClientSize(nextCols, nextRows) {
      sendCommand(`refresh-client -C ${nextCols}x${nextRows}`);
    }

    function syncActivePane() {
      sendCommand(`list-panes -F '#{pane_active} #{pane_id}'`, (lines) => {
        const active = lines
          .map(line => line.trim())
          .find(line => /^1\s+%\d+$/.test(line));
        if (!active) return;
        currentPane = active.split(/\s+/)[1];
      });
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const { lines, rest } = splitBufferLines(stdoutBuffer);
      stdoutBuffer = rest;
      for (const line of lines) handleControlLine(line);
    });

    child.stderr.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim();
      if (message) safeJson(ws, { type: 'error', message });
    });

    child.on('spawn', () => {
      safeJson(ws, { type: 'ready', sessionName });
      refreshClientSize(cols, rows);
      syncActivePane();
    });

    child.on('close', (code, signal) => {
      safeJson(ws, { type: 'exit', exitCode: code, signal });
      try { ws.close(); } catch {}
    });

    child.on('error', (error) => {
      safeJson(ws, { type: 'error', message: `Could not attach to tmux session "${sessionName}": ${error.message}` });
      try { ws.close(); } catch {}
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw || '{}'));
        if (msg.type === 'resize') {
          refreshClientSize(
            clamp(msg.cols || cols, 40, 320),
            clamp(msg.rows || rows, 10, 120),
          );
          return;
        }
        if (msg.type === 'input' && typeof msg.data === 'string') {
          const bytes = encodeKeys(msg.data);
          for (let i = 0; i < bytes.length; i += 32) {
            const chunk = bytes.slice(i, i + 32);
            const target = currentPane ? ` -t ${currentPane}` : '';
            sendCommand(`send-keys -H${target} ${chunk.join(' ')}`);
          }
        }
      } catch {}
    });

    const cleanup = () => {
      try { child.kill('SIGTERM'); } catch {}
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  return wss;
}

module.exports = {
  attachTerminalSocket,
};
