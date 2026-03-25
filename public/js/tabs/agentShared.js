export const AGENT_META = {
  claude:   { label: 'C', color: 'claude',   accent: '#e08a6a' },
  codex:    { label: 'X', color: 'codex',    accent: '#3ecf8e' },
  gemini:   { label: 'G', color: 'gemini',   accent: '#6ba3ff' },
  opencode: { label: 'O', color: 'opencode', accent: '#f5a623' },
  aider:    { label: 'A', color: 'aider',    accent: '#a78bfa' },
  continue: { label: 'C', color: 'continue', accent: '#fc8181' },
};

export const AGENT_INITIATIVES_KEY = 'ssh-manager.ai-agents.initiatives';
export const LAST_OPENED_AGENT_KEY = 'ssh-manager.ai-agents.last-opened';
export const CONTEXT_UI_STATE_KEY = 'ssh-manager.ai-agents.context-ui';
export const LAUNCH_RECENT_CWDS_KEY = 'ssh-manager.ai-agents.launch.recent-cwds';

export function tildefy(path) {
  if (!path) return path;
  return path.replace(/^\/Users\/[^/]+/, '~');
}

export function agentFullName(id) {
  const names = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode', aider: 'Aider', continue: 'Continue' };
  return names[id] || id;
}

export function formatEtime(etime) {
  const [dayPart, timePart] = etime.includes('-') ? etime.split('-') : [null, etime];
  const parts = (timePart || etime).split(':').map(Number);
  const days = dayPart ? parseInt(dayPart) : 0;
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) [h, m, s] = parts;
  else if (parts.length === 2) [m, s] = parts;
  else [s] = parts;
  if (days) return `${days}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function contextWindowSize(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('haiku')) return 200000;
  if (m.includes('opus')) return 200000;
  if (m.includes('sonnet')) return 200000;
  if (m.includes('gemini')) return 1000000;
  if (m.includes('gpt-4o')) return 128000;
  if (m.includes('gpt-4')) return 128000;
  if (m.includes('o3') || m.includes('o4')) return 200000;
  return 200000;
}

export function formatTimeAgo(date) {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return date.toLocaleDateString();
}

export function agentInitiativeKey(agent) {
  const muxTarget = agent.multiplexer?.target || agent.multiplexer?.session || '';
  return [agent.agentId, agent.cwd || '', muxTarget || agent.tty || agent.pid].join('::');
}

export function readLastOpenedAgentKey() {
  return window.localStorage.getItem(LAST_OPENED_AGENT_KEY) || '';
}

export function writeLastOpenedAgentKey(agentKey) {
  window.localStorage.setItem(LAST_OPENED_AGENT_KEY, agentKey);
}

// Shared drawer PID accessor — set by agentDrawer, read by agentContext
let _drawerCurrentPid = null;
export function setDrawerCurrentPid(pid) { _drawerCurrentPid = pid; }
export function getDrawerCurrentPid() { return _drawerCurrentPid; }

export function simpleMarkdown(text) {
  if (!text) return '';
  let out = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  out = out.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) =>
    `<pre>${code.trimEnd()}</pre>`);
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\n/g, '<br>');
  return out;
}
