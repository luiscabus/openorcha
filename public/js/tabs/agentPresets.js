import { api, toast, escHtml, escAttr } from '../utils.js';

let launchPresets = [];
let launchSelectedPresetFile = null;

export function getSelectedPresetFile() {
  return launchSelectedPresetFile;
}

export function resetSelectedPresetFile() {
  launchSelectedPresetFile = null;
}

export async function renderPresetPicker() {
  const container = document.getElementById('launch-presets');
  try {
    const { presets } = await api('GET', '/api/agents/presets');
    launchPresets = presets;
    let html = `<div class="preset-chip preset-chip-none${!launchSelectedPresetFile ? ' preset-chip-selected' : ''}" onclick="window.selectPreset(null)">None</div>`;
    for (const p of presets) {
      const selected = launchSelectedPresetFile === p.filename ? ' preset-chip-selected' : '';
      html += `<div class="preset-chip${selected}" data-preset="${escAttr(p.filename)}" onclick="window.selectPreset('${escAttr(p.filename)}')" title="${escAttr(p.description || p.flags || '')}">
        <span class="preset-chip-icon" style="background:${escAttr(p.color)}20;color:${escAttr(p.color)}">${escHtml(p.icon)}</span>
        ${escHtml(p.name)}
      </div>`;
    }
    html += `<div class="preset-chip preset-chip-manage" onclick="window.openPresetsModal()">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </div>`;
    container.innerHTML = html;
  } catch {
    container.innerHTML = '';
  }
}

export function selectPreset(presetFile, launchUiRefresh) {
  launchSelectedPresetFile = presetFile;
  const container = document.getElementById('launch-presets');
  for (const chip of container.querySelectorAll('.preset-chip')) {
    const isNone = chip.classList.contains('preset-chip-none');
    const chipId = chip.dataset.preset || null;
    chip.classList.toggle('preset-chip-selected', presetFile ? chipId === presetFile : isNone);
  }
  const preset = launchPresets.find(entry => entry.filename === presetFile);
  if (preset) document.getElementById('launch-agent-id').value = preset.agent;
  if (launchUiRefresh) launchUiRefresh();
}

export async function openPresetsModal() {
  document.getElementById('presets-modal').style.display = 'flex';
  await renderPresetsManageList();
}

export async function loadAgentPresets() {
  await renderPresetsManageList('presets-page-list');
}

async function renderPresetsManageList(targetId = 'presets-list') {
  const container = document.getElementById(targetId);
  if (!container) return;
  try {
    const { presets } = await api('GET', '/api/agents/presets');
    if (!presets.length) {
      container.innerHTML = '<div style="padding:12px;color:var(--text3);font-size:13px">No presets yet. Add one below.</div>';
      return;
    }
    let html = '';
    for (const p of presets) {
      html += `<div class="preset-manage-row">
        <span class="preset-chip-icon" style="background:${escAttr(p.color)}20;color:${escAttr(p.color)}">${escHtml(p.icon)}</span>
        <div class="preset-manage-info">
          <div class="preset-manage-name">${escHtml(p.name)} <span style="color:var(--text3);font-weight:400;font-size:11px">${escHtml(p.agent)}</span></div>
          <div class="preset-manage-desc">${escHtml(p.description)}</div>
          <div class="preset-manage-flags">${escHtml(p.flags || '(no flags)')}</div>
        </div>
        <button class="btn btn-danger btn-sm" onclick="window.deletePreset('${escAttr(p.filename)}')">Delete</button>
      </div>`;
    }
    container.innerHTML = html;
  } catch {
    container.innerHTML = '<div style="padding:12px;color:var(--danger)">Error loading presets</div>';
  }
}

function getPresetFieldId(prefix, name) {
  return prefix === 'page' ? `preset-page-${name}` : `preset-${name}`;
}

export async function savePreset(e, prefix = 'modal') {
  e.preventDefault();
  const name = document.getElementById(getPresetFieldId(prefix, 'name')).value.trim();
  const agent = document.getElementById(getPresetFieldId(prefix, 'agent')).value;
  const icon = document.getElementById(getPresetFieldId(prefix, 'icon')).value.trim() || name[0];
  const color = document.getElementById(getPresetFieldId(prefix, 'color')).value;
  const description = document.getElementById(getPresetFieldId(prefix, 'description')).value.trim();
  const flags = document.getElementById(getPresetFieldId(prefix, 'flags')).value.trim();

  try {
    await api('POST', '/api/agents/presets', { name, agent, icon, color, description, flags });
    document.getElementById(getPresetFieldId(prefix, 'name')).value = '';
    document.getElementById(getPresetFieldId(prefix, 'icon')).value = '';
    document.getElementById(getPresetFieldId(prefix, 'description')).value = '';
    document.getElementById(getPresetFieldId(prefix, 'flags')).value = '';
    if (prefix === 'modal') {
      document.querySelector('.preset-form-details').removeAttribute('open');
    }
    await renderPresetsManageList();
    await renderPresetsManageList('presets-page-list');
    toast(`Preset "${name}" created`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function deletePreset(filename) {
  if (!window.confirm('Delete this preset?')) return;
  try {
    await api('DELETE', `/api/agents/presets/${filename}`);
    await renderPresetsManageList();
    await renderPresetsManageList('presets-page-list');
    toast('Preset deleted');
  } catch (err) {
    toast(err.message, 'error');
  }
}
