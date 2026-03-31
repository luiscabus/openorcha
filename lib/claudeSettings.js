const fs = require('fs');
const path = require('path');

function readJsonSafe(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function decodeFolderName(encoded) {
  return encoded.replace(/^-/, '/').replace(/-/g, '/');
}

function getGlobalSettings(claudeDir) {
  return readJsonSafe(path.join(claudeDir, 'settings.json')) || {};
}

function getProjectList(claudeDir) {
  const projectsDir = path.join(claudeDir, 'projects');
  const results = [];
  try {
    for (const name of fs.readdirSync(projectsDir)) {
      if (name.startsWith('.')) continue;
      const dir = path.join(projectsDir, name);
      const hasSetting = fs.existsSync(path.join(dir, 'settings.json'))
        || fs.existsSync(path.join(dir, 'settings.local.json'));
      if (hasSetting) {
        results.push({ encoded: name, decoded: decodeFolderName(name) });
      }
    }
  } catch {}
  return results;
}

function getProjectSettings(claudeDir, projectEncoded) {
  const dir = path.join(claudeDir, 'projects', projectEncoded);
  return {
    main: readJsonSafe(path.join(dir, 'settings.json')),
    local: readJsonSafe(path.join(dir, 'settings.local.json')),
  };
}

function writeSettings(filePath, content) {
  try {
    JSON.parse(content);
  } catch {
    throw new Error('Invalid JSON');
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

module.exports = { readJsonSafe, decodeFolderName, getGlobalSettings, getProjectList, getProjectSettings, writeSettings };
