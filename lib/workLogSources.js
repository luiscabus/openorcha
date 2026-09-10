// Where the work log's raw evidence comes from.
//
// A source is a small plugin: it says whether it can run on this machine, and
// it turns a time window into flat, timestamped signals. Nothing here decides
// hours or tickets — that is workLogDetect's job — so adding a new source is
// one object in the registry and nothing else.
//
// Signal: { source, at (ISO), ticket, text, ref, url, repo }

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('./workLogConfig');
const { isOwnSession } = require('./workLogSelf');

// A ticket key found in prose, a branch name or a commit subject.
//
// The hard part is what NOT to match. A UUID is full of things shaped like a
// ticket — 399C295F-8BC3-4188-ABD9-… yields several — and a bad match puts
// real hours on a ticket that does not exist. So a match flanked by a hyphen
// is treated as part of a longer identifier, never as a key.
function ticketFrom(text, cfg) {
  const source = String(text || '');
  const pattern = new RegExp(cfg?.ticketPattern || config.DEFAULTS.ticketPattern, 'g');
  const allowed = (cfg?.projectKeys || []).map(k => String(k).toUpperCase());

  for (const match of source.matchAll(pattern)) {
    const value = match[0].toUpperCase();
    const before = source[match.index - 1];
    const after = source[match.index + match[0].length];
    if (before === '-' || after === '-') continue;
    if (allowed.length && !allowed.includes(value.split('-')[0])) continue;
    return value;
  }
  return null;
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout || 15000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    ...opts,
  });
}

function commandExists(cmd) {
  try {
    run('which', [cmd], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- git commits

const gitSource = {
  id: 'git',
  label: 'Git commits',
  description: 'Commits you authored across the scanned repos. Ticket comes from the message prefix or the branch name.',
  defaultEnabled: true,

  available(cfg) {
    const repos = config.activeRepos(cfg);
    if (!repos.length) return { ok: false, reason: 'No git repositories found to scan' };
    if (!config.activeAuthors(cfg).length) return { ok: false, reason: 'No git author email configured or detected' };
    return { ok: true };
  },

  collect({ from, to, cfg }) {
    const repos = config.activeRepos(cfg);
    const authors = config.activeAuthors(cfg);
    const signals = [];

    for (const repo of repos) {
      const name = path.basename(repo);
      for (const author of authors) {
        let out = '';
        try {
          out = run('git', [
            '-C', repo, 'log', '--all', '--no-merges',
            `--since=${from.toISOString()}`, `--until=${to.toISOString()}`,
            `--author=${author}`,
            '--pretty=format:%H%x1f%aI%x1f%s',
          ]);
        } catch {
          continue;
        }

        for (const line of out.split('\n').filter(Boolean)) {
          const [sha, at, subject] = line.split('\x1f');
          if (!at) continue;
          signals.push({
            source: 'git',
            at,
            ticket: ticketFrom(subject, cfg),
            text: subject,
            ref: `${name}@${(sha || '').slice(0, 9)}`,
            url: null,
            repo: name,
          });
        }
      }
    }
    return signals;
  },
};

// ------------------------------------------------------- claude code sessions

function claudeProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

const sessionSource = {
  id: 'sessions',
  label: 'Claude sessions',
  description: 'Message timestamps from your Claude Code transcripts. This is time actually spent, not just when work landed.',
  defaultEnabled: true,

  available() {
    return fs.existsSync(claudeProjectsDir())
      ? { ok: true }
      : { ok: false, reason: 'No ~/.claude/projects directory on this machine' };
  },

  collect({ from, to, cfg }) {
    const root = claudeProjectsDir();
    const signals = [];
    let projects = [];
    try {
      projects = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory());
    } catch {
      return signals;
    }

    for (const project of projects) {
      const dir = path.join(root, project.name);
      let files = [];
      try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const file of files) {
        const full = path.join(dir, file);
        // Cheap pre-filter. Transcript mtimes can be rewritten in bulk, which
        // only ever makes a file look newer, so this can over-include but
        // never drops a session that belongs in the window.
        try {
          if (fs.statSync(full).mtime < from) continue;
        } catch {
          continue;
        }

        const parsed = readTranscript(full);
        if (!parsed.stamps.length) continue;

        // A session this tool started is not work: describing Tuesday would
        // otherwise become evidence of working on Tuesday's tickets.
        if (isOwnSession(parsed.firstPrompt, project.name, parsed.prompts)) continue;

        // One ticket per session, taken from whatever the session talked
        // about. A session usually is one piece of work. Falling back to the
        // PR it links to catches review sessions, which name no ticket.
        const ticket = ticketFrom(parsed.text, cfg)
          || (cfg?.resolvePrLinks === false ? null : ticketFromPrLinks(parsed.text, cfg));

        // A transcript often carries several records stamped at the same
        // instant. They are one moment of work, not several, and repeating
        // them only pads the evidence list and the cache.
        for (const stamp of [...new Set(parsed.stamps)]) {
          const at = new Date(stamp);
          if (at < from || at >= to) continue;
          signals.push({
            source: 'sessions',
            at: at.toISOString(),
            ticket,
            text: parsed.firstPrompt || 'Claude session',
            ref: `${project.name}/${file.replace(/\.jsonl$/, '').slice(0, 8)}`,
            url: null,
            repo: projectToRepo(project.name),
          });
        }
      }
    }
    return signals;
  },
};

function readTranscript(file) {
  const stamps = [];
  const prompts = [];
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { stamps, text: '', firstPrompt: '' };
  }

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.timestamp) stamps.push(entry.timestamp);
    if (entry.type !== 'user') continue;

    const content = entry.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content.filter(c => c?.type === 'text').map(c => c.text).join(' ');
    }
    text = text.trim();
    // Tool results and harness noise are not things the operator said.
    if (!text || text.startsWith('<') || text.startsWith('Caveat:')) continue;
    prompts.push(text.replace(/\s+/g, ' '));
  }

  return {
    stamps,
    prompts,
    text: prompts.join(' \n '),
    firstPrompt: (prompts[0] || '').slice(0, 180),
  };
}

