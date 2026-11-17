// Where "open for me" comes from.
//
// The work log's sources answer a question about the past: what happened
// between these two instants. These answer a question about now — what is mine
// and unfinished — and the difference is not cosmetic. A signal is an instant
// and is true for ever; a commitment is a state, true only when it was read,
// which is why contextStore records every one it is given.
//
// Commitment: { provider, key, kind, title, context, url, repo, state, status,
//               detail, openedAt }
//
// `key` is the ticket where there is one, so a Jira ticket, its pull requests,
// its branch and its initiative collapse into a single context — and into the
// same key the work log files attention under. Work with no ticket keeps a
// name instead, the way the work log names an unattributed block.

const path = require('path');
const { execFileSync } = require('child_process');
const config = require('./workLogConfig');
const { ticketFrom } = require('./workLogSources');

const DEFAULTS = {
  sources: { jira: true, github: true, git: true, initiatives: true },
  // A branch nobody has touched in this long is archaeology, not a commitment.
  branchActiveDays: 45,
  resolvedWithinDays: 30,
  prLimit: 40,
};

function settings(cfg = config.read()) {
  return { ...DEFAULTS, ...(cfg.contexts || {}), sources: { ...DEFAULTS.sources, ...(cfg.contexts?.sources || {}) } };
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout || 15000,
    maxBuffer: 16 * 1024 * 1024,
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

// ----------------------------------------------------------------------- jira

const jiraSource = {
  id: 'jira',
  label: 'Jira',
  description: 'Issues assigned to you that are not done, plus the ones recently finished so closure is recorded rather than guessed.',
  defaultEnabled: true,

  available() {
    const env = config.jiraEnv();
    return env.configured
      ? { ok: true }
      : { ok: false, reason: `Jira is not configured (missing ${env.missing.join(', ')})` };
  },

  async collect({ cfg }) {
    const jira = require('./jiraWorklog');
    const opts = settings(cfg);
    const fields = 'summary,status,created,description';

    const shape = (issue, state) => ({
      provider: 'jira',
      key: issue.key,
      kind: 'ticket',
      title: issue.fields?.summary || null,
      // The ticket's standing subject, in its own words. Read here once and
      // kept, so a board six weeks old can still say what its rows were about.
      context: jira.firstSentences(jira.fromAdf({ body: issue.fields?.description }), 160),
      url: `${config.jiraEnv().baseUrl}/browse/${issue.key}`,
      repo: null,
      state,
      status: issue.fields?.status?.name || null,
      detail: state === 'done' ? null : 'Assigned to you',
      openedAt: issue.fields?.created || null,
    });

    const open = await jira.search({
      jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
      fields,
      maxResults: 100,
    });

    // Asking for the recently finished ones as well is what lets a ticket be
    // recorded as *done* rather than merely absent. Absence is the weaker
    // claim and the board says so.
    const resolved = await jira.search({
      jql: `assignee = currentUser() AND statusCategory = Done AND updated >= -${Math.max(1, opts.resolvedWithinDays)}d ORDER BY updated DESC`,
      fields,
      maxResults: 100,
    });

    return [
      ...open.map(issue => shape(issue, 'open')),
      ...resolved.map(issue => shape(issue, 'done')),
    ];
  },
};

// --------------------------------------------------------------------- github

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

const githubSource = {
  id: 'github',
  label: 'GitHub pull requests',
  description: 'Pull requests waiting on your review and your own open ones. Review is work with no ticket of its own, and it is most of some weeks.',
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

  collect({ cfg }) {
    const opts = settings(cfg);
    const login = ghLogin();
    if (!login) return [];

    const search = args => {
      try {
        const raw = run('gh', [
          'search', 'prs', '--state=open', '--limit', String(opts.prLimit),
          '--json', 'number,title,repository,url,createdAt,isDraft',
          ...args,
        ], { timeout: 30000 });
        return JSON.parse(raw) || [];
      } catch {
        return [];
      }
    };

    const mine = search(['--author=@me']);
    const toReview = search(['--review-requested=@me']);
    // Two extra searches instead of a review-decision call per pull request:
    // "changes requested" is the one PR state that is actually a task.
    const blocked = new Set(search(['--author=@me', '--review=changes_requested']).map(pr => pr.url));

    const shape = (pr, detail) => {
      const ticket = ticketFrom(pr.title, cfg);
      const ref = `${pr.repository?.name}#${pr.number}`;
      return {
        provider: 'github',
        key: ticket || `${pr.repository?.nameWithOwner}#${pr.number}`,
        kind: ticket ? 'ticket' : 'label',
        title: pr.title || null,
        context: null,
        url: pr.url || null,
        repo: pr.repository?.name || null,
        state: 'open',
        status: pr.isDraft ? 'draft PR' : 'PR open',
        detail: `${ref} — ${detail}`,
        openedAt: pr.createdAt || null,
      };
    };

    return [
      ...mine.map(pr => shape(pr, blocked.has(pr.url) ? 'changes requested on yours' : 'your pull request')),
      ...toReview.map(pr => shape(pr, 'waiting on your review')),
    ];
  },
};

// ------------------------------------------------------------------------ git

const DEFAULT_BRANCHES = new Set(['master', 'main', 'develop', 'trunk']);

const gitSource = {
  id: 'git',
  label: 'Branches',
  description: 'Your branches with work that has not landed, and any checkout with uncommitted changes. Catches the thing you put down mid-thought.',
  defaultEnabled: true,

  available(cfg) {
    const repos = config.activeRepos(cfg);
    if (!repos.length) return { ok: false, reason: 'No git repositories found to scan' };
    if (!config.activeAuthors(cfg).length) return { ok: false, reason: 'No git author email configured or detected' };
    return { ok: true };
  },

  collect({ cfg }) {
    const opts = settings(cfg);
    const repos = config.activeRepos(cfg);
    const authors = config.activeAuthors(cfg).map(a => a.toLowerCase());
    const cutoff = Date.now() - opts.branchActiveDays * 86400000;
    const out = [];

    for (const repo of repos) {
      const name = path.basename(repo);

      let head = '';
      try {
        head = run('git', ['-C', repo, 'symbolic-ref', '--short', 'HEAD'], { timeout: 5000 }).trim();
      } catch {
        // Detached head, or not a checkout any more.
      }

      let dirty = false;
      try {
        dirty = !!run('git', ['-C', repo, 'status', '--porcelain'], { timeout: 8000 }).trim();
      } catch {
        // A repo we cannot stat is one row missing, not a failed collection.
      }

      let refs = '';
      try {
        refs = run('git', [
          '-C', repo, 'for-each-ref', 'refs/heads',
          '--format=%(refname:short)%1f%(committerdate:iso-strict)%1f%(upstream:track)%1f%(authoremail)',
        ], { timeout: 10000 });
      } catch {
        continue;
      }

      for (const line of refs.split('\n')) {
        if (!line.trim()) continue;
        const [branch, committed, track, email] = line.split('\x1f');
        if (DEFAULT_BRANCHES.has(branch)) continue;
        if (new Date(committed).getTime() < cutoff) continue;
        if (authors.length && !authors.includes(String(email || '').replace(/[<>]/g, '').toLowerCase())) continue;

        const ahead = /ahead/.test(track || '');
        const gone = /gone/.test(track || '');
        const checkedOut = branch === head;
        // A pushed branch you are not sitting on is not asking you for
        // anything; the pull request speaks for it.
        if (!ahead && !gone && !checkedOut) continue;

        const ticket = ticketFrom(branch, cfg);
        const why = [
          checkedOut && dirty && 'uncommitted changes',
          ahead && 'unpushed commits',
          gone && 'upstream gone',
          checkedOut && !dirty && !ahead && 'checked out',
        ].filter(Boolean);

        out.push({
          provider: 'git',
          key: ticket || `${name} (${branch})`,
          kind: ticket ? 'ticket' : 'label',
          title: ticket ? null : `${name} (${branch})`,
          context: null,
          url: null,
          repo: name,
          state: 'open',
          status: why[0] || 'in progress',
          detail: `${name}:${branch} — ${why.join(', ')}`,
          openedAt: null,
        });
      }
    }

    return out;
  },
};

// ---------------------------------------------------------------- initiatives

const initiativeSource = {
  id: 'initiatives',
  label: 'OpenOrcha initiatives',
  description: 'Runs in flight and the decisions they have parked for you. Already local, and a gate is the most literal kind of open task there is.',
  defaultEnabled: true,

  available() {
    try {
      require('./initiativeStore');
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  },

  collect({ cfg }) {
    const store = require('./initiativeStore');
    const out = [];

    for (const initiative of store.list() || []) {
      const live = ['draft', 'running', 'blocked'].includes(initiative.status);
      const ticket = initiative.ticket
        ? String(initiative.ticket).toUpperCase()
        : ticketFrom(`${initiative.goal || ''} ${initiative.name || ''}`, cfg);

      const gates = (initiative.gates || []).filter(g => !g.resolvedAt).length;
      const stage = initiative.stages?.[initiative.stageIndex || 0]?.name || null;

      out.push({
        provider: 'initiatives',
        key: ticket || initiative.name || initiative.id,
        kind: ticket ? 'ticket' : 'label',
        title: ticket ? null : initiative.name || null,
        context: initiative.goal || null,
        url: null,
        repo: initiative.cwd ? path.basename(initiative.cwd) : null,
        state: live ? 'open' : 'done',
        status: gates ? `${gates} decision${gates === 1 ? '' : 's'} waiting` : `initiative ${initiative.status}`,
        detail: `${initiative.name || 'Initiative'}${stage ? ` — ${stage}` : ''}`,
        openedAt: initiative.createdAt || null,
      });
    }

    return out;
  },
};

// --------------------------------------------------------------------- registry

const SOURCES = [jiraSource, githubSource, gitSource, initiativeSource];

function byId(id) {
  return SOURCES.find(s => s.id === id) || null;
}

function describe(cfg = config.read()) {
  const opts = settings(cfg);
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
      enabled: opts.sources?.[source.id] ?? source.defaultEnabled,
      available: !!availability.ok,
      reason: availability.reason || null,
    };
  });
}

// Who answered matters more here than in the work log. A provider that fails
// reports nothing, which is indistinguishable from reporting that nothing is
// open — so `providers` travels with the results and decides whether an absent
// context may be closed.
async function collectAll({ cfg = config.read(), only = null } = {}) {
  const opts = settings(cfg);
  const commitments = [];
  const errors = [];
  const providers = [];

  for (const source of SOURCES) {
    if (only && !only.includes(source.id)) continue;
    if (!(opts.sources?.[source.id] ?? source.defaultEnabled)) continue;

    let availability;
    try {
      availability = source.available(cfg) || { ok: false };
    } catch (err) {
      availability = { ok: false, reason: err.message };
    }
    if (!availability.ok) {
      errors.push({ provider: source.id, error: availability.reason || 'Unavailable' });
      continue;
    }

    try {
      const produced = await source.collect({ cfg });
      commitments.push(...(produced || []));
      providers.push(source.id);
    } catch (err) {
      errors.push({ provider: source.id, error: err.message });
    }
  }

  return { commitments, providers, errors };
}

module.exports = { DEFAULTS, SOURCES, byId, describe, settings, collectAll };
