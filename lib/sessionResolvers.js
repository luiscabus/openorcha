const fs = require('fs');
const path = require('path');
const {
  findClaudeSessionFile,
  parseClaudeSession,
  findCodexSessionFile,
  parseCodexSession,
  parseOpenCodeSession,
  listClaudeSessions,
  listCodexSessions,
} = require('./agentParsers');

const claudeResolver = {
  id: 'claude',
  resolveLiveSession({ cwd, pid, args = '', paneText = '' }) {
    if (!cwd) return null;
    const sessionFile = findClaudeSessionFile(cwd, pid, args, null, paneText);
    return sessionFile ? { sessionFile } : null;
  },
  parseResolved(resolved) {
    if (!resolved?.sessionFile) return null;
    return parseClaudeSession(resolved.sessionFile);
  },
  getHistorySessionId(resolved) {
    return resolved?.sessionFile ? path.basename(resolved.sessionFile, '.jsonl') : null;
  },
  getResumeSessionId(resolved) {
    return resolved?.sessionFile ? path.basename(resolved.sessionFile, '.jsonl') : null;
  },
  listSessions(cwd) {
    return listClaudeSessions(cwd);
  },
};

const codexResolver = {
  id: 'codex',
  resolveLiveSession({ cwd, pid, args = '', paneText = '' }) {
    if (!cwd) return null;
    const sessionFile = findCodexSessionFile(cwd, pid, args, null, paneText);
    return sessionFile ? { sessionFile } : null;
  },
  parseResolved(resolved) {
    if (!resolved?.sessionFile) return null;
    return parseCodexSession(resolved.sessionFile);
  },
  getHistorySessionId(resolved) {
    return resolved?.sessionFile ? path.basename(resolved.sessionFile, '.jsonl') : null;
  },
  getResumeSessionId(resolved) {
    if (!resolved?.sessionFile) return null;
    try {
      const first = fs.readFileSync(resolved.sessionFile, 'utf8').split('\n')[0];
      const meta = JSON.parse(first);
      if (meta.type === 'session_meta' && meta.payload?.id) return meta.payload.id;
    } catch {}
    return path.basename(resolved.sessionFile, '.jsonl');
  },
  listSessions(cwd) {
    return listCodexSessions(cwd);
  },
};

const openCodeResolver = {
  id: 'opencode',
  resolveLiveSession({ cwd }) {
    return cwd ? { cwd } : null;
  },
  parseResolved(resolved) {
    if (!resolved?.cwd) return null;
    const messages = parseOpenCodeSession(resolved.cwd);
    return messages !== null ? { messages, sessionMeta: {} } : null;
  },
  getHistorySessionId() {
    return null;
  },
  getResumeSessionId() {
    return null;
  },
  listSessions() {
    return [];
  },
};

const SESSION_RESOLVERS = {
  claude: claudeResolver,
  codex: codexResolver,
  opencode: openCodeResolver,
};

function getSessionResolver(agentId) {
  return SESSION_RESOLVERS[agentId] || null;
}

module.exports = {
  SESSION_RESOLVERS,
  getSessionResolver,
};
