const fs = require('fs');
const { execSync } = require('child_process');

// Once resolved, the session file for a given PID never changes during its lifetime.
// Cache it to avoid re-running heuristic matching on every poll request.
const pidSessionCache = new Map(); // pid → { sessionFile, agentId, cwd }

function getCachedSession(pid) {
  const entry = pidSessionCache.get(String(pid));
  if (!entry) return null;
  // Verify the cached file still exists (guard against deletion)
  if (entry.sessionFile && !fs.existsSync(entry.sessionFile)) {
    pidSessionCache.delete(String(pid));
    return null;
  }
  return entry;
}

function setCachedSession(pid, sessionFile, agentId, cwd) {
  if (sessionFile) {
    pidSessionCache.set(String(pid), { sessionFile, agentId, cwd });
  }
}

// Prune cache entries for dead PIDs periodically (every 60s)
setInterval(() => {
  for (const pid of pidSessionCache.keys()) {
    try {
      execSync(`ps -p ${pid} -o pid= 2>/dev/null`, { encoding: 'utf8' });
    } catch {
      pidSessionCache.delete(pid);
    }
  }
}, 60000);

module.exports = { getCachedSession, setCachedSession };
