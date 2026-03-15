import { toast, closeModal } from './utils.js';

import { loadHosts, openHostModal, saveHost, deleteHost } from './tabs/hosts.js';
import { loadKeys, openKeyModal, generateKey, deleteKey, showPublicKey, copyPubKey } from './tabs/keys.js';
import { loadKnownHosts, filterKnownHosts, removeKnownHost } from './tabs/known-hosts.js';
import { loadRawConfig, saveRawConfig } from './tabs/raw-config.js';
import {
  loadSessions,
  focusSession,
  launchSSH,
  launchCustom,
  killSSHProcess,
  openNewScreenModal,
  createScreenSession,
  killScreen,
  attachScreen,
  openNewTmuxModal,
  createTmuxSession,
  killTmux,
  attachTmux,
} from './tabs/sessions.js';
import {
  loadAgents,
  killAgent,
  toggleAgentAutoRefresh,
  clearAgentAutoRefresh,
  openAgentMessages,
  refreshDrawer,
  closeMessagesDrawer,
  closeDrawerOnOverlay,
  sendAgentMessage,
  openLaunchAgentModal,
  launchAgent,
} from './tabs/agents.js';

// ─── Expose all functions referenced by HTML onclick handlers ─────────────────

window.toast = toast;
window.closeModal = closeModal;

// Hosts
window.loadHosts = loadHosts;
window.openHostModal = openHostModal;
window.saveHost = saveHost;
window.deleteHost = deleteHost;

// Keys
window.loadKeys = loadKeys;
window.openKeyModal = openKeyModal;
window.generateKey = generateKey;
window.deleteKey = deleteKey;
window.showPublicKey = showPublicKey;
window.copyPubKey = copyPubKey;

// Known Hosts
window.loadKnownHosts = loadKnownHosts;
window.filterKnownHosts = filterKnownHosts;
window.removeKnownHost = removeKnownHost;

// Raw Config
window.loadRawConfig = loadRawConfig;
window.saveRawConfig = saveRawConfig;

// Sessions
window.loadSessions = loadSessions;
window.focusSession = focusSession;
window.launchSSH = launchSSH;
window.launchCustom = launchCustom;
window.killSSHProcess = killSSHProcess;
window.openNewScreenModal = openNewScreenModal;
window.createScreenSession = createScreenSession;
window.killScreen = killScreen;
window.attachScreen = attachScreen;
window.openNewTmuxModal = openNewTmuxModal;
window.createTmuxSession = createTmuxSession;
window.killTmux = killTmux;
window.attachTmux = attachTmux;

// Agents
window.loadAgents = loadAgents;
window.killAgent = killAgent;
window.toggleAgentAutoRefresh = toggleAgentAutoRefresh;
window.openAgentMessages = openAgentMessages;
window.refreshDrawer = refreshDrawer;
window.closeMessagesDrawer = closeMessagesDrawer;
window.closeDrawerOnOverlay = closeDrawerOnOverlay;
window.sendAgentMessage = sendAgentMessage;
window.openLaunchAgentModal = openLaunchAgentModal;
window.launchAgent = launchAgent;

// ─── Navigation ───────────────────────────────────────────────────────────────

function loadTab(tab) {
  // Clear agents auto-refresh when leaving the agents tab
  if (tab !== 'agents') {
    clearAgentAutoRefresh();
  }

  if (tab === 'hosts') loadHosts();
  else if (tab === 'keys') loadKeys();
  else if (tab === 'known-hosts') loadKnownHosts();
  else if (tab === 'raw-config') loadRawConfig();
  else if (tab === 'sessions') loadSessions();
  else if (tab === 'agents') loadAgents();
}

function initNav() {
  document.querySelectorAll('.nav-item').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const tab = link.dataset.tab;
      document.querySelectorAll('.nav-item').forEach(l => l.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      link.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.add('active');
      loadTab(tab);
    });
  });

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.style.display = 'none';
    });
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
initNav();
loadHosts();
