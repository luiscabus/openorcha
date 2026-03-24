import { toast } from './utils.js';

const UPDATE_STATUS_POLL_MS = 60_000;
const UPDATE_RELOAD_WAIT_MS = 45_000;

let updatePollTimer = null;
let appUpdateState = {
  isLoading: true,
  isUpdating: false,
  isRepo: true,
  availability: 'current',
  currentCommit: '',
  currentShort: '',
  remoteCommit: '',
  remoteShort: '',
  branch: '',
  upstream: '',
  behind: 0,
  dirty: false,
  canUpdate: false,
  fetchError: '',
  lastFetchedAt: 0,
  refreshing: false,
};

function buildStatusUrl({ refresh = false, localOnly = false } = {}) {
  const url = new URL('/api/app/update-status', window.location.origin);
  if (refresh) url.searchParams.set('refresh', '1');
  if (localOnly) url.searchParams.set('local', '1');
  url.searchParams.set('_', Date.now().toString());
  return `${url.pathname}${url.search}`;
}

function describeAppUpdate(state) {
  if (state.isLoading) {
    return {
      label: 'Checking updates',
      text: 'Comparing this checkout with its upstream branch.',
      stateName: 'loading',
      buttonLabel: 'Update',
      showButton: false,
      disableButton: true,
    };
  }

  if (state.isUpdating) {
    return {
      label: `${state.branch || 'OpenOrcha'} · ${state.currentShort || 'pending'}`,
      text: `Applying ${state.currentShort || 'current'} -> ${state.remoteShort || 'latest'} and waiting for the new build.`,
      stateName: 'updating',
      buttonLabel: 'Updating…',
      showButton: true,
      disableButton: true,
    };
  }

  if (!state.isRepo) {
    return {
      label: 'Update checks unavailable',
      text: 'This running app is not inside a git checkout.',
      stateName: 'unavailable',
      buttonLabel: 'Update',
      showButton: false,
      disableButton: true,
    };
  }

  if (!state.upstream) {
    return {
      label: `${state.branch || 'Detached HEAD'} · ${state.currentShort || 'unknown'}`,
      text: 'No upstream branch is configured for this checkout.',
      stateName: 'unavailable',
      buttonLabel: 'Update',
      showButton: false,
      disableButton: true,
    };
  }

  if (state.availability === 'available') {
    return {
      label: `${state.branch} · ${state.currentShort}`,
      text: `${state.behind} commit${state.behind === 1 ? '' : 's'} behind ${state.remoteShort}.${state.refreshing ? ' Refreshing remote status…' : ' Update is ready.'}`,
      stateName: 'available',
      buttonLabel: 'Update',
      showButton: true,
      disableButton: false,
    };
  }

  if (state.availability === 'blocked') {
    return {
      label: `${state.branch} · ${state.currentShort}`,
      text: 'Remote changes exist, but local edits in this checkout block a safe fast-forward update.',
      stateName: 'blocked',
      buttonLabel: 'Blocked',
      showButton: true,
      disableButton: true,
    };
  }

  if (state.availability === 'degraded') {
    return {
      label: `${state.branch} · ${state.currentShort}`,
      text: state.fetchError || 'The latest remote state could not be refreshed.',
      stateName: 'degraded',
      buttonLabel: 'Update',
      showButton: false,
      disableButton: true,
    };
  }

  if (state.refreshing && !state.lastFetchedAt) {
    return {
      label: `${state.branch} · ${state.currentShort}`,
      text: 'Local version loaded. Remote status is refreshing in the background.',
      stateName: 'current',
      buttonLabel: 'Update',
      showButton: false,
      disableButton: true,
    };
  }

  if (state.refreshing) {
    return {
      label: `${state.branch} · ${state.currentShort}`,
      text: `Up to date with ${state.remoteShort || state.currentShort}. Refreshing remote status…`,
      stateName: 'current',
      buttonLabel: 'Update',
      showButton: false,
      disableButton: true,
    };
  }

  return {
    label: `${state.branch} · ${state.currentShort}`,
    text: `Up to date with ${state.remoteShort || state.currentShort}.`,
    stateName: 'current',
    buttonLabel: 'Update',
    showButton: false,
    disableButton: true,
  };
}

