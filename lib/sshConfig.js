const fs = require('fs');
const path = require('path');
const os = require('os');

const SSH_DIR = path.join(os.homedir(), '.ssh');
const CONFIG_FILE = path.join(SSH_DIR, 'config');
const KNOWN_HOSTS_FILE = path.join(SSH_DIR, 'known_hosts');

function parseSSHConfig(content) {
  const blocks = [];
  let current = null;
  let globalLines = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      if (current) current.comments.push(line);
      else globalLines.push(line);
      continue;
    }

    const match = trimmed.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, key, value] = match;

    if (key.toLowerCase() === 'host') {
      current = { Host: value, options: {}, comments: [], raw: [] };
      blocks.push(current);
    } else if (key.toLowerCase() === 'include' && !current) {
      globalLines.push(line);
    } else if (current) {
      current.options[key] = value;
      current.raw.push(line);
    } else {
      globalLines.push(line);
    }
  }

  return { blocks, globalLines };
}

function serializeSSHConfig(blocks, globalLines) {
  const parts = [];

  for (const line of globalLines) {
    parts.push(line);
  }

  if (globalLines.length > 0 && blocks.length > 0) parts.push('');

  for (const block of blocks) {
    for (const comment of block.comments) {
      parts.push(comment);
    }
    parts.push(`Host ${block.Host}`);
    for (const [key, value] of Object.entries(block.options)) {
      parts.push(`    ${key} ${value}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { blocks: [], globalLines: [] };
  return parseSSHConfig(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function writeConfig(blocks, globalLines) {
  fs.writeFileSync(CONFIG_FILE, serializeSSHConfig(blocks, globalLines), 'utf8');
}

module.exports = {
  SSH_DIR,
  CONFIG_FILE,
  KNOWN_HOSTS_FILE,
  parseSSHConfig,
  serializeSSHConfig,
  readConfig,
  writeConfig,
};
