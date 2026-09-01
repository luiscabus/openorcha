// Initiative templates.
//
// The stage pipeline is not one shape. Measured across real sessions, the work
// splits into a handful of recognisable kinds — reviewing a PR, turning a spec
// into tickets, taking a ticket to a PR, spiking, and plain discovery — and
// each wants different stages, a different autonomy profile, and a different
// place to fan out. A template is that shape, stored as data so it can be
// edited without touching code.

const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = process.env.OPENORCHA_TEMPLATES_DIR
  || path.join(__dirname, '..', 'data', 'initiative-templates');

function readJson(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeTemplate(raw, filename) {
  if (!raw || !Array.isArray(raw.stages) || !raw.stages.length) return null;
  return {
    id: raw.id || filename,
    name: raw.name || filename,
    summary: raw.summary || '',
    when: raw.when || '',
    profile: raw.profile || 'standard',
    maxParallel: Number.isFinite(raw.maxParallel) ? raw.maxParallel : 3,
    fanOutStage: raw.fanOutStage || null,
    fanOutHint: raw.fanOutHint || '',
    stages: raw.stages.map((s, i) => ({
      id: s.id || `stage-${i + 1}`,
      name: s.name || `Stage ${i + 1}`,
      instruction: s.instruction || '',
      check: s.check || null,
      maxNudges: Number.isFinite(s.maxNudges) ? s.maxNudges : 5,
    })),
  };
}

function list() {
  try {
    return fs.readdirSync(TEMPLATES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => normalizeTemplate(readJson(path.join(TEMPLATES_DIR, f)), path.basename(f, '.json')))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function get(id) {
  return list().find(t => t.id === id) || null;
}

/**
 * Apply a template to the fields an initiative is created with.
 * Anything the caller set explicitly wins over the template's default.
 */
function applyTo(data) {
  const template = data?.template ? get(data.template) : null;
  if (!template) return data;
  return {
    ...data,
    template: template.id,
    profile: data.profile || template.profile,
    maxParallel: Number.isFinite(data.maxParallel) ? data.maxParallel : template.maxParallel,
    stages: Array.isArray(data.stages) && data.stages.length ? data.stages : template.stages,
  };
}

module.exports = { TEMPLATES_DIR, list, get, applyTo, normalizeTemplate };
