const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

function getTerminals() {
  const apps = [];
  if (fs.existsSync('/Applications/iTerm.app')) apps.push({ id: 'iterm', name: 'iTerm2' });
  if (fs.existsSync('/Applications/Warp.app')) apps.push({ id: 'warp', name: 'Warp' });
  apps.push({ id: 'terminal', name: 'Terminal' });
  return apps;
}

module.exports = {
  appFromComm,
  isShell,
  shellName,
  buildProcTable,
  findAncestorApp,
  getCwdMap,
  getITerm2Titles,
  getTerminals,
};
