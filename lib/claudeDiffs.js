const fs = require('fs');
const path = require('path');
const { structuredPatch } = require('diff');

function readTextSafe(fp) {
  try { return fs.readFileSync(fp, 'utf8'); } catch { return null; }
}

function readJsonSafe(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function buildSessionProjectMap(claudeDir) {
  const map = {};
  const sessDir = path.join(claudeDir, 'sessions');
  try {
    for (const f of fs.readdirSync(sessDir)) {
      if (!f.endsWith('.json')) continue;
      const data = readJsonSafe(path.join(sessDir, f));
      if (data && data.sessionId) map[data.sessionId] = data.cwd || '';
    }
  } catch {}
  return map;
}

function listFileChanges(claudeDir, { project } = {}) {
  const fileHistDir = path.join(claudeDir, 'file-history');
  const sessionProjectMap = buildSessionProjectMap(claudeDir);
  const results = [];

  try {
    for (const sessionId of fs.readdirSync(fileHistDir)) {
      const sessDir = path.join(fileHistDir, sessionId);
      let stat;
      try { stat = fs.statSync(sessDir); } catch { continue; }
      if (!stat.isDirectory()) continue;

      const sessionProject = sessionProjectMap[sessionId] || '';
      if (project && sessionProject !== project) continue;

      const byHash = {};
      try {
        for (const f of fs.readdirSync(sessDir)) {
          const match = f.match(/^([a-f0-9]+)@v(\d+)$/);
          if (!match) continue;
          const hash = match[1];
          const version = parseInt(match[2]);
          if (!byHash[hash]) byHash[hash] = [];
          byHash[hash].push({ version, file: f });
        }
      } catch { continue; }

      for (const [hash, versions] of Object.entries(byHash)) {
        versions.sort((a, b) => a.version - b.version);
        const latestFile = versions[versions.length - 1].file;
        const content = readTextSafe(path.join(sessDir, latestFile)) || '';
        const firstLine = content.split('\n')[0] || '';

        let mtime = 0;
        try {
          mtime = fs.statSync(path.join(sessDir, latestFile)).mtimeMs;
        } catch {}

        results.push({
          hash,
          sessionId,
          project: sessionProject,
          versions: versions.length,
          latestVersion: versions[versions.length - 1].version,
          preview: firstLine.slice(0, 120),
          mtime,
        });
      }
    }
  } catch {}

  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

function getVersionDiff(claudeDir, sessionId, hash, fromVersion, toVersion) {
  const sessDir = path.join(claudeDir, 'file-history', sessionId);
  const oldContent = fromVersion > 0
    ? readTextSafe(path.join(sessDir, `${hash}@v${fromVersion}`)) || ''
    : '';
  const newContent = readTextSafe(path.join(sessDir, `${hash}@v${toVersion}`)) || '';

  const patch = structuredPatch(
    `v${fromVersion}`, `v${toVersion}`,
    oldContent, newContent,
    '', '', { context: 3 }
  );

  return {
    oldContent,
    newContent,
    hunks: patch.hunks,
  };
}

module.exports = { listFileChanges, getVersionDiff };