// A session that says only "code review https://github.com/org/repo/pull/123"
// carries no ticket in its text — the ticket is in the PR's title. Resolving
// the URL recovers it, which matters because review sessions are a real share
// of the week and would otherwise land as unattributed time.
const prTicketCache = new Map();

function ticketFromPrLinks(text, cfg) {
  const urls = String(text || '').match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g);
  if (!urls) return null;

  for (const url of [...new Set(urls)].slice(0, 5)) {
    if (!prTicketCache.has(url)) {
      let title = '';
      try {
        title = JSON.parse(run('gh', ['pr', 'view', url, '--json', 'title'], { timeout: 15000 })).title || '';
      } catch {
        title = '';
      }
      prTicketCache.set(url, title);
    }
    const ticket = ticketFrom(prTicketCache.get(url), cfg);
    if (ticket) return ticket;
  }
  return null;
}

// "-Users-soci-soci-soci-services" -> "soci-services", best effort.
function projectToRepo(projectDirName) {
  const parts = String(projectDirName).split('-').filter(Boolean);
  return parts[parts.length - 1] || '';
}

// ------------------------------------------------------------ github activity

const githubSource = {
  id: 'github',
  label: 'GitHub PR activity',
  description: 'Reviews, review comments and PR comments you left. Catches code-review time on other people’s tickets, which leaves no trace in git.',
  defaultEnabled: true,

  available() {
    if (!commandExists('gh')) return { ok: false, reason: 'The gh CLI is not installed' };
    try {
      run('gh', ['auth', 'status'], { timeout: 8000 });
      return { ok: true };
    } catch {
      return { ok: false, reason: 'gh is installed but not authenticated (run: gh auth login)' };
    }
  },

  collect({ from, to, cfg }) {
    const signals = [];
    const since = from.toISOString().slice(0, 10);
    const login = ghLogin();
    if (!login) return signals;

    let prs = [];
    try {
      const raw = run('gh', [
        'search', 'prs', `--commenter=${login}`, `--updated=>=${since}`,
        '--limit', String(cfg?.githubPrLimit || 40),
        '--json', 'number,title,repository,url',
      ], { timeout: 30000 });
      prs = JSON.parse(raw);
    } catch {
      return signals;
    }

    for (const pr of prs) {
      const slug = pr.repository?.nameWithOwner;
      if (!slug) continue;
      const ticket = ticketFrom(pr.title, cfg);
      const ref = `${pr.repository.name}#${pr.number}`;

      for (const [endpoint, field] of [
        [`repos/${slug}/pulls/${pr.number}/reviews`, 'submitted_at'],
        [`repos/${slug}/issues/${pr.number}/comments`, 'created_at'],
        [`repos/${slug}/pulls/${pr.number}/comments`, 'created_at'],
      ]) {
        let items = [];
        try {
          items = JSON.parse(run('gh', ['api', '--paginate', endpoint], { timeout: 25000 }));
        } catch {
          continue;
        }
        if (!Array.isArray(items)) continue;

        for (const item of items) {
          if (item.user?.login !== login) continue;
          const stamp = item[field];
          if (!stamp) continue;
          const at = new Date(stamp);
          if (at < from || at >= to) continue;
          signals.push({
            source: 'github',
            at: at.toISOString(),
            ticket,
            text: `Review activity on ${ref}: ${pr.title}`,
            ref,
            url: pr.url,
            repo: pr.repository.name,
          });
        }
      }
    }
    return signals;
  },
};

