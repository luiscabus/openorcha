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

// ─── Memory ──────────────────────────────────────────────────────────────────
const { listProjects, getProjectMemory, writeClaudeMd, writeMemoryMd, writeMemoryFile, createMemoryFile, deleteMemoryFile } = require('../lib/claudeMemory');

router.get('/memory', (req, res) => {
  try {
    res.json({ projects: listProjects(CLAUDE_DIR) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/memory/:project', (req, res) => {
  try {
    res.json(getProjectMemory(CLAUDE_DIR, req.params.project));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/memory/:project/claude-md', (req, res) => {
  try {
    writeClaudeMd(CLAUDE_DIR, req.params.project, req.body.content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/memory/:project/memory-md', (req, res) => {
  try {
    writeMemoryMd(CLAUDE_DIR, req.params.project, req.body.content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/memory/:project/file', (req, res) => {
  try {
    const filename = createMemoryFile(CLAUDE_DIR, req.params.project, req.body);
    res.json({ ok: true, filename });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/memory/:project/file/:filename', (req, res) => {
  try {
    writeMemoryFile(CLAUDE_DIR, req.params.project, req.params.filename, req.body.content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/memory/:project/file/:filename', (req, res) => {
  try {
    deleteMemoryFile(CLAUDE_DIR, req.params.project, req.params.filename);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── History ─────────────────────────────────────────────────────────────────
const { parseHistory, getSessions, getSessionDetail } = require('../lib/claudeHistory');

router.get('/history/activity', (req, res) => {
  try {
    const fp = path.join(CLAUDE_DIR, 'history.jsonl');
    const entries = parseHistory(fp, {
      project: req.query.project,
      search: req.query.search,
      limit: parseInt(req.query.limit) || 100,
      offset: parseInt(req.query.offset) || 0,
    });
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/history/sessions', (req, res) => {
  try {
    const sessions = getSessions(CLAUDE_DIR, {
      project: req.query.project,
      search: req.query.search,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0,
    });
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/history/:sessionId', (req, res) => {
  try {
    const fp = path.join(CLAUDE_DIR, 'history.jsonl');
    const entries = getSessionDetail(fp, req.params.sessionId);
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Tasks ───────────────────────────────────────────────────────────────────
const { listAllTasks, getSessionTasks, promoteTask } = require('../lib/claudeTasks');

router.get('/tasks', (req, res) => {
  try {
    const tasks = listAllTasks(CLAUDE_DIR, {
      status: req.query.status,
      project: req.query.project,
    });
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/tasks/:sessionId', (req, res) => {
  try {
    const tasks = getSessionTasks(CLAUDE_DIR, req.params.sessionId);
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tasks/:sessionId/:taskId/promote', (req, res) => {
  try {
    const todo = promoteTask(CLAUDE_DIR, req.params.sessionId, req.params.taskId);
    res.json(todo);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
