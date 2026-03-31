const fs = require('fs');
const path = require('path');

function readLines(fp) {
  try {
    return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function parseHistory(historyPath, { project, search, limit, offset } = {}) {
  let entries = readLines(historyPath);
  if (project) {
    entries = entries.filter(e => e.project === project);
  }
  if (search) {
    const term = search.toLowerCase();
    entries = entries.filter(e => (e.display || '').toLowerCase().includes(term));
  }
  entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const start = offset || 0;
  const end = limit ? start + limit : entries.length;
  return entries.slice(start, end);
}

function getSessions(claudeDir, { project, search, limit, offset } = {}) {
  const historyPath = path.join(claudeDir, 'history.jsonl');
  const entries = readLines(historyPath);

  // Build session map from session files
  const sessionMeta = {};
  const sessDir = path.join(claudeDir, 'sessions');
  try {
    for (const f of fs.readdirSync(sessDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
        if (data.sessionId) sessionMeta[data.sessionId] = data;
      } catch {}
    }
  } catch {}

  // Group by sessionId
  const groups = {};
  for (const e of entries) {
    const sid = e.sessionId;
    if (!sid) continue;
    if (!groups[sid]) {
      groups[sid] = {
        sessionId: sid,
        project: e.project,
        messages: [],
        firstTimestamp: e.timestamp,
        lastTimestamp: e.timestamp,
      };
    }
    groups[sid].messages.push(e);
    if (e.timestamp < groups[sid].firstTimestamp) groups[sid].firstTimestamp = e.timestamp;
    if (e.timestamp > groups[sid].lastTimestamp) groups[sid].lastTimestamp = e.timestamp;
  }

  let sessions = Object.values(groups).map(g => ({
    sessionId: g.sessionId,
    project: g.project,
    messageCount: g.messages.length,
    firstTimestamp: g.firstTimestamp,
    lastTimestamp: g.lastTimestamp,
    cwd: sessionMeta[g.sessionId]?.cwd || g.project,
    startedAt: sessionMeta[g.sessionId]?.startedAt || g.firstTimestamp,
  }));

  if (project) {
    sessions = sessions.filter(s => s.project === project || s.cwd === project);
  }
  if (search) {
    const term = search.toLowerCase();
    const histEntries = parseHistory(path.join(claudeDir, 'history.jsonl'), { search });
    const matchIds = new Set(histEntries.map(e => e.sessionId));
    sessions = sessions.filter(s => matchIds.has(s.sessionId));
  }

  sessions.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
  const start = offset || 0;
  const end = limit ? start + limit : sessions.length;
  return sessions.slice(start, end);
}

function getSessionDetail(historyPath, sessionId) {
  const entries = readLines(historyPath);
  return entries
    .filter(e => e.sessionId === sessionId)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

module.exports = { parseHistory, getSessions, getSessionDetail };
