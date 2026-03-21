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

function findClaudeSessionFile(cwd, pid, args) {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwdClaude(cwd));
  if (!fs.existsSync(dir)) return null;

  // If resumed with --resume <sessionId>, find that file directly
  if (args) {
    const resumeMatch = args.match(/--resume\s+([0-9a-f-]+)/i);
    if (resumeMatch) {
      const sessionId = resumeMatch[1];
      const fp = path.join(dir, `${sessionId}.jsonl`);
      if (fs.existsSync(fp)) return fp;
    }
  }

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      return { fp, birthtime: stat.birthtimeMs, mtime: stat.mtimeMs };
    });

  if (!files.length) return null;

  // Match the session file that belongs to this specific PID.
  // Strategy: prefer file created within 60s of process start (new session).
  // Fallback: file that was modified after process start but created before it
  // (auto-resumed / --continue session). Pick the one modified closest to proc start.
  if (pid) {
    try {
      const lstartRaw = execSync(`ps -p ${pid} -o lstart= 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (lstartRaw) {
        const procStart = new Date(lstartRaw).getTime();

        // 1. File created right after process start (new session)
        const newSession = files
          .filter(f => f.birthtime >= procStart - 60000 && f.birthtime <= procStart + 120000)
          .sort((a, b) => a.birthtime - b.birthtime);
        if (newSession.length) return newSession[0].fp;

        // 2. Older file resumed by this process — find the first message timestamp
        //    after procStart to identify which file this specific PID is writing to.
        const resumed = files
          .filter(f => f.birthtime < procStart && f.mtime >= procStart)
          .map(f => {
            // Scan for the first message with a timestamp near/after procStart
            let firstTsAfterStart = 0;
            try {
              const content = fs.readFileSync(f.fp, 'utf8');
              for (const line of content.split('\n')) {
                if (!line.trim()) continue;
                try {
                  const e = JSON.parse(line);
                  if (!e.timestamp) continue;
                  const ts = new Date(e.timestamp).getTime();
                  if (ts >= procStart - 60000) {
                    firstTsAfterStart = ts;
                    break;
                  }
                } catch {}
              }
            } catch {}
            return { ...f, firstTsAfterStart };
          })
          // Only match if it has a message near procStart (within 5 min)
          .filter(f => f.firstTsAfterStart > 0 && f.firstTsAfterStart <= procStart + 300000)
          .sort((a, b) => a.firstTsAfterStart - b.firstTsAfterStart);
        if (resumed.length) return resumed[0].fp;

        return null;
      }
    } catch {}
  }

  // No pid provided: fall back to most recently modified
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0].fp;
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
    .map(b => ({ id: b.id, name: b.name, input: b.input }));
}

function extractToolResultsFromContent(content) {
  if (!Array.isArray(content)) return {};
  const map = {};
  for (const b of content) {
    if (b.type === 'tool_result' && b.tool_use_id) {
      map[b.tool_use_id] = typeof b.content === 'string' ? b.content : '';
    }
  }
  return map;
}

function attachToolResult(tool, tr) {
  if (!tr) return;
  tool.result = tr.stdout || tr.content || '';
  if (tr.stderr) tool.resultError = tr.stderr;
  // Structured patch for Edit/Write tools
  if (tr.structuredPatch && Array.isArray(tr.structuredPatch) && tr.structuredPatch.length > 0) {
    tool.patch = tr.structuredPatch;
  }
}

function parseClaudeSession(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const messages = [];
  const sessionMeta = { totalInputTokens: 0, totalOutputTokens: 0, totalCacheRead: 0, totalCacheCreation: 0, model: null };

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!['user', 'assistant'].includes(e.type)) continue;
      const msg = e.message;
      if (!msg) continue;

      // For user messages with tool_result, attach results to previous assistant's tools
      if (msg.role === 'user' && e.toolUseResult && e.sourceToolAssistantUUID) {
        const resultMap = extractToolResultsFromContent(msg.content);
        const tr = e.toolUseResult;
        if (messages.length > 0) {
          const prev = messages[messages.length - 1];
          if (prev.role === 'assistant' && prev.tools?.length) {
            // Find matching tool by id, or fall back to single-tool match
            let matched = false;
            for (const tool of prev.tools) {
              if (tool.id && resultMap[tool.id] !== undefined) {
                attachToolResult(tool, tr);
                matched = true;
              }
            }
            if (!matched && prev.tools.length === 1) {
              attachToolResult(prev.tools[0], tr);
            }
          }
        }
        continue;
      }

      const text = extractTextFromContent(msg.content);
      const tools = extractToolsFromContent(msg.content);

      // Extract usage and model from assistant messages
      let usage = null;
      let model = null;
      if (msg.role === 'assistant') {
        if (msg.usage) {
          usage = {
            inputTokens: msg.usage.input_tokens || 0,
            outputTokens: msg.usage.output_tokens || 0,
            cacheRead: msg.usage.cache_read_input_tokens || 0,
            cacheCreation: msg.usage.cache_creation_input_tokens || 0,
          };
          sessionMeta.totalInputTokens += usage.inputTokens;
          sessionMeta.totalOutputTokens += usage.outputTokens;
          sessionMeta.totalCacheRead += usage.cacheRead;
          sessionMeta.totalCacheCreation += usage.cacheCreation;
          // Track last context size (input + all cache = total prompt tokens sent)
          sessionMeta.lastContextTokens = usage.inputTokens + usage.cacheRead + usage.cacheCreation;
        }
        if (msg.model) {
          model = msg.model;
          sessionMeta.model = model;
        }
      }

      if (text || tools.length) {
        const entry = { role: msg.role, text, tools, timestamp: e.timestamp || null };
        if (usage) entry.usage = usage;
        if (model) entry.model = model;
        messages.push(entry);
      }
    } catch {}
  }

  // Estimate cost (USD) based on model
  sessionMeta.costUSD = estimateCost(sessionMeta);

  return { messages, sessionMeta };
}

function estimateCost(meta) {
  // Pricing per million tokens (approximate)
  const model = (meta.model || '').toLowerCase();
  let inputRate, outputRate;
  if (model.includes('opus')) {
    inputRate = 15; outputRate = 75;
  } else if (model.includes('haiku')) {
    inputRate = 0.25; outputRate = 1.25;
  } else {
    // Sonnet default
    inputRate = 3; outputRate = 15;
  }
  // Cache reads are 10% of input rate, cache creation is 25% more than input rate
  const totalInput = meta.totalInputTokens + (meta.totalCacheRead * 0.1) + (meta.totalCacheCreation * 1.25);
  return (totalInput * inputRate + meta.totalOutputTokens * outputRate) / 1_000_000;
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

// ─── Session listing (for resume UI) ──────────────────────────────────────────

function listClaudeSessions(cwd) {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwdClaude(cwd));
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      return { fp, id: f.replace('.jsonl', ''), birthtime: stat.birthtimeMs, mtime: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime); // most recent first

  return files.map(f => {
    // Read just enough to extract first user message, session name, message count, model
    let firstUserMsg = '';
    let messageCount = 0;
    let model = null;
    let sessionName = null;
    try {
      const content = fs.readFileSync(f.fp, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.type === 'user' && e.message?.role === 'user') {
            messageCount++;
            if (!firstUserMsg) {
              const text = extractTextFromContent(e.message.content);
              if (text) firstUserMsg = text.slice(0, 200);
            }
          } else if (e.type === 'assistant' && e.message?.role === 'assistant') {
            messageCount++;
            if (e.message.model) model = e.message.model;
          }
          // Check for session name in summary entries
          if (e.sessionName) sessionName = e.sessionName;
        } catch {}
      }
    } catch {}

    return {
      id: f.id,
      firstMessage: firstUserMsg || '(empty session)',
      messageCount,
      model,
      sessionName,
      createdAt: new Date(f.birthtime).toISOString(),
      updatedAt: new Date(f.mtime).toISOString(),
      sizeMB: (f.size / 1048576).toFixed(1),
    };
  });
}

function listCodexSessions(cwd) {
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const sessions = [];
  try {
    const files = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const fp = path.join(sessionsDir, f);
        const stat = fs.statSync(fp);
        return { fp, id: f.replace('.jsonl', ''), mtime: stat.mtimeMs, birthtime: stat.birthtimeMs, size: stat.size };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 50); // limit scan

    for (const f of files) {
      try {
        const first = fs.readFileSync(f.fp, 'utf8').split('\n')[0];
        const meta = JSON.parse(first);
        if (meta.type !== 'session_meta' || meta.payload?.cwd !== cwd) continue;

        // Count messages and get first user message
        let firstUserMsg = '';
        let messageCount = 0;
        const lines = fs.readFileSync(f.fp, 'utf8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line);
            if (e.type !== 'response_item') continue;
            messageCount++;
            if (!firstUserMsg && e.payload?.role === 'user') {
              const text = (e.payload.content || []).find(c => c.type === 'input_text')?.text;
              if (text) firstUserMsg = text.slice(0, 200);
            }
          } catch {}
        }

        sessions.push({
          id: f.id,
          firstMessage: firstUserMsg || '(empty session)',
          messageCount,
          createdAt: new Date(f.birthtime).toISOString(),
          updatedAt: new Date(f.mtime).toISOString(),
          sizeMB: (f.size / 1048576).toFixed(1),
        });
      } catch {}
    }
  } catch {}
  return sessions;
}

function listAllRecentSessions(limit = 30) {
  const home = os.homedir();
  const all = [];

  // Claude: scan all project directories
  const claudeProjectsDir = path.join(home, '.claude', 'projects');
  try {
    for (const projDir of fs.readdirSync(claudeProjectsDir)) {
      const dirPath = path.join(claudeProjectsDir, projDir);
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) continue;
      // Skip memory/ and other non-project directories
      if (projDir === 'memory' || projDir.startsWith('.')) continue;

      const jsonlFiles = fs.readdirSync(dirPath)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const fp = path.join(dirPath, f);
          const s = fs.statSync(fp);
          return { fp, id: f.replace('.jsonl', ''), mtime: s.mtimeMs, birthtime: s.birthtimeMs, size: s.size };
        });

      for (const f of jsonlFiles) {
        // Quick scan: read first ~50 lines to get first user message, model, cwd
        let firstUserMsg = '';
        let model = null;
        let cwd = '';
        let lineCount = 0;
        try {
          // Read only first 32KB for speed
          const fd = fs.openSync(f.fp, 'r');
          const buf = Buffer.alloc(32768);
          const bytesRead = fs.readSync(fd, buf, 0, 32768, 0);
          fs.closeSync(fd);
          const partial = buf.toString('utf8', 0, bytesRead);
          for (const line of partial.split('\n')) {
            if (!line.trim()) continue;
            try {
              const e = JSON.parse(line);
              if (e.cwd && !cwd) cwd = e.cwd;
              if (e.type === 'user' && e.message?.role === 'user' && !firstUserMsg) {
                let text = extractTextFromContent(e.message.content);
                // Strip XML-like system/command tags that wrap user messages
                if (text) text = text.replace(/<[^>]+>[^<]*<\/[^>]+>\s*/g, '').trim();
                if (text) firstUserMsg = text.slice(0, 200);
              }
              if (e.type === 'assistant' && e.message?.model) model = e.message.model;
              lineCount++;
            } catch {}
          }
        } catch {}

        if (!firstUserMsg && lineCount < 2) continue; // skip empty/system-only sessions

        all.push({
          agentId: 'claude',
          id: f.id,
          cwd,
          project: cwd ? path.basename(cwd) : projDir,
          firstMessage: firstUserMsg || '(empty session)',
          model,
          createdAt: new Date(f.birthtime).toISOString(),
          updatedAt: new Date(f.mtime).toISOString(),
          sizeMB: (f.size / 1048576).toFixed(1),
        });
      }
    }
  } catch {}

  // Codex: scan all session files
  const codexDir = path.join(home, '.codex', 'sessions');
  try {
    const files = fs.readdirSync(codexDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const fp = path.join(codexDir, f);
        const s = fs.statSync(fp);
        return { fp, id: f.replace('.jsonl', ''), mtime: s.mtimeMs, birthtime: s.birthtimeMs, size: s.size };
      });

    for (const f of files) {
      try {
        const first = fs.readFileSync(f.fp, 'utf8').split('\n')[0];
        const meta = JSON.parse(first);
        if (meta.type !== 'session_meta') continue;
        const cwd = meta.payload?.cwd || '';

        let firstUserMsg = '';
        const fd = fs.openSync(f.fp, 'r');
        const buf = Buffer.alloc(16384);
        const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
        fs.closeSync(fd);
        const partial = buf.toString('utf8', 0, bytesRead);
        for (const line of partial.split('\n')) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line);
            if (e.type === 'response_item' && e.payload?.role === 'user' && !firstUserMsg) {
              const text = (e.payload.content || []).find(c => c.type === 'input_text')?.text;
              if (text) firstUserMsg = text.slice(0, 200);
            }
          } catch {}
        }

        if (!firstUserMsg) continue;

        all.push({
          agentId: 'codex',
          id: f.id,
          cwd,
          project: cwd.split('/').filter(Boolean).slice(-2).join('/'),
          firstMessage: firstUserMsg,
          model: null,
          createdAt: new Date(f.birthtime).toISOString(),
          updatedAt: new Date(f.mtime).toISOString(),
          sizeMB: (f.size / 1048576).toFixed(1),
        });
      } catch {}
    }
  } catch {}

  // OpenCode: scan SQLite database for sessions
  const openCodeDbPath = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  if (fs.existsSync(openCodeDbPath)) {
    try {
      const sessionsJson = execSync(
        `sqlite3 -json "${openCodeDbPath}" "SELECT id, directory, time_created, time_updated FROM session ORDER BY time_updated DESC LIMIT 50" 2>/dev/null`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      if (sessionsJson && sessionsJson !== '[]') {
        const sessions = JSON.parse(sessionsJson);
        for (const sess of sessions) {
          const cwd = sess.directory || '';
          let firstUserMsg = '';
          try {
            const msgsJson = execSync(
              `sqlite3 -json "${openCodeDbPath}" "SELECT m.data as mdata, p.data as pdata FROM message m LEFT JOIN part p ON p.message_id = m.id WHERE m.session_id='${sess.id}' ORDER BY m.time_created ASC LIMIT 20" 2>/dev/null`,
              { encoding: 'utf8', timeout: 5000 }
            ).trim();
            if (msgsJson && msgsJson !== '[]') {
              const rows = JSON.parse(msgsJson);
              for (const row of rows) {
                if (firstUserMsg) break;
                try {
                  const mdata = typeof row.mdata === 'string' ? JSON.parse(row.mdata) : row.mdata;
                  if (mdata?.role !== 'user') continue;
                  const pdata = typeof row.pdata === 'string' ? JSON.parse(row.pdata) : row.pdata;
                  if (pdata?.type === 'text' && pdata.text?.trim()) {
                    firstUserMsg = pdata.text.trim().slice(0, 200);
                  }
                } catch {}
              }
            }
          } catch {}

          if (!firstUserMsg) continue;

          all.push({
            agentId: 'opencode',
            id: sess.id,
            cwd,
            project: cwd ? path.basename(cwd) : 'unknown',
            firstMessage: firstUserMsg,
            model: null,
            createdAt: sess.time_created ? new Date(sess.time_created).toISOString() : new Date().toISOString(),
            updatedAt: sess.time_updated ? new Date(sess.time_updated).toISOString() : new Date().toISOString(),
            sizeMB: '0.0',
          });
        }
      }
    } catch {}
  }

  // Sort all sessions by last modified, most recent first
  all.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return all.slice(0, limit);
}

module.exports = {
  AGENT_DEFS,
  findClaudeSessionFile,
  parseClaudeSession,
  findCodexSessionFile,
  parseCodexSession,
  parseOpenCodeSession,
  listClaudeSessions,
  listCodexSessions,
  listAllRecentSessions,
};
