const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');

const APP_ROOT = path.resolve(__dirname, '..');
const FETCH_TTL_MS = 60_000;
const INITIAL_FETCH_DELAY_MS = 1_500;

const execFileAsync = promisify(execFile);

let lastFetchAt = 0;
let lastFetchError = '';
let lastFetchUpstream = '';
let updateInFlight = false;
let fetchInFlight = false;
let fetchPromise = null;
let refreshLoopStarted = false;

function git(args, timeout = 4000) {
  return execFileSync('git', ['-C', APP_ROOT, ...args], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitMultiline(args, timeout = 4000) {
  return execFileSync('git', ['-C', APP_ROOT, ...args], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\s+$/, '');
}

function tryGit(args, timeout = 4000) {
  try {
    return git(args, timeout);
  } catch {
    return '';
  }
}

function getGitErrorMessage(err) {
  return String(err?.stderr || err?.stdout || err?.message || 'Git command failed').trim();
}

function parseGitStatus(statusText = '') {
  const files = statusText
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => {
      const rawCode = line.slice(0, 2);
      return {
        code: rawCode === '??' ? '??' : rawCode,
        path: line.slice(3).trim(),
      };
    });

  return {
    files,
    stagedCount: files.filter(file => file.code[0] && file.code[0] !== ' ' && file.code[0] !== '?').length,
    changedCount: files.filter(file => file.code[1] && file.code[1] !== ' ' && file.code[1] !== '?').length,
    untrackedCount: files.filter(file => file.code === '??').length,
  };
}

function deriveUpdateFlags(status) {
  if (!status.isRepo) {
    return { availability: 'unavailable', canUpdate: false };
  }
  if (status.behind > 0 && status.dirty) {
    return { availability: 'blocked', canUpdate: false };
  }
  if (status.behind > 0) {
    return { availability: 'available', canUpdate: true };
  }
  if (!status.upstream) {
    return { availability: 'unavailable', canUpdate: false };
  }
  if (status.fetchError) {
    return { availability: 'degraded', canUpdate: false };
  }
  return { availability: 'current', canUpdate: false };
}

function collectLocalStatus() {
  try {
    const root = git(['rev-parse', '--show-toplevel']);
    const branch = git(['branch', '--show-current']) || 'HEAD';
    const currentCommit = git(['rev-parse', 'HEAD']);
    const upstream = tryGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    let statusText = '';
    try {
      statusText = gitMultiline(['status', '--short']);
    } catch {}
    const summary = parseGitStatus(statusText);
    const dirty = summary.files.length > 0;

    return {
      isRepo: true,
      root,
      branch,
      upstream,
      currentCommit,
      currentShort: currentCommit.slice(0, 7),
      dirty,
      ...summary,
    };
  } catch {
    return {
      isRepo: false,
      root: APP_ROOT,
      branch: '',
      upstream: '',
      currentCommit: '',
      currentShort: '',
      dirty: false,
      files: [],
      stagedCount: 0,
      changedCount: 0,
      untrackedCount: 0,
    };
  }
}

function resetRemoteCache() {
  lastFetchAt = 0;
  lastFetchError = '';
  lastFetchUpstream = '';
  fetchInFlight = false;
  fetchPromise = null;
}

function shouldRefreshRemote(upstream, forceFetch = false) {
  if (!upstream || updateInFlight || fetchInFlight) return false;
  return forceFetch || upstream !== lastFetchUpstream || (Date.now() - lastFetchAt) > FETCH_TTL_MS;
}

function markRemoteRefreshed(upstream, error = '') {
  lastFetchAt = Date.now();
  lastFetchError = error;
  lastFetchUpstream = upstream || '';
}

async function fetchRemoteAsync(upstream) {
  if (!upstream) {
    resetRemoteCache();
    return;
  }

  try {
    await execFileAsync('git', ['-C', APP_ROOT, 'fetch', '--quiet', '--prune'], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    markRemoteRefreshed(upstream, '');
  } catch (err) {
    markRemoteRefreshed(upstream, getGitErrorMessage(err));
  }
}

function collectRemoteStatus(branch, upstream) {
  if (!upstream) {
    return {
      remoteCommit: '',
      remoteShort: '',
      ahead: 0,
      behind: 0,
    };
  }

  const remoteCommit = tryGit(['rev-parse', upstream]);
  let ahead = 0;
  let behind = 0;

  if (remoteCommit) {
    const counts = tryGit(['rev-list', '--left-right', '--count', `${branch}...${upstream}`]);
    const [aheadStr, behindStr] = counts.split(/\s+/);
    ahead = parseInt(aheadStr, 10) || 0;
    behind = parseInt(behindStr, 10) || 0;
  }

  return {
    remoteCommit,
    remoteShort: remoteCommit ? remoteCommit.slice(0, 7) : '',
    ahead,
    behind,
  };
}

function scheduleBackgroundRefresh(upstream, { forceFetch = false } = {}) {
  if (!shouldRefreshRemote(upstream, forceFetch)) return false;
  if (fetchPromise) return true;

  fetchInFlight = true;
  fetchPromise = fetchRemoteAsync(upstream)
    .catch(() => {})
    .finally(() => {
      fetchInFlight = false;
      fetchPromise = null;
    });

  return true;
}

function startBackgroundRefreshLoop() {
  if (refreshLoopStarted) return;
  refreshLoopStarted = true;

  const initialTimer = setTimeout(() => {
    const local = collectLocalStatus();
    if (local.isRepo && local.upstream) {
      scheduleBackgroundRefresh(local.upstream, { forceFetch: true });
    }
  }, INITIAL_FETCH_DELAY_MS);
  initialTimer.unref?.();

  const loop = setInterval(() => {
    const local = collectLocalStatus();
    if (local.isRepo && local.upstream) {
      scheduleBackgroundRefresh(local.upstream, { forceFetch: false });
    }
  }, FETCH_TTL_MS);
  loop.unref?.();
}

function getAppUpdateStatus(options = {}) {
  const { forceFetch = false, localOnly = false } = options;
  const local = collectLocalStatus();

  if (!local.isRepo) {
    return {
      ...local,
      remoteCommit: '',
      remoteShort: '',
      ahead: 0,
      behind: 0,
      fetchError: '',
      lastFetchedAt: 0,
      refreshing: false,
      updateInFlight,
      ...deriveUpdateFlags(local),
    };
  }

  if (!localOnly) {
    scheduleBackgroundRefresh(local.upstream, { forceFetch });
  }

  const hasRemoteCache = !!local.upstream && local.upstream === lastFetchUpstream && lastFetchAt > 0;
  const remote = hasRemoteCache
    ? collectRemoteStatus(local.branch, local.upstream)
    : { remoteCommit: '', remoteShort: '', ahead: 0, behind: 0 };

  const status = {
    ...local,
    ...remote,
    fetchError: local.upstream === lastFetchUpstream ? lastFetchError : '',
    lastFetchedAt: local.upstream === lastFetchUpstream ? lastFetchAt : 0,
    refreshing: local.upstream === lastFetchUpstream ? fetchInFlight : false,
    updateInFlight,
  };

  return {
    ...status,
    ...deriveUpdateFlags(status),
  };
}

function createStatusError(message, statusCode, details = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.details = details;
  return err;
}

function applyAppUpdate() {
  if (updateInFlight) {
    throw createStatusError('An update is already in progress.', 409);
  }
  if (fetchInFlight) {
    throw createStatusError('Update status is being refreshed right now. Try again in a moment.', 409);
  }

  const before = getAppUpdateStatus({ localOnly: true });
  if (!before.isRepo) {
    throw createStatusError('OpenOrcha is not running from a git repository.', 400, { status: before });
  }
  if (!before.upstream) {
    throw createStatusError('This checkout has no upstream branch configured.', 409, { status: before });
  }
  if (before.dirty) {
    throw createStatusError('Update blocked by local changes in the OpenOrcha checkout.', 409, { status: before });
  }
  if (before.behind <= 0) {
    return { ok: true, changed: false, previousCommit: before.currentCommit, currentCommit: before.currentCommit, status: before };
  }

  updateInFlight = true;
  try {
    git(['pull', '--ff-only'], 30000);
  } catch (err) {
    throw createStatusError(`Update failed: ${getGitErrorMessage(err)}`, 500, { status: before });
  } finally {
    updateInFlight = false;
  }

  if (before.upstream) {
    markRemoteRefreshed(before.upstream, '');
  }

  const after = getAppUpdateStatus({ localOnly: true });
  return {
    ok: true,
    changed: after.currentCommit !== before.currentCommit,
    previousCommit: before.currentCommit,
    currentCommit: after.currentCommit,
    status: after,
  };
}

startBackgroundRefreshLoop();

module.exports = {
  APP_ROOT,
  applyAppUpdate,
  deriveUpdateFlags,
  getAppUpdateStatus,
  parseGitStatus,
};
