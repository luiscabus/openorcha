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

function normalizeSessionMatchText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function claudePaneMatchScore(filePath, paneText) {
  const pane = normalizeSessionMatchText(paneText);
  if (!pane) return 0;

  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const snippets = [];

    for (let i = lines.length - 1; i >= 0 && snippets.length < 6; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (!['user', 'assistant'].includes(e.type) || !e.message) continue;
        const text = extractTextFromContent(e.message.content);
        const normalized = normalizeSessionMatchText(text);
        if (normalized.length >= 24) snippets.push(normalized.slice(0, 220));
      } catch {}
    }

    return snippets.reduce((best, snippet) => (
      snippet && pane.includes(snippet) ? Math.max(best, snippet.length) : best
    ), 0);
  } catch {}

  return 0;
}

function findClaudeSessionFile(cwd, pid, args = '', procStartOverride = null, paneText = '', options = {}) {
  const dir = options.sessionDir || path.join(os.homedir(), '.claude', 'projects', encodeCwdClaude(cwd));
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

  if (paneText) {
    const paneMatches = files
      .map(f => ({ ...f, paneScore: claudePaneMatchScore(f.fp, paneText) }))
      .filter(f => f.paneScore > 0)
      .sort((a, b) => b.paneScore - a.paneScore || b.mtime - a.mtime);
    if (paneMatches.length) return paneMatches[0].fp;
  }

  // Match the session file that belongs to this specific PID.
  // Strategy: prefer file created within 60s of process start (new session).
  // Fallback: file that was modified after process start but created before it
  // (auto-resumed / --continue session). Pick the one modified closest to proc start.
  if (pid) {
    try {
      const procStart = Number.isFinite(procStartOverride)
        ? procStartOverride
        : (() => {
            const lstartRaw = execSync(`ps -p ${pid} -o lstart= 2>/dev/null`, { encoding: 'utf8' }).trim();
            return lstartRaw ? new Date(lstartRaw).getTime() : NaN;
          })();
      if (Number.isFinite(procStart)) {

        // 1. File created after process start (new session)
        // Wide window because Claude doesn't create the JSONL until the user's first message
        const newSession = files
          .filter(f => f.birthtime >= procStart - 60000 && f.birthtime <= procStart + 600000)
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
          .filter(f => f.firstTsAfterStart > 0)
          .sort((a, b) => Math.abs(a.firstTsAfterStart - procStart) - Math.abs(b.firstTsAfterStart - procStart) || b.mtime - a.mtime);
        if (resumed.length) return resumed[0].fp;
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
function isCodexBoilerplateText(text) {
  if (!text) return true;
  if (CODEX_SKIP.some(pfx => text.startsWith(pfx))) return true;
  if (text.startsWith('<environment_context>')) return true;
  if (text.startsWith('<') && text.length > 300) return true;
  return false;
}

function extractCodexTexts(content) {
  const texts = [];
  for (const c of (content || [])) {
    if (c.type !== 'input_text' && c.type !== 'output_text') continue;
    const t = (c.text || '').trim();
    if (isCodexBoilerplateText(t)) continue;
    texts.push(t);
  }
  return texts;
}

function listCodexSessionFiles() {
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const files = [];
  const stack = [sessionsDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fp);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const stat = fs.statSync(fp);
        files.push({ fp, id: entry.name.replace('.jsonl', ''), birthtime: stat.birthtimeMs, mtime: stat.mtimeMs, size: stat.size });
      } catch {}
    }
  }

  return files.sort((a, b) => b.mtime - a.mtime);
}

function readCodexSessionMeta(filePath) {
  try {
    const first = fs.readFileSync(filePath, 'utf8').split('\n')[0];
    const meta = JSON.parse(first);
    if (meta.type !== 'session_meta') return null;
    return meta.payload || null;
  } catch {}
  return null;
}

function getProcessStartTime(pid) {
  if (!pid) return null;
  try {
    const lstartRaw = execSync(`ps -p ${pid} -o lstart= 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (!lstartRaw) return null;
    const ts = new Date(lstartRaw).getTime();
    return Number.isFinite(ts) ? ts : null;
  } catch {}
  return null;
}

function firstCodexTimestampAfter(filePath, thresholdMs) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!entry.timestamp) continue;
        const ts = new Date(entry.timestamp).getTime();
        if (Number.isFinite(ts) && ts >= thresholdMs) return ts;
      } catch {}
    }
  } catch {}
  return null;
}

function extractFirstCodexUserMessage(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type !== 'response_item' || e.payload?.role !== 'user') continue;
      const texts = extractCodexTexts(e.payload?.content || []);
      if (texts.length) return texts.join('\n\n').slice(0, 200);
    } catch {}
  }
  return '';
}

function findFirstCodexUserMessage(filePath, maxBytes = 131072) {
  try {
    const stat = fs.statSync(filePath);
    const limit = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(limit);
    const bytesRead = fs.readSync(fd, buf, 0, limit, 0);
    fs.closeSync(fd);

    const partial = buf.toString('utf8', 0, bytesRead);
    const partialLines = partial.split('\n');
    if (limit < stat.size) partialLines.pop();

    const partialHit = extractFirstCodexUserMessage(partialLines);
    if (partialHit || limit >= stat.size) return partialHit;

    return extractFirstCodexUserMessage(fs.readFileSync(filePath, 'utf8').split('\n'));
  } catch {}
  return '';
}

function codexPaneMatchScore(filePath, paneText) {
  const pane = normalizeSessionMatchText(paneText);
  if (!pane) return 0;

  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const snippets = [];

    for (let i = lines.length - 1; i >= 0 && snippets.length < 6; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.type !== 'response_item') continue;
        const role = e.payload?.role;
        if (!['user', 'assistant'].includes(role)) continue;
        const texts = extractCodexTexts(e.payload?.content || []);
        for (const text of texts.reverse()) {
          const normalized = normalizeSessionMatchText(text);
          if (normalized.length >= 24) snippets.push(normalized.slice(0, 220));
          if (snippets.length >= 6) break;
        }
      } catch {}
    }

    return snippets.reduce((best, snippet) => (
      snippet && pane.includes(snippet) ? Math.max(best, snippet.length) : best
    ), 0);
  } catch {}

  return 0;
}

function findCodexSessionFile(cwd, pid, args = '', procStartOverride = null, paneText = '', options = {}) {
  const files = options.files || listCodexSessionFiles();
  const m = args.match(/resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m) {
    const sessionId = m[1].toLowerCase();
    const hit = files.find(f => {
      const meta = readCodexSessionMeta(f.fp);
      return meta?.id?.toLowerCase() === sessionId || f.fp.toLowerCase().includes(sessionId);
    });
    if (hit) return hit.fp;
  }

  const candidates = files
    .map(f => ({ ...f, meta: readCodexSessionMeta(f.fp) }))
    .filter(f => f.meta?.cwd === cwd);
  if (!candidates.length) return null;

  if (paneText) {
    const paneMatches = candidates
      .map(f => ({ ...f, paneScore: codexPaneMatchScore(f.fp, paneText) }))
      .filter(f => f.paneScore > 0)
      .sort((a, b) => b.paneScore - a.paneScore || b.mtime - a.mtime);
    if (paneMatches.length) return paneMatches[0].fp;
  }

  const procStart = Number.isFinite(procStartOverride) ? procStartOverride : getProcessStartTime(pid);
  if (procStart) {
    const graceMs = 60000;
    const newSessionWindowMs = 60000;
    const newSession = candidates
      .map(f => {
        const metaTs = f.meta?.timestamp ? new Date(f.meta.timestamp).getTime() : null;
        const score = [f.birthtime, metaTs].filter(Number.isFinite)
          .map(ts => Math.abs(ts - procStart))
          .sort((a, b) => a - b)[0];
        return { ...f, metaTs, score: Number.isFinite(score) ? score : Infinity };
      })
      .filter(f => (
        (Number.isFinite(f.birthtime) && f.birthtime >= procStart - graceMs && f.birthtime <= procStart + newSessionWindowMs) ||
        (Number.isFinite(f.metaTs) && f.metaTs >= procStart - graceMs && f.metaTs <= procStart + newSessionWindowMs)
      ))
      .sort((a, b) => a.score - b.score || a.birthtime - b.birthtime);
    if (newSession.length) return newSession[0].fp;

    // Resumed sessions keep writing to an older JSONL file. Match the file whose
    // first post-start event is closest to this process start time.
    const resumed = candidates
      .map(f => {
        const metaTs = f.meta?.timestamp ? new Date(f.meta.timestamp).getTime() : null;
        const firstTsAfterStart = firstCodexTimestampAfter(f.fp, procStart - graceMs);
        const score = Number.isFinite(firstTsAfterStart) ? Math.abs(firstTsAfterStart - procStart) : Infinity;
        const paneScore = codexPaneMatchScore(f.fp, paneText);
        return { ...f, metaTs, firstTsAfterStart, score, paneScore };
      })
      .filter(f => {
        const startedBeforeProc =
          (Number.isFinite(f.birthtime) && f.birthtime < procStart - graceMs) ||
          (Number.isFinite(f.metaTs) && f.metaTs < procStart - graceMs);
        return startedBeforeProc && Number.isFinite(f.firstTsAfterStart);
      })
      .sort((a, b) => b.paneScore - a.paneScore || a.score - b.score || a.firstTsAfterStart - b.firstTsAfterStart || b.mtime - a.mtime);
    if (resumed.length) return resumed[0].fp;

    // For a plain fresh `codex` launch with no explicit resume target, avoid
    // inheriting an unrelated older session from the same cwd.
    return null;
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  if (candidates.length) return candidates[0].fp;
  return null;
}

function parseCodexSession(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const messages = [];
  const sessionMeta = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheRead: 0,
    lastContextTokens: 0,
    model: null,
    modelContextWindow: null,
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'turn_context') {
        if (e.payload?.model) sessionMeta.model = e.payload.model;
        continue;
      }
      if (e.type === 'event_msg' && e.payload?.type === 'task_started') {
        if (Number.isFinite(e.payload.model_context_window)) {
          sessionMeta.modelContextWindow = e.payload.model_context_window;
        }
        continue;
      }
      if (e.type === 'event_msg' && e.payload?.type === 'token_count') {
        const info = e.payload.info || {};
        const totalUsage = info.total_token_usage || {};
        const lastUsage = info.last_token_usage || {};

        sessionMeta.totalInputTokens = totalUsage.input_tokens || sessionMeta.totalInputTokens || 0;
        sessionMeta.totalOutputTokens = (totalUsage.output_tokens || 0) + (totalUsage.reasoning_output_tokens || 0);
        sessionMeta.totalCacheRead = totalUsage.cached_input_tokens || sessionMeta.totalCacheRead || 0;

        const lastPromptTokens = (lastUsage.input_tokens || 0) + (lastUsage.cached_input_tokens || 0);
        if (lastPromptTokens) sessionMeta.lastContextTokens = lastPromptTokens;
        if (Number.isFinite(info.model_context_window)) {
          sessionMeta.modelContextWindow = info.model_context_window;
        }
        continue;
      }
      if (e.type !== 'response_item') continue;
      const p = e.payload;
      if (!['user', 'assistant'].includes(p.role)) continue;
      const texts = extractCodexTexts(p.content);
      const tools = [];
      for (const c of (p.content || [])) {
        if (c.type === 'function_call' || c.type === 'tool_call') {
          tools.push({ name: c.name || 'tool', input: c.arguments || c.parameters });
        }
      }
      if (texts.length) {
        messages.push({ role: p.role, text: texts.join('\n\n'), tools, timestamp: e.timestamp || null });
      }
    } catch {}
  }
  return { messages, sessionMeta };
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
    const recentMessages = [];
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
            const text = extractTextFromContent(e.message.content);
            if (text) {
              recentMessages.push({ role: 'user', text: text.slice(0, 220) });
              if (recentMessages.length > 2) recentMessages.shift();
            }
          } else if (e.type === 'assistant' && e.message?.role === 'assistant') {
            messageCount++;
            if (e.message.model) model = e.message.model;
            const text = extractTextFromContent(e.message.content);
            if (text) {
              recentMessages.push({ role: 'assistant', text: text.slice(0, 220) });
              if (recentMessages.length > 2) recentMessages.shift();
            }
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
      recentMessages,
      createdAt: new Date(f.birthtime).toISOString(),
      updatedAt: new Date(f.mtime).toISOString(),
      sizeMB: (f.size / 1048576).toFixed(1),
    };
  });
}

function listCodexSessions(cwd) {
  const sessions = [];
  try {
    const files = listCodexSessionFiles().slice(0, 200);

    for (const f of files) {
      try {
        const meta = readCodexSessionMeta(f.fp);
        if (!meta || meta.cwd !== cwd) continue;

        // Count messages and get first user message
        let firstUserMsg = '';
        let messageCount = 0;
        const recentMessages = [];
        const lines = fs.readFileSync(f.fp, 'utf8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line);
            if (e.type !== 'response_item') continue;
            const role = e.payload?.role;
            if (!['user', 'assistant'].includes(role)) continue;
            const texts = extractCodexTexts(e.payload.content || []);
            const text = texts.join('\n\n').trim();
            messageCount++;
            if (!firstUserMsg && role === 'user' && text) {
              firstUserMsg = text.slice(0, 200);
            }
            if (text) {
              recentMessages.push({ role, text: text.slice(0, 220) });
              if (recentMessages.length > 2) recentMessages.shift();
            }
          } catch {}
        }

        sessions.push({
          id: f.id,
          firstMessage: firstUserMsg || '(empty session)',
          messageCount,
          recentMessages,
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
    if (fs.existsSync(codexDir)) {
      const files = listCodexSessionFiles();

      for (const f of files) {
        try {
          const meta = readCodexSessionMeta(f.fp);
          if (!meta) continue;
          const cwd = meta.cwd || '';

          const firstUserMsg = findFirstCodexUserMessage(f.fp);
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