function renderAppUpdate() {
  const chip = document.getElementById('app-update-chip');
  const label = document.getElementById('app-update-label');
  const text = document.getElementById('app-update-text');
  const button = document.getElementById('app-update-button');
  if (!chip || !label || !text || !button) return;

  const view = describeAppUpdate(appUpdateState);
  chip.dataset.state = view.stateName;
  label.textContent = view.label;
  text.textContent = view.text;
  button.textContent = view.buttonLabel;
  button.style.display = view.showButton ? 'inline-flex' : 'none';
  button.disabled = view.disableButton;
}

async function fetchAppUpdateStatus(options = {}) {
  const { refresh = false, localOnly = false, silent = false } = options;

  try {
    const res = await fetch(buildStatusUrl({ refresh, localOnly }), { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load update status');
    appUpdateState = {
      ...appUpdateState,
      ...data,
      isLoading: false,
      isUpdating: appUpdateState.isUpdating,
    };
    renderAppUpdate();
    return data;
  } catch (err) {
    appUpdateState = {
      ...appUpdateState,
      isLoading: false,
      availability: 'degraded',
      fetchError: err.message,
    };
    renderAppUpdate();
    if (!silent) toast(err.message, 'error');
    throw err;
  }
}

function scheduleAppUpdatePolling() {
  clearInterval(updatePollTimer);
  updatePollTimer = setInterval(() => {
    fetchAppUpdateStatus({ silent: true }).catch(() => {});
  }, UPDATE_STATUS_POLL_MS);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function forceReloadApp() {
  const url = new URL(window.location.href);
  url.searchParams.set('openorcha_reload', Date.now().toString());
  window.location.replace(url.toString());
}

async function waitForUpdatedCommit(previousCommit, expectedCommit) {
  const deadline = Date.now() + UPDATE_RELOAD_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      const status = await fetchAppUpdateStatus({ localOnly: true, silent: true });
      if (
        status.currentCommit &&
        status.currentCommit !== previousCommit &&
        (!expectedCommit || status.currentCommit === expectedCommit)
      ) {
        forceReloadApp();
        return;
      }
    } catch {}

    await wait(1000);
  }

  forceReloadApp();
}

async function triggerAppUpdate() {
  if (appUpdateState.isUpdating) return;

  if (!appUpdateState.canUpdate) {
    if (appUpdateState.dirty) {
      toast('Update blocked by local changes in this checkout.', 'error');
    } else {
      toast('OpenOrcha is already up to date.');
    }
    return;
  }

  const previousCommit = appUpdateState.currentCommit;
  appUpdateState = { ...appUpdateState, isUpdating: true };
  renderAppUpdate();

  try {
    const res = await fetch(`/api/app/update?_${Date.now()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Update failed');

    if (!data.changed) {
      appUpdateState = { ...appUpdateState, isUpdating: false };
      await fetchAppUpdateStatus({ refresh: true, silent: true });
      toast('OpenOrcha is already up to date.');
      return;
    }

    toast('Update applied. Reloading OpenOrcha…');
    await waitForUpdatedCommit(previousCommit, data.currentCommit || data.status?.currentCommit || '');
  } catch (err) {
    appUpdateState = { ...appUpdateState, isUpdating: false };
    renderAppUpdate();
    toast(err.message, 'error');
    await fetchAppUpdateStatus({ refresh: true, silent: true }).catch(() => {});
  }
}

export function initAppUpdate() {
  renderAppUpdate();
  fetchAppUpdateStatus({ refresh: true, silent: true }).catch(() => {});
  scheduleAppUpdatePolling();
}

export { triggerAppUpdate };
