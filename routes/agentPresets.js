const express = require('express');
const path = require('path');
const fs = require('fs');
const { readJsonSafe } = require('../lib/agentContext');

const router = express.Router();

const PRESETS_DIR = path.join(__dirname, '..', 'data', 'agent-presets');
const LEGACY_PRESETS_FILE = path.join(__dirname, '..', 'data', 'agent-presets.json');

function ensurePresetsDir() {
  fs.mkdirSync(PRESETS_DIR, { recursive: true });
}

function slugifyPresetFilename(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'preset';
}

function isValidPresetFilename(filename) {
  return /^[a-z0-9][a-z0-9.-]*$/.test(filename || '');
}

function presetFilePath(filename) {
  return path.join(PRESETS_DIR, `${filename}.json`);
}

function normalizePresetData(preset) {
  const name = String(preset?.name || '').trim();
  const agent = String(preset?.agent || '').trim();
  return {
    name,
    agent,
    icon: preset?.icon || name[0]?.toUpperCase() || '?',
    color: preset?.color || '#818cf8',
    description: preset?.description || '',
    flags: preset?.flags || '',
  };
}

function readPresetFile(filePath) {
  const parsed = readJsonSafe(filePath);
  if (!parsed || typeof parsed !== 'object') return null;
  const preset = normalizePresetData(parsed);
  if (!preset.name || !preset.agent) return null;
  return { filename: path.basename(filePath, '.json'), ...preset };
}

function writePresetFile(filename, preset) {
  ensurePresetsDir();
  const normalized = normalizePresetData(preset);
  fs.writeFileSync(presetFilePath(filename), JSON.stringify(normalized, null, 2));
  return { filename, ...normalized };
}

function migrateLegacyPresets() {
  ensurePresetsDir();
  const hasPresetFiles = fs.readdirSync(PRESETS_DIR).some(f => f.endsWith('.json'));
  if (hasPresetFiles || !fs.existsSync(LEGACY_PRESETS_FILE)) return;

  const legacy = readJsonSafe(LEGACY_PRESETS_FILE);
  if (!Array.isArray(legacy)) return;

  for (const preset of legacy) {
    const filename = slugifyPresetFilename(preset?.name || preset?.id || 'preset');
    writePresetFile(filename, preset);
  }
}

function loadPresets() {
  ensurePresetsDir();
  migrateLegacyPresets();

  return fs.readdirSync(PRESETS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => readPresetFile(path.join(PRESETS_DIR, f)))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name) || a.filename.localeCompare(b.filename));
}

router.get('/', (req, res) => {
  res.json({ presets: loadPresets() });
});

router.post('/', (req, res) => {
  try {
    const { name, agent, icon, color, description, flags } = req.body;
    if (!name || !agent) return res.status(400).json({ error: 'name and agent are required' });

    const filename = slugifyPresetFilename(name);
    if (loadPresets().find(p => p.filename === filename)) {
      return res.status(400).json({ error: `Preset "${filename}" already exists` });
    }

    const preset = writePresetFile(filename, { name, agent, icon, color, description, flags });
    res.json({ preset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:filename', (req, res) => {
  try {
    const currentFilename = decodeURIComponent(req.params.filename);
    if (!isValidPresetFilename(currentFilename)) return res.status(400).json({ error: 'Invalid preset filename' });

    const existing = readPresetFile(presetFilePath(currentFilename));
    if (!existing) return res.status(404).json({ error: 'Preset not found' });

    const { name, agent, icon, color, description, flags } = req.body;
    const updated = {
      name: name !== undefined ? name : existing.name,
      agent: agent !== undefined ? agent : existing.agent,
      icon: icon !== undefined ? icon : existing.icon,
      color: color !== undefined ? color : existing.color,
      description: description !== undefined ? description : existing.description,
      flags: flags !== undefined ? flags : existing.flags,
    };

    if (!updated.name || !updated.agent) {
      return res.status(400).json({ error: 'name and agent are required' });
    }

    const nextFilename = slugifyPresetFilename(updated.name);
    if (nextFilename !== currentFilename && fs.existsSync(presetFilePath(nextFilename))) {
      return res.status(400).json({ error: `Preset "${nextFilename}" already exists` });
    }

    const preset = writePresetFile(nextFilename, updated);
    if (nextFilename !== currentFilename && fs.existsSync(presetFilePath(currentFilename))) {
      fs.unlinkSync(presetFilePath(currentFilename));
    }

    res.json({ preset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:filename', (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    if (!isValidPresetFilename(filename)) return res.status(400).json({ error: 'Invalid preset filename' });
    const filePath = presetFilePath(filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Preset not found' });
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, loadPresets };
