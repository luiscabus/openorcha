const express = require('express');
const path = require('path');
const os = require('os');
const router = express.Router();

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// ─── Settings ────────────────────────────────────────────────────────────────
const { getGlobalSettings, getProjectList, getProjectSettings, writeSettings } = require('../lib/claudeSettings');

router.get('/settings', (req, res) => {
  try {
    const global = getGlobalSettings(CLAUDE_DIR);
    const projects = getProjectList(CLAUDE_DIR);
    res.json({ global, projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/settings/:project', (req, res) => {
  try {
    const result = getProjectSettings(CLAUDE_DIR, req.params.project);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/settings/global', (req, res) => {
  try {
    const content = typeof req.body === 'string' ? req.body : JSON.stringify(req.body, null, 2);
    writeSettings(path.join(CLAUDE_DIR, 'settings.json'), content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/settings/:project', (req, res) => {
  try {
    const content = typeof req.body === 'string' ? req.body : JSON.stringify(req.body, null, 2);
    writeSettings(path.join(CLAUDE_DIR, 'projects', req.params.project, 'settings.json'), content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/settings/:project/local', (req, res) => {
  try {
    const content = typeof req.body === 'string' ? req.body : JSON.stringify(req.body, null, 2);
    writeSettings(path.join(CLAUDE_DIR, 'projects', req.params.project, 'settings.local.json'), content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
