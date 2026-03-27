import { toast, closeModal } from './utils.js';
import { initAppUpdate, triggerAppUpdate } from './app-update.js';

import { loadHosts, openHostModal, saveHost, deleteHost } from './tabs/hosts.js';
import { loadKeys, openKeyModal, generateKey, deleteKey, showPublicKey, copyPubKey } from './tabs/keys.js';
import { loadKnownHosts, filterKnownHosts, removeKnownHost } from './tabs/known-hosts.js';
import { loadRawConfig, saveRawConfig } from './tabs/raw-config.js';
import { loadIssues, setIssuesFilter } from './tabs/issues.js';
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
  killStaleTmux,
} from './tabs/sessions.js';
import {
  loadAgents,
  toggleAgentNonInteractive,
  killAgent,
  toggleAgentAutoRefresh,
  clearAgentAutoRefresh,
  openAgentMessages,
  refreshDrawer,
  closeMessagesDrawer,
  closeDrawerOnOverlay,
  sendAgentMessage,
  handleSendKeydown,
  openLaunchAgentModal,
  launchAgent,
  selectLaunchSession,
  selectPreset,
  openExistingLaunchAgent,
  openPresetsModal,
  loadAgentPresets,
  savePreset,
  deletePreset,
  toggleAgentHistory,
  historyOpenAgent,
  launchFromHistory,
  addAgentInitiative,
  deleteAgentInitiative,
  toggleInitiativeCollapse,
  startAgentInitiativeDrag,
  endAgentInitiativeDrag,
  startInitiativeOrderDrag,
  endInitiativeOrderDrag,
  handleAgentInitiativeDragOver,
  handleAgentInitiativeDragLeave,
  handleAgentInitiativeDrop,
  switchDrawerView,
  sendKey,
  clickPromptOption,
  endDrawerSession,
  attachDrawerSession,
  relaunchDrawerSession,
  relaunchAgent,
  openTmuxTerminal,
  toggleContextBlock,
  toggleMcpServer,
} from './tabs/agents.js';
import {
  loadTodos,
  loadKanban,
  addTodo,
  addTodoGroup,
  handleTodoPaste,
  setTodoStatus,
  toggleTodo,
  startTodoEdit,
  cancelTodoEdit,
  saveTodoEdit,
  deleteTodo,
  deleteTodoGroup,
  clearCompletedTodos,
  confirmBulkAddTodos,
  toggleAllBulkTodos,
  syncBulkTodoSelection,
  startTodoDrag,
  endTodoDrag,
  handleTodoGroupDragOver,
  handleTodoGroupDragLeave,
  handleTodoGroupDrop,
  handleKanbanStatusDragOver,
  handleKanbanStatusDragLeave,
  handleKanbanStatusDrop,
  setTodoFilter,
} from './tabs/todo.js';

// ─── Expose all functions referenced by HTML onclick handlers ─────────────────

window.toast = toast;
window.closeModal = closeModal;
window.triggerAppUpdate = triggerAppUpdate;

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

// GitHub Issues
window.loadIssues = loadIssues;
window.setIssuesFilter = setIssuesFilter;

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
window.killStaleTmux = killStaleTmux;
window.openTmuxTerminal = openTmuxTerminal;