let cachedLogin = null;
function ghLogin() {
  if (cachedLogin !== null) return cachedLogin;
  try {
    cachedLogin = JSON.parse(run('gh', ['api', 'user', '--jq', '{login:.login}'], { timeout: 8000 })).login;
  } catch {
    cachedLogin = '';
  }
  return cachedLogin;
}

// ------------------------------------------------------------- jira activity

const jiraSource = {
  id: 'jira',
  label: 'Jira activity',
  description: 'Comments you wrote and status transitions you made. Catches ticket work that never touches code.',
  defaultEnabled: false,

  available() {
    const env = config.jiraEnv();
    return env.configured
      ? { ok: true }
      : { ok: false, reason: `Jira is not configured (missing ${env.missing.join(', ')})` };
  },

  async collect({ from, to, cfg }) {
    const jira = require('./jiraWorklog');
    const signals = [];
    const me = await jira.currentUser();
    const since = from.toISOString().slice(0, 10);

    const jql = `(assignee = currentUser() OR reporter = currentUser()) AND updated >= "${since}" ORDER BY updated DESC`;
    const issues = await jira.search({
      jql,
      fields: 'summary,comment',
      expand: 'changelog',
      maxResults: 50,
    });

    for (const issue of issues) {
      const ticket = issue.key;

      for (const comment of issue.fields?.comment?.comments || []) {
        if (comment.author?.accountId !== me.accountId) continue;
        const at = new Date(comment.created);
        if (at < from || at >= to) continue;
        signals.push({
          source: 'jira',
          at: at.toISOString(),
          ticket,
          text: `Commented on ${ticket}`,
          ref: ticket,
          url: null,
          repo: '',
        });
      }

      for (const history of issue.changelog?.histories || []) {
        if (history.author?.accountId !== me.accountId) continue;
        const at = new Date(history.created);
        if (at < from || at >= to) continue;
        const fields = (history.items || []).map(i => i.field).join(', ');
        signals.push({
          source: 'jira',
          at: at.toISOString(),
          ticket,
          text: `Updated ${ticket} (${fields || 'fields'})`,
          ref: ticket,
          url: null,
          repo: '',
        });
      }
    }
    return signals;
  },
};

// -------------------------------------------------------- openorcha initiatives

const initiativeSource = {
  id: 'initiatives',
  label: 'OpenOrcha initiatives',
  description: 'Supervised runs from this app: stage changes, gates and outcomes. Already local, no integration needed.',
  defaultEnabled: false,

  available() {
    try {
      require('./initiativeStore');
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  },

  collect({ from, to, cfg }) {
    const store = require('./initiativeStore');
    const signals = [];

    for (const initiative of store.list() || []) {
      const ticket = initiative.ticket
        ? String(initiative.ticket).toUpperCase()
        : ticketFrom(`${initiative.goal || ''} ${initiative.name || ''}`, cfg);

      for (const event of initiative.events || []) {
        if (!event.ts) continue;
        const at = new Date(event.ts);
        if (at < from || at >= to) continue;
        signals.push({
          source: 'initiatives',
          at: at.toISOString(),
          ticket,
          text: `${initiative.name || 'Initiative'}: ${event.detail || event.type}`.slice(0, 180),
          ref: initiative.id,
          url: null,
          repo: initiative.cwd ? path.basename(initiative.cwd) : '',
        });
      }
    }
    return signals;
  },
};

// ------------------------------------------------------------- git reflog

const reflogSource = {
  id: 'reflog',
  label: 'Branch checkouts',
  description: 'When you switched branches, from the reflog. Bounds when you were sitting on a ticket even if nothing was committed.',
  defaultEnabled: false,

  available(cfg) {
    return config.activeRepos(cfg).length
      ? { ok: true }
      : { ok: false, reason: 'No git repositories found to scan' };
  },

  collect({ from, to, cfg }) {
    const signals = [];
    for (const repo of config.activeRepos(cfg)) {
      const name = path.basename(repo);
      let out = '';
      try {
        out = run('git', ['-C', repo, 'reflog', '--date=iso-strict', '-n', '400']);
      } catch {
        continue;
      }
      for (const line of out.split('\n').filter(Boolean)) {
        const match = line.match(/HEAD@\{([^}]+)\}:\s*(.+)$/);
        if (!match) continue;
        const at = new Date(match[1]);
        if (Number.isNaN(at.getTime()) || at < from || at >= to) continue;
        if (!/^checkout:/.test(match[2])) continue;
        signals.push({
          source: 'reflog',
          at: at.toISOString(),
          ticket: ticketFrom(match[2], cfg),
          text: match[2].slice(0, 180),
          ref: name,
          url: null,
          repo: name,
        });
      }
    }
    return signals;
  },
};

