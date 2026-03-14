import { api, toast } from '../utils.js';

export async function loadRawConfig() {
  const { content } = await api('GET', '/api/config/raw');
  document.getElementById('raw-config-editor').value = content;
}

export async function saveRawConfig() {
  const content = document.getElementById('raw-config-editor').value;
  try {
    await api('PUT', '/api/config/raw', { content });
    toast('Config saved');
  } catch (err) {
    toast(err.message, 'error');
  }
}
