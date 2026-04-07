const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { buildProcTable } = require('./processTree');

function shellEscape(str) {
  return "'" + String(str).replace(/'/g, "'\\''") + "'";
}

function tmuxSessionExists(name) {
  try {
    execSync(`tmux has-session -t ${shellEscape(name)} 2>/dev/null`, { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function uniqueTmuxSessionName(baseName) {
  const sanitizedBase = String(baseName || 'session').trim().replace(/[^a-zA-Z0-9_.\-]/g, '-') || 'session';
  if (!tmuxSessionExists(sanitizedBase)) return sanitizedBase;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${sanitizedBase}-${i}`;
    if (!tmuxSessionExists(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a unique tmux session name for "${sanitizedBase}"`);
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

function getTmuxTargetForPid(pid, procs = null, tmuxMap = null, screenMap = null) {
  const procTable = procs || buildProcTable();
  const proc = procTable[String(pid)] || procTable[pid];
  if (!proc) return null;
  const mux = detectMultiplexer(
    String(pid),
    proc.tty,
    procTable,
    tmuxMap || buildTmuxPaneMap(),
    screenMap || buildScreenMap(),
  );
  return mux?.type === 'tmux' ? mux.target : null;
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

module.exports = {
  shellEscape,
  tmuxSessionExists,
  uniqueTmuxSessionName,
  resolveUserShell,
  buildTmuxPaneMap,
  buildScreenMap,
  detectMultiplexer,
  tmuxSessionNameFromMux,
  captureMuxText,
  captureAgentPaneText,
  getTmuxTargetForPid,
  stripAnsi,
  detectCodexTerminalState,
  parsePermissionPrompt,
};
