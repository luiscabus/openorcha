const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { SSH_DIR } = require('../lib/sshConfig');

const router = express.Router();

function getKeys() {
  if (!fs.existsSync(SSH_DIR)) return [];
  const files = fs.readdirSync(SSH_DIR);
  const pubFiles = files.filter(f => f.endsWith('.pub'));

  return pubFiles.map(pubFile => {
    const name = pubFile.replace('.pub', '');
    const pubPath = path.join(SSH_DIR, pubFile);
    const privPath = path.join(SSH_DIR, name);
    const pubContent = fs.readFileSync(pubPath, 'utf8').trim();
    const parts = pubContent.split(' ');
    const type = parts[0] || 'unknown';
    const comment = parts[2] || '';
    const stat = fs.statSync(pubPath);

    return {
      name,
      type,
      comment,
      publicKey: pubContent,
      hasPrivate: fs.existsSync(privPath),
      created: stat.birthtime,
      modified: stat.mtime,
      pubPath,
      privPath: fs.existsSync(privPath) ? privPath : null,
    };
  });
}

router.get('/', (req, res) => {
  try {
    res.json({ keys: getKeys() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/generate', (req, res) => {
  try {
    const { name, type = 'ed25519', comment = '', passphrase = '' } = req.body;
    if (!name || !/^[\w.-]+$/.test(name)) {
      return res.status(400).json({ error: 'Invalid key name' });
    }

    const keyPath = path.join(SSH_DIR, name);
    if (fs.existsSync(keyPath)) {
      return res.status(400).json({ error: `Key "${name}" already exists` });
    }

    const cmd = [
      'ssh-keygen',
      `-t ${type}`,
      type === 'rsa' ? '-b 4096' : '',
      `-f "${keyPath}"`,
      `-N "${passphrase}"`,
      comment ? `-C "${comment}"` : '',
    ].filter(Boolean).join(' ');

    execSync(cmd);
    res.json({ ok: true, keys: getKeys() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:name', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    if (!/^[\w.-]+$/.test(name)) {
      return res.status(400).json({ error: 'Invalid key name' });
    }

    const pubPath = path.join(SSH_DIR, `${name}.pub`);
    const privPath = path.join(SSH_DIR, name);

    if (fs.existsSync(pubPath)) fs.unlinkSync(pubPath);
    if (fs.existsSync(privPath)) fs.unlinkSync(privPath);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
