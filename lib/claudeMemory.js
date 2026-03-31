const fs = require('fs');
const path = require('path');
const { readJsonSafe, decodeFolderName } = require('./claudeSettings');

function readTextSafe(fp) {
  try { return fs.readFileSync(fp, 'utf8'); } catch { return null; }
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)/);
  if (!match) return { meta: {}, body: content.trim() };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: match[2].trim() };
}

function listProjects(claudeDir) {
  const projectsDir = path.join(claudeDir, 'projects');
  const results = [];
  try {
    for (const name of fs.readdirSync(projectsDir)) {
      if (name.startsWith('.')) continue;
      const dir = path.join(projectsDir, name);
      let stat;
      try { stat = fs.statSync(dir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const memDir = path.join(dir, 'memory');
      let memoryCount = 0;
      try {
        memoryCount = fs.readdirSync(memDir).filter(f => f.endsWith('.md')).length;
      } catch {}
      const hasClaudeMd = fs.existsSync(path.join(dir, 'CLAUDE.md'));
      const hasMemoryMd = fs.existsSync(path.join(dir, 'MEMORY.md'));
      if (memoryCount === 0 && !hasClaudeMd && !hasMemoryMd) continue;
      results.push({
        encoded: name,
        decoded: decodeFolderName(name),
        memoryCount,
        hasClaudeMd,
        hasMemoryMd,
      });
    }
  } catch {}
  return results;
}

function getProjectMemory(claudeDir, projectEncoded) {
  const dir = path.join(claudeDir, 'projects', projectEncoded);
  const claudeMd = readTextSafe(path.join(dir, 'CLAUDE.md'));
  const memoryMd = readTextSafe(path.join(dir, 'MEMORY.md'));
  const memories = [];
  const memDir = path.join(dir, 'memory');
  try {
    for (const f of fs.readdirSync(memDir)) {
      if (!f.endsWith('.md')) continue;
      const content = readTextSafe(path.join(memDir, f));
      if (!content) continue;
      const { meta, body } = parseFrontmatter(content);
      memories.push({
        file: f,
        name: meta.name || f.replace('.md', ''),
        description: meta.description || '',
        type: meta.type || 'unknown',
        body,
      });
    }
  } catch {}
  return { claudeMd, memoryMd, memories };
}

function writeClaudeMd(claudeDir, projectEncoded, content) {
  const fp = path.join(claudeDir, 'projects', projectEncoded, 'CLAUDE.md');
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, 'utf8');
}

function writeMemoryMd(claudeDir, projectEncoded, content) {
  const fp = path.join(claudeDir, 'projects', projectEncoded, 'MEMORY.md');
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, 'utf8');
}

function writeMemoryFile(claudeDir, projectEncoded, filename, content) {
  const fp = path.join(claudeDir, 'projects', projectEncoded, 'memory', filename);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, 'utf8');
}

function createMemoryFile(claudeDir, projectEncoded, { name, description, type, body }) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
  const filename = `${type}_${slug}.md`;
  const content = `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`;
  writeMemoryFile(claudeDir, projectEncoded, filename, content);
  return filename;
}

function deleteMemoryFile(claudeDir, projectEncoded, filename) {
  const fp = path.join(claudeDir, 'projects', projectEncoded, 'memory', filename);
  fs.unlinkSync(fp);
}

module.exports = {
  listProjects,
  getProjectMemory,
  writeClaudeMd,
  writeMemoryMd,
  writeMemoryFile,
  createMemoryFile,
  deleteMemoryFile,
};