// --------------------------------------------------------------- shell history

const shellSource = {
  id: 'shell',
  label: 'Shell history',
  description: 'Timestamped zsh history. Catches local debugging that never becomes a commit. Needs EXTENDED_HISTORY.',
  defaultEnabled: false,

  available() {
    const file = path.join(os.homedir(), '.zsh_history');
    if (!fs.existsSync(file)) return { ok: false, reason: 'No ~/.zsh_history on this machine' };
    let head = '';
    try {
      head = fs.readFileSync(file, 'latin1').slice(0, 4096);
    } catch {
      return { ok: false, reason: 'Could not read ~/.zsh_history' };
    }
    return /^:\s*\d+:\d+;/m.test(head)
      ? { ok: true }
      : { ok: false, reason: 'History has no timestamps. Add "setopt EXTENDED_HISTORY" to your zshrc.' };
  },

  collect({ from, to, cfg }) {
    const file = path.join(os.homedir(), '.zsh_history');
    const signals = [];
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'latin1');
    } catch {
      return signals;
    }

    for (const line of raw.split('\n')) {
      const match = line.match(/^:\s*(\d+):\d+;(.*)$/);
      if (!match) continue;
      const at = new Date(Number(match[1]) * 1000);
      if (at < from || at >= to) continue;
      const command = match[2].trim();
      if (!command) continue;
      signals.push({
        source: 'shell',
        at: at.toISOString(),
        ticket: ticketFrom(command, cfg),
        text: command.slice(0, 180),
        ref: 'zsh',
        url: null,
        repo: '',
      });
    }
    return signals;
  },
};

// ------------------------------------------------- not wired up on this machine

function unwired(id, label, description, reason) {
  return {
    id,
    label,
    description,
    defaultEnabled: false,
    available: () => ({ ok: false, reason }),
    collect: () => [],
  };
}

const calendarSource = unwired(
  'calendar',
  'Calendar meetings',
  'Meetings, to account for the non-coding half of a day.',
  'Needs a Google Calendar credential. No calendar integration is wired into OpenOrcha yet.',
);

const slackSource = unwired(
  'slack',
  'Slack messages',
  'Messages you sent, for support and discussion time.',
  'Needs a Slack token. No Slack integration is wired into OpenOrcha yet.',
);

// --------------------------------------------------------------------- registry

const SOURCES = [
  gitSource,
  sessionSource,
  githubSource,
  jiraSource,
  initiativeSource,
  reflogSource,
  calendarSource,
  slackSource,
  shellSource,
];

function byId(id) {
  return SOURCES.find(s => s.id === id) || null;
}

function describe(cfg = config.read()) {
  return SOURCES.map(source => {
    let availability;
    try {
      availability = source.available(cfg) || { ok: false, reason: 'Unknown' };
    } catch (err) {
      availability = { ok: false, reason: err.message };
    }
    return {
      id: source.id,
      label: source.label,
      description: source.description,
      enabled: cfg.sources?.[source.id] ?? source.defaultEnabled,
      available: !!availability.ok,
      reason: availability.reason || null,
    };
  });
}

// Runs every enabled, available source over the window. One source failing is
// reported alongside the results rather than sinking the whole collection —
// a missing gh should not cost you your commits.
async function collectAll({ from, to, cfg = config.read(), only = null }) {
  const signals = [];
  const errors = [];
  const used = [];

  for (const source of SOURCES) {
    if (only && !only.includes(source.id)) continue;
    const enabled = cfg.sources?.[source.id] ?? source.defaultEnabled;
    if (!enabled) continue;

    let availability;
    try {
      availability = source.available(cfg) || { ok: false };
    } catch (err) {
      availability = { ok: false, reason: err.message };
    }
    if (!availability.ok) {
      errors.push({ source: source.id, error: availability.reason || 'Unavailable' });
      continue;
    }

    try {
      const produced = await source.collect({ from, to, cfg });
      signals.push(...(produced || []));
      used.push(source.id);
    } catch (err) {
      errors.push({ source: source.id, error: err.message });
    }
  }

  signals.sort((a, b) => new Date(a.at) - new Date(b.at));
  return { signals, errors, used };
}

module.exports = { SOURCES, byId, describe, collectAll, ticketFrom, readTranscript };
