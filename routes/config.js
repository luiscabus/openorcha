const express = require('express');
const fs = require('fs');
const { CONFIG_FILE, readConfig, writeConfig } = require('../lib/sshConfig');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const { blocks, globalLines } = readConfig();
    res.json({ blocks, globalLines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/raw', (req, res) => {
  try {
    const content = fs.existsSync(CONFIG_FILE)
      ? fs.readFileSync(CONFIG_FILE, 'utf8')
      : '';
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/raw', (req, res) => {
  try {
    const { content } = req.body;
    fs.writeFileSync(CONFIG_FILE, content, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/host', (req, res) => {
  try {
    const { Host, options, originalHost } = req.body;
    const { blocks, globalLines } = readConfig();

    const existingIdx = blocks.findIndex(b =>
      b.Host === (originalHost || Host)
    );

    if (existingIdx >= 0) {
      blocks[existingIdx] = { Host, options, comments: blocks[existingIdx].comments, raw: [] };
    } else {
      blocks.push({ Host, options, comments: [], raw: [] });
    }

    writeConfig(blocks, globalLines);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/host/:name', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const { blocks, globalLines } = readConfig();
    const filtered = blocks.filter(b => b.Host !== name);
    writeConfig(filtered, globalLines);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
