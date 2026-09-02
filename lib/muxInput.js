// Sending text into a multiplexer pane.
//
// Long text must go through a tmux buffer, not send-keys. send-keys delivers
// the string as keystrokes, and an agent's TUI input box mangles or truncates
// a briefing sent that way — the agent then answers a question it only half
// received. Single keys (an option number, an arrow, Enter) are the one case
// send-keys is right for.

const { execSync } = require('child_process');
const { shellEscape } = require('./multiplexer');

/**
 * @param target   tmux target (session:window.pane) or screen session name
 * @param muxType  'tmux' | 'screen'
 * @param message  the text to deliver
 * @param noEnter  deliver the keys without a trailing Enter
 * @param paste    paste without pressing Enter afterwards
 */
function sendMuxInput(target, muxType, { message, noEnter = false, paste = false }) {
  if (muxType === 'tmux') {
    if (paste) {
      execSync(`tmux set-buffer -- ${shellEscape(message)}`, { timeout: 3000 });
      execSync(`tmux paste-buffer -t ${shellEscape(target)} -d`, { timeout: 3000 });
      return;
    }

    if (noEnter) {
      execSync(`tmux send-keys -t ${shellEscape(target)} ${shellEscape(message)}`, { timeout: 3000 });
      return;
    }

    execSync(`tmux set-buffer -- ${shellEscape(message)}`, { timeout: 3000 });
    execSync(`tmux paste-buffer -t ${shellEscape(target)} -d`, { timeout: 3000 });
    execSync('sleep 0.15');
    execSync(`tmux send-keys -t ${shellEscape(target)} Enter`, { timeout: 3000 });
    return;
  }

  if (muxType === 'screen') {
    const payload = noEnter ? message : `${message}\n`;
    execSync(`screen -S ${shellEscape(target)} -X stuff ${shellEscape(payload)}`, { timeout: 3000 });
  }
}

/** A single key or key name (Enter, Up, Down, Escape, "2"). */
function sendMuxKey(target, muxType, key) {
  if (muxType === 'tmux') {
    execSync(`tmux send-keys -t ${shellEscape(target)} ${shellEscape(key)}`, { timeout: 3000 });
    return;
  }
  execSync(`screen -S ${shellEscape(target)} -X stuff ${shellEscape(key)}`, { timeout: 3000 });
}

module.exports = { sendMuxInput, sendMuxKey };
