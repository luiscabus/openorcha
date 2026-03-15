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

function findClaudeSessionFile(cwd, pid) {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwdClaude(cwd));
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      return { fp, birthtime: stat.birthtimeMs, mtime: stat.mtimeMs };
    });

  if (!files.length) return null;

  // When we have a pid, find the JSONL created closest to when this process started.
  // This correctly separates two agents running in the same directory.
  if (pid) {
    try {
      const lstartRaw = execSync(`ps -p ${pid} -o lstart= 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (lstartRaw) {
        const procStart = new Date(lstartRaw).getTime();
        // Files created at or after process start (with 60s tolerance for slow startups)
        const candidates = files
          .filter(f => f.birthtime >= procStart - 60000)
          .sort((a, b) => a.birthtime - b.birthtime); // oldest first = first session after start
        if (candidates.length) return candidates[0].fp;
        // Process started but no session file created yet (no conversation begun)
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
        // Find the tool_use_id from content
        const resultMap = extractToolResultsFromContent(msg.content);
        // Also capture toolUseResult (richer data from Claude)
        if (messages.length > 0) {
          const prev = messages[messages.length - 1];
          if (prev.role === 'assistant' && prev.tools?.length) {
            for (const tool of prev.tools) {
              if (tool.id && resultMap[tool.id] !== undefined) {
                tool.result = resultMap[tool.id];
              } else if (tool.id && Object.keys(resultMap).length === 0) {
                // toolUseResult from Claude's top-level field
                const tr = e.toolUseResult;
                if (tr) {
                  tool.result = tr.stdout || tr.content || '';
                  if (tr.stderr) tool.resultError = tr.stderr;
                }
              }
            }
            // If single tool and single result, match directly
            if (prev.tools.length === 1 && !prev.tools[0].result) {
              const tr = e.toolUseResult;
              if (tr) {
                prev.tools[0].result = tr.stdout || tr.content || '';
                if (tr.stderr) prev.tools[0].resultError = tr.stderr;
              }
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

module.exports = {
  AGENT_DEFS,
  findClaudeSessionFile,
  parseClaudeSession,
  findCodexSessionFile,
  parseCodexSession,
  parseOpenCodeSession,
};
