const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const AGENT_DEFS = [
  { id: 'claude',    name: 'Claude Code', match: (bin, args) => bin === 'claude'    || /\/bin\/claude(-code)?(\s|$)/.test(args) },
  { id: 'codex',     name: 'Codex',       match: (bin, args) => bin === 'codex'     || /\/bin\/codex(\s|$)/.test(args) },
  { id: 'gemini',    name: 'Gemini',      match: (bin, args) => bin === 'gemini'    || /\/bin\/gemini(\s|$)/.test(args) },
  { id: 'opencode',  name: 'OpenCode',    match: (bin, args) => bin === 'opencode'  || /\/bin\/opencode(\s|$)/.test(args) },
  { id: 'aider',     name: 'Aider',       match: (bin, args) => bin === 'aider'     || /\/bin\/aider(\s|$)/.test(args) },
  { id: 'continue',  name: 'Continue',    match: (bin, args) => bin === 'continue'  || /\/bin\/continue(\s|$)/.test(args) },
];

// ─── Claude ──────────────────────────────────────────────────────────────────

function encodeCwdClaude(cwd) {
  return cwd.replace(/\//g, '-'); // /Users/foo/bar → -Users-foo-bar
}

function findClaudeSessionFile(cwd) {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwdClaude(cwd));
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? path.join(dir, files[0].f) : null;
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'text' && b.text?.trim())
      .map(b => b.text.trim())
      .join('\n\n');
  }
  return '';
}

function extractToolsFromContent(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(b => b.type === 'tool_use')
    .map(b => ({ name: b.name, input: b.input }));
}

function parseClaudeSession(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const messages = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!['user', 'assistant'].includes(e.type)) continue;
      const msg = e.message;
      if (!msg) continue;
      const text = extractTextFromContent(msg.content);
      const tools = extractToolsFromContent(msg.content);
      if (text || tools.length) {
        messages.push({ role: msg.role, text, tools, timestamp: e.timestamp || null });
      }
    } catch {}
  }
  return messages;
}

// ─── Codex ───────────────────────────────────────────────────────────────────

const CODEX_SKIP = ['# AGENTS.md', '<permissions', '<collaboration_mode', 'You are Codex', 'Filesystem sandboxing'];

function findCodexSessionFile(cwd, args) {
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  const m = args.match(/resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m) {
    const id = m[1].replace(/-/g, '');
    try {
      const hit = execSync(`find "${sessionsDir}" -name "*${id}*" 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim();
      if (hit) return hit.split('\n')[0];
    } catch {}
  }
  // Fallback: scan recent files for matching cwd
  try {
    const recent = execSync(`find "${sessionsDir}" -name "*.jsonl" -mtime -30 2>/dev/null | sort -r | head -40`, { encoding: 'utf8', timeout: 3000 })
      .trim().split('\n').filter(Boolean);
    for (const f of recent) {
      try {
        const first = execSync(`head -1 "${f}" 2>/dev/null`, { encoding: 'utf8' }).trim();
        const meta = JSON.parse(first);
        if (meta.type === 'session_meta' && meta.payload?.cwd === cwd) return f;
      } catch {}
    }
  } catch {}
  return null;
}

function parseCodexSession(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const messages = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type !== 'response_item') continue;
      const p = e.payload;
      if (!['user', 'assistant'].includes(p.role)) continue;
      const texts = [];
      const tools = [];
      for (const c of (p.content || [])) {
        if (c.type === 'input_text' || c.type === 'output_text') {
          const t = (c.text || '').trim();
          if (!t || CODEX_SKIP.some(pfx => t.startsWith(pfx))) continue;
          if (t.startsWith('<') && t.length > 300) continue; // skip injected XML
          texts.push(t);
        } else if (c.type === 'function_call' || c.type === 'tool_call') {
          tools.push({ name: c.name || 'tool', input: c.arguments || c.parameters });
        }
      }
      if (texts.length) {
        messages.push({ role: p.role, text: texts.join('\n\n'), tools, timestamp: e.timestamp || null });
      }
    } catch {}
  }
  return messages;
}

// ─── OpenCode ─────────────────────────────────────────────────────────────────

function parseOpenCodeSession(cwd) {
  const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    const safeCwd = cwd.replace(/'/g, "''");
    // Get the most recent session for this directory
    const sessionJson = execSync(
      `sqlite3 -json "${dbPath}" "SELECT id FROM session WHERE directory='${safeCwd}' ORDER BY time_updated DESC LIMIT 1" 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    if (!sessionJson || sessionJson === '[]') return [];
    const sessionId = JSON.parse(sessionJson)[0]?.id;
    if (!sessionId) return [];

    // Get messages
    const msgsJson = execSync(
      `sqlite3 -json "${dbPath}" "SELECT id, data, time_created FROM message WHERE session_id='${sessionId}' ORDER BY time_created ASC" 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    if (!msgsJson || msgsJson === '[]') return [];
    const msgs = JSON.parse(msgsJson);

    const messages = [];
    for (const msg of msgs) {
      const msgData = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
      if (!['user', 'assistant'].includes(msgData?.role)) continue;

      // Get parts
      const partsJson = execSync(
        `sqlite3 -json "${dbPath}" "SELECT data FROM part WHERE message_id='${msg.id}' ORDER BY time_created ASC" 2>/dev/null`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      const parts = (partsJson && partsJson !== '[]') ? JSON.parse(partsJson) : [];

      const texts = [];
      const tools = [];
      for (const part of parts) {
        const pd = typeof part.data === 'string' ? JSON.parse(part.data) : part.data;
        if (pd?.type === 'text' && pd.text?.trim()) texts.push(pd.text.trim());
        else if (pd?.type === 'reasoning' && pd.text?.trim()) texts.push(`> ${pd.text.trim()}`);
        else if (pd?.type === 'tool-invocation') tools.push({ name: pd.toolName || 'tool', input: pd.args });
      }

      if (texts.length || tools.length) {
        messages.push({ role: msgData.role, text: texts.join('\n\n'), tools, timestamp: msg.time_created });
      }
    }
    return messages;
  } catch (e) {
    return null;
  }
}

module.exports = {
  AGENT_DEFS,
  findClaudeSessionFile,
  parseClaudeSession,
  findCodexSessionFile,
  parseCodexSession,
  parseOpenCodeSession,
};
