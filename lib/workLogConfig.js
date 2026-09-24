// Work log settings: what to scan, which sources are on, and the clock the
// day is judged by. Secrets never live here — the Jira token is read from the
// environment only, so this file stays safe to open and to commit.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const WORKLOG_DIR = process.env.OPENORCHA_WORKLOG_DIR
  || path.join(__dirname, '..', 'data', 'worklog');

const CONFIG_FILE = () => path.join(WORKLOG_DIR, 'config.json');

const DEFAULTS = {
  // Absolute paths to the repos worth scanning. Empty means "everything the
  // scan finds", which is fine on a machine with a handful of checkouts.
  repos: [],
  repoRoots: [],
  // Jira decides a worklog's day by the account timezone, so that is the one
  // clock the log trusts. See workLogTime.js.
  workTimezone: 'America/Chicago',
  // Jira renders a day as the site's workday, which is 7h here, not 8.
  dayMinutes: 420,
  roundToMinutes: 15,
  idleGapMinutes: 30,
  loneSignalMinutes: 15,
  // Wall-clock time a detected entry is stamped at when pushed, per ticket
  // order through the day.
  defaultStartHour: '09:00',
  // Letters-only project key. Allowing digits in the key makes UUID fragments
  // like 399C295F-8BC3-… look like tickets.
  ticketPattern: '\\b[A-Z]{2,10}-\\d+\\b',
  // Restrict to specific project keys, e.g. ["SO"]. Empty accepts any key,
  // which lets a placeholder like "TICKET-1234" in a prompt through.
  projectKeys: [],
  // Resolve GitHub PR links found in sessions to recover the ticket from the
  // PR title. Costs one gh call per distinct PR, cached for the process.
  resolvePrLinks: true,
  // Ask a model to describe each block of work and classify the attention it
  // took. Runs once per day and is sealed into that day's cache.
  narrate: true,
  narrateModel: 'claude-opus-5',
  // The kinds of attention a day splits into. Edit freely — an answer outside
  // this list is coerced to "other" rather than silently adding a category.
  attentionKinds: null,
  // Commit author emails that count as yours. Empty means "ask git".
  gitAuthors: [],
  sources: {
    git: true,
    sessions: true,
    github: true,
    jira: false,
    initiatives: false,
    reflog: false,
    calendar: false,
    slack: false,
    shell: false,
  },
  // The contexts board. Open state cannot be reconstructed after the fact, so
  // it is observed on a schedule and written down; the gap between observations
  // is the resolution of the entire history. See lib/contextStore.js.
  contexts: {
    sources: { jira: true, github: true, git: true, initiatives: true },
    observeEveryMinutes: 30,
    // A branch nobody has touched in this long is archaeology, not a commitment.
    branchActiveDays: 45,
    // How far back to ask Jira for finished tickets, so closure is recorded as
    // done rather than inferred from absence.
    resolvedWithinDays: 30,
    prLimit: 40,
    keepObservations: 2000,
  },
  slack: {
    // Prepended to the generated EOD message, above the code fence.
    preamble: '',
  },
};

const SCAN_EXCLUDES = new Set([
  'node_modules', 'Library', 'Applications', '.Trash', '.nvm', '.cache',
  '.npm', '.git', 'vendor', 'dist', 'build', 'Pictures', 'Movies', 'Music',
]);

function ensureDir() {
  fs.mkdirSync(WORKLOG_DIR, { recursive: true });
}

function merge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = merge(base[key] || {}, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function read() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE(), 'utf8');
    return merge(DEFAULTS, JSON.parse(raw));
  } catch {
    return { ...DEFAULTS, sources: { ...DEFAULTS.sources }, slack: { ...DEFAULTS.slack } };
  }
}

function write(patch) {
  ensureDir();
  const next = merge(read(), patch || {});
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// Jira credentials come from the environment, the same way githubIssues.js
// takes GITHUB_TOKEN. Nothing here is persisted.
function jiraEnv() {
  const baseUrl = (process.env.JIRA_BASE_URL || '').trim().replace(/\/+$/, '');
  const email = (process.env.JIRA_EMAIL || '').trim();
  const token = (process.env.JIRA_API_TOKEN || '').trim();
  return {
    baseUrl,
    email,
    token,
    configured: !!(baseUrl && email && token),
    missing: [
      !baseUrl && 'JIRA_BASE_URL',
      !email && 'JIRA_EMAIL',
      !token && 'JIRA_API_TOKEN',
    ].filter(Boolean),
  };
}

function isGitRepo(dir) {
  try {
    return fs.statSync(path.join(dir, '.git')).isDirectory();
  } catch {
    return false;
  }
}

// Walks a few levels looking for checkouts. Shallow on purpose: a deep sweep
// of a home directory is slow and turns up nothing anyone works in.
function discoverRepos(roots, maxDepth = 3) {
  const startingPoints = (roots && roots.length ? roots : [os.homedir()]).filter(Boolean);
  const found = new Set();

  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') && entry.name !== '.git') continue;
      if (SCAN_EXCLUDES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (isGitRepo(full)) {
        found.add(full);
        continue; // no nested scanning inside a checkout
      }
      walk(full, depth + 1);
    }
  };

  for (const root of startingPoints) walk(root, 0);
  return [...found].sort();
}

// The repos a collection run should actually read.
function activeRepos(cfg = read()) {
  if (cfg.repos && cfg.repos.length) return cfg.repos.filter(isGitRepo);
  return discoverRepos(cfg.repoRoots);
}

// Commits are attributed to whoever authored them; without knowing who that
// is we would log the whole team's work. Falls back to the global git identity.
function gitIdentity(cfg = read()) {
  if (cfg.gitAuthors && cfg.gitAuthors.length) return cfg.gitAuthors[0];
  try {
    return execFileSync('git', ['config', '--get', 'user.email'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

// Every identity whose commits should be treated as yours.
function activeAuthors(cfg = read()) {
  if (cfg.gitAuthors && cfg.gitAuthors.length) return cfg.gitAuthors;
  const detected = gitIdentity(cfg);
  return detected ? [detected] : [];
}

module.exports = {
  DEFAULTS,
  activeAuthors,
  WORKLOG_DIR,
  CONFIG_FILE,
  read,
  write,
  jiraEnv,
  discoverRepos,
  activeRepos,
  gitIdentity,
  isGitRepo,
};
