const express = require('express');
const fs = require('fs');
const { execSync } = require('child_process');
const { KNOWN_HOSTS_FILE } = require('../lib/sshConfig');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    if (!fs.existsSync(KNOWN_HOSTS_FILE)) return res.json({ entries: [] });
    const lines = fs.readFileSync(KNOWN_HOSTS_FILE, 'utf8').split('\n');
    const entries = lines
      .map((line, i) => ({ line: line.trimEnd(), index: i }))
      .filter(e => e.line && !e.line.startsWith('#'));
    res.json({ entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/', (req, res) => {
  try {
    const { host } = req.body;
    execSync(`ssh-keygen -R "${host}" 2>/dev/null || true`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
