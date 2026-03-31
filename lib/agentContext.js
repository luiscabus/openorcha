const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const { listAllTasks } = require('./claudeTasks');
const { listFileChanges } = require('./claudeDiffs');
const { parseHistory } = require('./claudeHistory');

// ─── File reading helpers ────────────────────────────────────────────────────

function shellEscapeGit(str) {
  return "'" + String(str).replace(/'/g, "'\\''") + "'";
}

function readJsonSafe(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function readTextSafe(fp) {
  try { return fs.readFileSync(fp, 'utf8'); } catch { return null; }
}

function readTomlSafe(fp) {
  try {
    const text = fs.readFileSync(fp, 'utf8');
    // Simple TOML parser for flat + section keys
    const result = {};
    let section = null;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const secMatch = trimmed.match(/^\[(.+)\]$/);
      if (secMatch) { section = secMatch[1]; result[section] = result[section] || {}; continue; }
      const kvMatch = trimmed.match(/^([\w.-]+)\s*=\s*"?(.*?)"?\s*$/);
      if (kvMatch) {
        const target = section ? (result[section] = result[section] || {}) : result;
        target[kvMatch[1]] = kvMatch[2];
      }
    }
    return result;
  } catch { return null; }
}

// ─── Git helpers ─────────────────────────────────────────────────────────────

function runGit(cwd, args) {
  return execSync(`git -C ${shellEscapeGit(cwd)} ${args}`, {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function getGitInfo(cwd) {
  if (!cwd) return { isRepo: false, note: 'No working directory found for this session.' };

  try {
    const root = runGit(cwd, 'rev-parse --show-toplevel');
    const branch = runGit(cwd, 'branch --show-current') || 'HEAD';
    let upstream = '';
    try {
      upstream = runGit(cwd, 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}');
    } catch {}

    let ahead = 0;
    let behind = 0;
    if (upstream) {
      try {
        const counts = runGit(cwd, `rev-list --left-right --count ${shellEscapeGit(`${branch}...${upstream}`)}`);
        const [aheadStr, behindStr] = counts.split(/\s+/);
        ahead = parseInt(aheadStr, 10) || 0;
        behind = parseInt(behindStr, 10) || 0;
      } catch {}
    }

    const statusText = runGit(cwd, 'status --short');
    const files = statusText
      ? statusText.split('\n').filter(Boolean).map(line => ({
          code: line.slice(0, 2).trim() || '??',
          path: line.slice(3).trim(),
        }))
      : [];

    const stagedCount = files.filter(f => f.code[0] && f.code[0] !== '?').length;
    const untrackedCount = files.filter(f => f.code === '??').length;
    const changedCount = files.filter(f => f.code[1] && f.code[1] !== '?').length;

    return {
      isRepo: true,
      root,
      rootName: path.basename(root),
      branch,
      upstream,
      ahead,
      behind,
      stagedCount,
      changedCount,
      untrackedCount,
      files: files.slice(0, 80),
    };
  } catch {
    return { isRepo: false, note: 'This session is not inside a git repository.' };
  }
}

// ─── Agent context readers ───────────────────────────────────────────────────

function getClaudeContext(cwd) {
  const home = os.homedir();
  const sections = [];

  // Global settings
  const settings = readJsonSafe(path.join(home, '.claude', 'settings.json'));
  if (settings) {
    sections.push({
      title: 'Settings',
      scope: 'global',
      icon: 'settings',
      items: [
        { label: 'Model', value: settings.model || '—' },
        ...(settings.statusLine ? [{ label: 'Status Line', value: settings.statusLine.command ? 'Custom command' : settings.statusLine.type || 'enabled' }] : []),
      ],
    });
  }

  // Global stats
  const stats = readJsonSafe(path.join(home, '.claude', 'stats-cache.json'));
  if (stats) {
    const models = stats.modelUsage ? Object.keys(stats.modelUsage) : [];
    sections.push({
      title: 'Usage Stats',
      scope: 'global',
      icon: 'chart',
      items: [
        { label: 'Total Sessions', value: String(stats.totalSessions || 0) },
        { label: 'Total Messages', value: String(stats.totalMessages || 0) },
        { label: 'First Session', value: stats.firstSessionDate ? new Date(stats.firstSessionDate).toLocaleDateString() : '—' },
        { label: 'Models Used', value: models.map(m => m.replace('claude-', '').replace(/-\d{8}$/, '')).join(', ') || '—' },
      ],
    });
  }

  // Active MCP Servers — actually configured and usable
  const activeServers = [];

  // Helper: extract servers from a .mcp.json (handles mcpServers wrapper or flat)
  function extractMcpServers(data) {
    if (!data) return {};
    if (data.mcpServers && typeof data.mcpServers === 'object') return data.mcpServers;
    // Flat format (keys are server names directly)
    const result = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'object' && v !== null) result[k] = v;
    }
    return result;
  }

  // 1. OAuth-connected servers (claude.ai integrations)
  const mcpAuth = readJsonSafe(path.join(home, '.claude', 'mcp-needs-auth-cache.json'));
  if (mcpAuth) {
    for (const name of Object.keys(mcpAuth)) {
      activeServers.push({ name, type: 'oauth', source: 'claude.ai', scope: 'global', disabled: false });
    }
  }

  // 2. Project-level .mcp.json (configured for this project)
  if (cwd) {
    const projectMcpRaw = readJsonSafe(path.join(cwd, '.mcp.json'));
    const projectMcp = extractMcpServers(projectMcpRaw);
    for (const [name, conf] of Object.entries(projectMcp)) {
      activeServers.push({ name, type: conf.type || '—', source: '.mcp.json', scope: 'project', disabled: !!conf.disabled });
    }
  }

  // 3. Global .mcp.json (user-configured globally)
  const globalMcpRaw = readJsonSafe(path.join(home, '.claude', '.mcp.json'));
  const globalMcp = extractMcpServers(globalMcpRaw);
  for (const [name, conf] of Object.entries(globalMcp)) {
    activeServers.push({ name, type: conf.type || '—', source: '~/.claude/.mcp.json', scope: 'global', disabled: !!conf.disabled });
  }

  if (activeServers.length) {
    sections.push({
      title: 'Active MCP Servers',
      scope: activeServers.some(s => s.scope === 'project') ? 'mixed' : 'global',
      icon: 'plug',
      servers: activeServers,
    });
  }

  // Available marketplace plugins (downloaded, not necessarily active)
  const availablePlugins = [];
  const pluginsDir = path.join(home, '.claude', 'plugins', 'marketplaces');
  try {
    const marketplaces = fs.readdirSync(pluginsDir);
    for (const mp of marketplaces) {
      const extDir = path.join(pluginsDir, mp, 'external_plugins');
      if (!fs.existsSync(extDir)) continue;
      for (const plugin of fs.readdirSync(extDir)) {
        const mcpFile = path.join(extDir, plugin, '.mcp.json');
        const pluginMeta = readJsonSafe(path.join(extDir, plugin, '.claude-plugin', 'plugin.json'));
        const mcp = readJsonSafe(mcpFile);
        const isActive = activeServers.some(s => s.name === plugin || s.source === plugin);
        availablePlugins.push({
          name: pluginMeta?.name || plugin,
          description: pluginMeta?.description || '',
          hasMcp: !!mcp,
          active: isActive,
        });
      }
    }
  } catch {}

  // Also check built-in plugins (non-external)
  const builtinDir = path.join(pluginsDir, 'claude-plugins-official', 'plugins');
  try {
    for (const plugin of fs.readdirSync(builtinDir)) {
      const pluginMeta = readJsonSafe(path.join(builtinDir, plugin, '.claude-plugin', 'plugin.json'));
      if (pluginMeta) {
        availablePlugins.push({
          name: pluginMeta.name || plugin,
          description: pluginMeta.description || '',
          hasMcp: false,
          active: false,
          builtin: true,
        });
      }
    }
  } catch {}

  if (availablePlugins.length) {
    sections.push({
      title: 'Marketplace Plugins',
      scope: 'global',
      icon: 'block',
      plugins: availablePlugins,
    });
  }

  // Blocked plugins
  const blocklist = readJsonSafe(path.join(home, '.claude', 'plugins', 'blocklist.json'));
  if (blocklist && Array.isArray(blocklist) && blocklist.length) {
    sections.push({
      title: 'Blocked Plugins',
      scope: 'global',
      icon: 'block',
      items: blocklist.map(b => ({
        label: typeof b === 'string' ? b : b.name || b.id || JSON.stringify(b),
        value: typeof b === 'object' && b.reason ? b.reason : '',
      })),
    });
  }

  // CLAUDE.md files — project root, parent directories, and global
  // Claude Code loads CLAUDE.md from cwd up to the git root (or home), plus ~/.claude/CLAUDE.md
  const claudeMdFiles = [];
  if (cwd) {
    // Find git root to know where to stop scanning
    let gitRoot = null;
    try { gitRoot = runGit(cwd, 'rev-parse --show-toplevel'); } catch {}

    // Walk from cwd upward to git root (or home)
    const stopAt = gitRoot || home;
    let dir = cwd;
    while (true) {
      const filePath = path.join(dir, 'CLAUDE.md');
      const content = readTextSafe(filePath);
      if (content) {
        const rel = dir === cwd ? 'CLAUDE.md' : path.relative(cwd, filePath);
        claudeMdFiles.push({ title: rel, scope: 'project', path: filePath, content });
      }
      // Also check .claude/CLAUDE.md in project directories
      const dotClaudeMd = readTextSafe(path.join(dir, '.claude', 'CLAUDE.md'));
      if (dotClaudeMd) {
        const rel = path.relative(cwd, path.join(dir, '.claude', 'CLAUDE.md'));
        claudeMdFiles.push({ title: rel, scope: 'project', path: path.join(dir, '.claude', 'CLAUDE.md'), content: dotClaudeMd });
      }
      if (dir === stopAt || dir === '/') break;
      dir = path.dirname(dir);
    }
  }

  // Global ~/.claude/CLAUDE.md
  const globalClaudeMd = readTextSafe(path.join(home, '.claude', 'CLAUDE.md'));
  if (globalClaudeMd) {
    claudeMdFiles.push({ title: '~/.claude/CLAUDE.md', scope: 'global', path: path.join(home, '.claude', 'CLAUDE.md'), content: globalClaudeMd });
  }

  for (const f of claudeMdFiles) {
    sections.push({ title: f.title, scope: f.scope, icon: 'doc', content: f.content });
  }

  // Memory (project)
  if (cwd) {
    const encoded = cwd.replace(/\//g, '-');
    const memDir = path.join(home, '.claude', 'projects', encoded, 'memory');
    const memoryMd = readTextSafe(path.join(home, '.claude', 'projects', encoded, 'MEMORY.md'));
    const memories = [];
    try {
      for (const f of fs.readdirSync(memDir)) {
        if (!f.endsWith('.md')) continue;
        const content = readTextSafe(path.join(memDir, f));
        if (content) {
          // Parse frontmatter
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)/);
          if (fmMatch) {
            const meta = {};
            for (const line of fmMatch[1].split('\n')) {
              const kv = line.match(/^(\w+):\s*(.+)/);
              if (kv) meta[kv[1]] = kv[2];
            }
            memories.push({ file: f, name: meta.name || f, type: meta.type || '—', description: meta.description || '', body: fmMatch[2].trim() });
          } else {
            memories.push({ file: f, name: f, type: '—', body: content.trim() });
          }
        }
      }
    } catch {}
    if (memories.length || memoryMd) {
      sections.push({ title: 'Memory', scope: 'project', icon: 'brain', memories, index: memoryMd || null });
    }
  }

  return sections;
}

function getCodexContext(cwd) {
  const home = os.homedir();
  const sections = [];
  const config = readTomlSafe(path.join(home, '.codex', 'config.toml'));
  if (config) {
    const items = [];
    if (config.personality) items.push({ label: 'Personality', value: config.personality });
    if (config.model) items.push({ label: 'Model', value: config.model });
    if (config.model_reasoning_effort) items.push({ label: 'Reasoning Effort', value: config.model_reasoning_effort });

    // Trusted projects
    const trusted = Object.entries(config).filter(([k]) => k.startsWith('projects.'));
    if (trusted.length) {
      items.push({ label: 'Trusted Projects', value: trusted.map(([k]) => path.basename(k.replace('projects.', '').replace(/"/g, ''))).join(', ') });
    }
    sections.push({ title: 'Settings', scope: 'global', icon: 'settings', items });
  }

  // AGENTS.md
  if (cwd) {
    const agentsMd = readTextSafe(path.join(cwd, 'AGENTS.md'));
    if (agentsMd && agentsMd.trim()) {
      sections.push({ title: 'AGENTS.md', scope: 'project', icon: 'doc', content: agentsMd });
    }
  }

  return sections;
}

function getGeminiContext(cwd) {
  const home = os.homedir();
  const sections = [];
  const settings = readJsonSafe(path.join(home, '.gemini', 'settings.json'));
  if (settings) {
    const items = [];
    if (settings.security?.auth?.selectedType) items.push({ label: 'Auth', value: settings.security.auth.selectedType });
    if (settings.general?.previewFeatures != null) items.push({ label: 'Preview Features', value: String(settings.general.previewFeatures) });
    sections.push({ title: 'Settings', scope: 'global', icon: 'settings', items });
  }

  // GEMINI.md
  const geminiMd = readTextSafe(path.join(home, '.gemini', 'GEMINI.md'));
  if (geminiMd && geminiMd.trim()) {
    sections.push({ title: 'GEMINI.md', scope: 'global', icon: 'doc', content: geminiMd });
  }

  if (cwd) {
    const projectGemini = readTextSafe(path.join(cwd, 'GEMINI.md'));
    if (projectGemini && projectGemini.trim()) {
      sections.push({ title: 'GEMINI.md', scope: 'project', icon: 'doc', content: projectGemini });
    }
  }

  return sections;
}

function getClaudeDrawerExtras(cwd) {
  const home = os.homedir();
  const claudeDir = path.join(home, '.claude');
  const extras = [];

  // Recent tasks for this project
  try {
    const tasks = listAllTasks(claudeDir, { project: cwd })
      .filter(t => t.status === 'in_progress' || t.status === 'pending')
      .slice(0, 5);
    if (tasks.length) {
      extras.push({
        title: 'Recent Tasks',
        scope: 'project',
        icon: 'doc',
        drawerExtra: 'tasks',
        items: tasks.map(t => ({
          label: t.subject || 'Untitled',
          value: t.status,
        })),
      });
    }
  } catch {}

  // Recent file changes for this project
  try {
    const changes = listFileChanges(claudeDir, { project: cwd }).slice(0, 5);
    if (changes.length) {
      extras.push({
        title: 'Recent File Changes',
        scope: 'project',
        icon: 'doc',
        drawerExtra: 'diffs',
        items: changes.map(c => ({
          label: `${c.hash.slice(0, 8)} (${c.versions}v)`,
          value: c.preview.slice(0, 60),
        })),
      });
    }
  } catch {}

  // Recent activity for this project
  try {
    const historyPath = path.join(claudeDir, 'history.jsonl');
    const entries = parseHistory(historyPath, { project: cwd, limit: 5 });
    if (entries.length) {
      extras.push({
        title: 'Recent Activity',
        scope: 'project',
        icon: 'chart',
        drawerExtra: 'history',
        items: entries.map(e => ({
          label: (e.display || '').slice(0, 80),
          value: new Date(e.timestamp).toLocaleString(),
        })),
      });
    }
  } catch {}

  return extras;
}

module.exports = {
  readJsonSafe,
  readTextSafe,
  getGitInfo,
  getClaudeContext,
  getCodexContext,
  getGeminiContext,
  getClaudeDrawerExtras,
};