// Agents
window.loadAgents = loadAgents;
window.toggleAgentNonInteractive = toggleAgentNonInteractive;
window.killAgent = killAgent;
window.relaunchAgent = relaunchAgent;
window.toggleAgentAutoRefresh = toggleAgentAutoRefresh;
window.openAgentMessages = openAgentMessages;
window.refreshDrawer = refreshDrawer;
window.closeMessagesDrawer = closeMessagesDrawer;
window.closeDrawerOnOverlay = closeDrawerOnOverlay;
window.sendAgentMessage = sendAgentMessage;
window.handleSendKeydown = handleSendKeydown;
window.openLaunchAgentModal = openLaunchAgentModal;
window.launchAgent = launchAgent;
window.selectLaunchSession = selectLaunchSession;
window.selectPreset = selectPreset;
window.openExistingLaunchAgent = openExistingLaunchAgent;
window.openPresetsModal = openPresetsModal;
window.loadAgentPresets = loadAgentPresets;
window.savePreset = savePreset;
window.deletePreset = deletePreset;
window.toggleAgentHistory = toggleAgentHistory;
window.historyOpenAgent = historyOpenAgent;
window.launchFromHistory = launchFromHistory;
window.addAgentInitiative = addAgentInitiative;
window.deleteAgentInitiative = deleteAgentInitiative;
window.toggleInitiativeCollapse = toggleInitiativeCollapse;
window.startAgentInitiativeDrag = startAgentInitiativeDrag;
window.endAgentInitiativeDrag = endAgentInitiativeDrag;
window.startInitiativeOrderDrag = startInitiativeOrderDrag;
window.endInitiativeOrderDrag = endInitiativeOrderDrag;
window.handleAgentInitiativeDragOver = handleAgentInitiativeDragOver;
window.handleAgentInitiativeDragLeave = handleAgentInitiativeDragLeave;
window.handleAgentInitiativeDrop = handleAgentInitiativeDrop;
window.switchDrawerView = switchDrawerView;
window.sendKey = sendKey;
window.clickPromptOption = clickPromptOption;
window.endDrawerSession = endDrawerSession;
window.attachDrawerSession = attachDrawerSession;
window.toggleContextBlock = toggleContextBlock;
window.toggleMcpServer = toggleMcpServer;
window.relaunchDrawerSession = relaunchDrawerSession;

// Todo
window.addTodo = addTodo;
window.addTodoGroup = addTodoGroup;
window.handleTodoPaste = handleTodoPaste;
window.setTodoStatus = setTodoStatus;
window.toggleTodo = toggleTodo;
window.startTodoEdit = startTodoEdit;
window.cancelTodoEdit = cancelTodoEdit;
window.saveTodoEdit = saveTodoEdit;
window.deleteTodo = deleteTodo;
window.deleteTodoGroup = deleteTodoGroup;
window.clearCompletedTodos = clearCompletedTodos;
window.confirmBulkAddTodos = confirmBulkAddTodos;
window.toggleAllBulkTodos = toggleAllBulkTodos;
window.syncBulkTodoSelection = syncBulkTodoSelection;
window.startTodoDrag = startTodoDrag;
window.endTodoDrag = endTodoDrag;
window.handleTodoGroupDragOver = handleTodoGroupDragOver;
window.handleTodoGroupDragLeave = handleTodoGroupDragLeave;
window.handleTodoGroupDrop = handleTodoGroupDrop;
window.handleKanbanStatusDragOver = handleKanbanStatusDragOver;
window.handleKanbanStatusDragLeave = handleKanbanStatusDragLeave;
window.handleKanbanStatusDrop = handleKanbanStatusDrop;
window.setTodoFilter = setTodoFilter;

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
  else if (tab === 'issues') loadIssues();
  else if (tab === 'sessions') loadSessions();
  else if (tab === 'agents') {
    loadAgents();
    toggleAgentAutoRefresh();
  }
  else if (tab === 'agent-presets') loadAgentPresets();
  else if (tab === 'todo') loadTodos();
  else if (tab === 'kanban') loadKanban();
}

function syncNavState(activeLink) {
  document.querySelectorAll('.nav-item').forEach(link => link.classList.remove('active'));
  document.querySelectorAll('.nav-section').forEach(section => section.classList.remove('active'));
  activeLink.classList.add('active');
  const section = activeLink.closest('.nav-section');
  if (section) section.classList.add('active');
}

function initNav() {
  document.querySelectorAll('.nav-item').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const tab = link.dataset.tab;
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      syncNavState(link);
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
syncNavState(document.querySelector('.nav-item.active'));
initAppUpdate();
loadAgents();
toggleAgentAutoRefresh();
