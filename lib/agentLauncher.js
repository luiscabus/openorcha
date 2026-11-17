// Launching an agent into a tmux session.
//
// Extracted from routes/agents.js so the initiative supervisor can start
// agents the same way the Launch Agent button does.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, exec } = require('child_process');
const { shellEscape, uniqueTmuxSessionName, resolveUserShell } = require('./multiplexer');

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

/**
 * Start an agent CLI in a fresh detached tmux session.
 * Returns { sessionName }. Throws on bad input or tmux failure.
 */
function launchAgent({ agentId, cwd, sessionName, skipPermissions, resumeSessionId, presetFlags = '' }) {
  const isTerminal = agentId === 'terminal';
  let cmd = isTerminal ? null : AGENT_COMMANDS[agentId];
  if (!isTerminal && !cmd) throw new Error(`Unknown agent: ${agentId}`);

  let dir = (cwd || '').trim() || os.homedir();
  dir = dir.replace(/^~(?=\/|$)/, os.homedir());
  if (!fs.existsSync(dir)) throw new Error(`Directory does not exist: ${dir}`);

  let name = (sessionName || '').trim() || `${agentId}-${path.basename(dir)}`;
  name = name.replace(/[^a-zA-Z0-9_.\-]/g, '-');
  name = uniqueTmuxSessionName(name);

  if (!isTerminal) {
    if (skipPermissions && AGENT_SKIP_PERMISSIONS_FLAG[agentId]) {
      cmd = `${cmd} ${AGENT_SKIP_PERMISSIONS_FLAG[agentId]}`;
    }
    if (resumeSessionId && AGENT_RESUME_FLAG[agentId]) {
      cmd = `${cmd} ${AGENT_RESUME_FLAG[agentId](resumeSessionId)}`;
    }
    if (presetFlags) cmd = `${cmd} ${presetFlags}`;
  }

  // Use a login shell so the user's PATH (~/.zshrc, nvm, homebrew, etc.) is sourced
  const userShell = resolveUserShell();
  execSync(`tmux new-session -d -s ${shellEscape(name)} -c ${shellEscape(dir)} ${shellEscape(userShell)} -l`, { timeout: 5000 });

  if (!isTerminal) {
    // Wait for shell prompt to be ready (handles oh-my-zsh updates, slow init, etc.)
    const maxWait = 10000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      execSync('sleep 0.5');
      try {
        const pane = execSync(`tmux capture-pane -t ${shellEscape(name)} -p 2>/dev/null`, { encoding: 'utf8', timeout: 2000 });
        const lines = pane.split('\n').filter(l => l.trim());
        const last = lines[lines.length - 1]?.trim() || '';
        // Shell prompt indicators: ends with $, %, >, ❯, ➜, or #
        if (/[$%>❯➜#]\s*$/.test(last)) break;
      } catch {}
    }
    execSync(`tmux send-keys -t ${shellEscape(name)} ${shellEscape(cmd)} Enter`, { timeout: 5000 });
  }

  return { sessionName: name };
}

/**
 * Async twin of launchAgent, for the supervisor.
 *
 * Launching blocks for up to ten seconds while the shell prompt settles. Doing
 * that synchronously is fine for one click, but the supervisor may start
 * several workers, and a blocked event loop stalls every other lane and the
 * HTTP server with it.
 */
async function launchAgentAsync({ agentId, cwd, sessionName, skipPermissions, resumeSessionId, presetFlags = '' }) {
  const isTerminal = agentId === 'terminal';
  let cmd = isTerminal ? null : AGENT_COMMANDS[agentId];
  if (!isTerminal && !cmd) throw new Error(`Unknown agent: ${agentId}`);

  let dir = (cwd || '').trim() || os.homedir();
  dir = dir.replace(/^~(?=\/|$)/, os.homedir());
  if (!fs.existsSync(dir)) throw new Error(`Directory does not exist: ${dir}`);

  let name = (sessionName || '').trim() || `${agentId}-${path.basename(dir)}`;
  name = name.replace(/[^a-zA-Z0-9_.\-]/g, '-');
  name = uniqueTmuxSessionName(name);

  if (!isTerminal) {
    if (skipPermissions && AGENT_SKIP_PERMISSIONS_FLAG[agentId]) {
      cmd = `${cmd} ${AGENT_SKIP_PERMISSIONS_FLAG[agentId]}`;
    }
    if (resumeSessionId && AGENT_RESUME_FLAG[agentId]) {
      cmd = `${cmd} ${AGENT_RESUME_FLAG[agentId](resumeSessionId)}`;
    }
    if (presetFlags) cmd = `${cmd} ${presetFlags}`;
  }

  const userShell = resolveUserShell();
  await run(`tmux new-session -d -s ${shellEscape(name)} -c ${shellEscape(dir)} ${shellEscape(userShell)} -l`);

  if (!isTerminal) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await sleep(500);
      const pane = await run(`tmux capture-pane -t ${shellEscape(name)} -p 2>/dev/null`).catch(() => '');
      const lines = String(pane).split('\n').filter(l => l.trim());
      const last = lines[lines.length - 1]?.trim() || '';
      if (/[$%>❯➜#]\s*$/.test(last)) break;
    }
    await run(`tmux send-keys -t ${shellEscape(name)} ${shellEscape(cmd)} Enter`);
  }

  return { sessionName: name };
}

function run(cmd, timeout = 15000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout, encoding: 'utf8' }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = {
  AGENT_COMMANDS,
  AGENT_SKIP_PERMISSIONS_FLAG,
  AGENT_RESUME_FLAG,
  launchAgent,
  launchAgentAsync,
};
