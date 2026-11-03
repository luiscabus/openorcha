const express = require('express');
const config = require('../lib/workLogConfig');
const store = require('../lib/workLogStore');
const sources = require('../lib/workLogSources');
const detect = require('../lib/workLogDetect');
const summary = require('../lib/workLogSummary');
const time = require('../lib/workLogTime');
const jira = require('../lib/jiraWorklog');
const cache = require('../lib/workLogCache');
const jiraCache = require('../lib/jiraReadCache');

const router = express.Router();

// Jira is read for reconciliation only. A Jira outage must degrade to a local
// view rather than an error page, so the failure is reported beside the data.
//
// Both reads go through jiraCache: a finished day's evidence costs nothing to
// re-read, and without it every view still waited seconds on Jira.
const ME_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A span that includes today is where time is still being logged.
const WORKLOGS_TODAY_TTL_MS = 2 * 60 * 1000;
const WORKLOGS_PAST_TTL_MS = 15 * 60 * 1000;
const ISSUE_TTL_MS = 30 * 60 * 1000;

async function readJira(fromDay, toDay, { refresh = false } = {}) {
  if (!config.jiraEnv().configured) {
    return { worklogs: [], error: null, configured: false };
  }
  try {
    const today = time.todayKey(config.read().workTimezone);
    const me = await jiraCache.read('me', { ttlMs: ME_TTL_MS, loader: () => jira.currentUser() });
    const worklogs = await jiraCache.read(`worklogs:${fromDay}:${toDay}`, {
      ttlMs: toDay >= today ? WORKLOGS_TODAY_TTL_MS : WORKLOGS_PAST_TTL_MS,
      refresh,
      loader: () => jira.myWorklogs(fromDay, toDay, { accountId: me.accountId }),
    });
    // Reads cached before myWorklogs kept to its window still carry other days.
    return { worklogs: jira.withinDays(worklogs, fromDay, toDay), error: null, configured: true };
  } catch (err) {
    return { worklogs: [], error: err.message, configured: true };
  }
}

// Titles and statuses for the tickets a view mentions. The EOD post names both,
// and only Jira actually knows them — without it the model's guess from PR
// titles stands in.
async function readTicketDetails(tickets, { refresh = false } = {}) {
  const keys = [...new Set(tickets.filter(Boolean))];
  if (!keys.length || !config.jiraEnv().configured) return {};
  const out = {};
  await Promise.all(keys.map(async key => {
    try {
      out[key] = await jiraCache.read(`issue:${key}`, {
        ttlMs: ISSUE_TTL_MS,
        refresh,
        loader: async () => {
          const details = (await jira.issueDetails([key]))[key];
          // Unreadable is not an answer to keep; the next view asks again.
          if (!details) throw new Error(`could not read ${key}`);
          return details;
        },
      });
    } catch {
      // Falls back to the model's inference for this one ticket.
    }
  }));
  return out;
}

function validDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function badDay(res) {
  return res.status(400).json({ error: 'Expected a date as YYYY-MM-DD' });
}

router.get('/config', (req, res) => {
  try {
    const cfg = config.read();
    res.json({
      config: cfg,
      sources: sources.describe(cfg),
      jira: (() => { const { token, ...rest } = config.jiraEnv(); return rest; })(),
      repos: config.activeRepos(cfg),
      authors: config.activeAuthors(cfg),
      today: time.todayKey(cfg.workTimezone),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/config', (req, res) => {
  try {
    // No cache sweep needed: an entry records the fingerprint of the settings
    // that produced it, so a change that matters invalidates itself and one
    // that does not keeps its reads.
    const next = config.write(req.body || {});
    res.json({ config: next, sources: sources.describe(next) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/repos', (req, res) => {
  try {
    const cfg = config.read();
    res.json({ discovered: config.discoverRepos(cfg.repoRoots), selected: cfg.repos || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Confirms Jira credentials work before you find out mid-push.
router.get('/jira/check', async (req, res) => {
  try {
    const me = await jira.currentUser();
    res.json({ ok: true, account: me });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.get('/day/:date', async (req, res) => {
  if (!validDay(req.params.date)) return badDay(res);
  try {
    const cfg = config.read();
    const dayKey = req.params.date;

    const refresh = req.query.refresh === '1';
    // After an edit the page re-reads the day it is showing; re-collecting it
    // then would turn a saved field into a minute's wait.
    const reuse = req.query.reuse === '1';
    const collected = await cache.collectDays({ dayKeys: [dayKey], cfg, refresh, reuse });
    const signals = collected.byDay.get(dayKey)?.signals || [];
    const narration = collected.byDay.get(dayKey)?.narration || null;

    // The tickets your own rows mention are known before Jira answers, so
    // their titles are fetched alongside the worklogs rather than after them.
    const local = detect.assembleDay({ dayKey, signals, narration, cfg });
    const [jiraResult, localDetails] = await Promise.all([
      readJira(dayKey, dayKey, { refresh }),
      readTicketDetails(local.rows.map(r => r.ticket), { refresh }),
    ]);

    // Then only what Jira itself added: time logged by hand or elsewhere.
    const extra = jiraResult.worklogs.map(w => w.ticket).filter(t => t && !(t in localDetails));
    const ticketDetails = { ...localDetails, ...(await readTicketDetails(extra, { refresh })) };

    const day = detect.assembleDay({
      dayKey,
      signals,
      narration,
      jiraWorklogs: jiraResult.worklogs,
      cfg,
      ticketDetails,
    });

    res.json({
      ...day,
      sources: { used: collected.meta.used, errors: collected.meta.errors },
      narration: {
        model: collected.byDay.get(dayKey)?.narration?.model || null,
        error: collected.meta.narrationErrors[0] || null,
      },
      cache: {
        collectedAt: collected.meta.collectedAt,
        fromCache: collected.meta.fromCache.includes(dayKey),
        outdated: collected.meta.outdated.includes(dayKey),
        sealed: dayKey < time.todayKey(cfg.workTimezone),
      },
      jira: { configured: jiraResult.configured, error: jiraResult.error },
      // What this tool writes from the rows, recomputed every view.
      message: summary.buildDayMessage({ date: dayKey, rows: day.rows, cfg }),
      // What you actually posted, if you saved it. Never overwritten by the
      // generated message above.
      posted: store.readDay(dayKey).eod,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/week/:date', async (req, res) => {
  if (!validDay(req.params.date)) return badDay(res);
  try {
    const cfg = config.read();
    const start = time.weekStart(req.params.date);
    const dayKeys = Array.from({ length: 7 }, (_, i) => time.shiftDay(start, i));

    const [collected, jiraResult] = await Promise.all([
      cache.collectDays({ dayKeys, cfg, refresh: req.query.refresh === '1', reuse: req.query.reuse === '1' }),
      readJira(dayKeys[0], dayKeys[6], { refresh: req.query.refresh === '1' }),
    ]);

    const days = dayKeys.map(dayKey => detect.assembleDay({
      dayKey,
      signals: collected.byDay.get(dayKey)?.signals || [],
      narration: collected.byDay.get(dayKey)?.narration || null,
      jiraWorklogs: jiraResult.worklogs.filter(w => w.startedDate === dayKey),
      cfg,
      // The week shows totals and tickets, never the evidence panel.
      evidenceLimit: 0,
    }));

    res.json({
      weekStart: start,
      days,
      sources: { used: collected.meta.used, errors: collected.meta.errors },
      cache: {
        collectedAt: collected.meta.collectedAt,
        fromCache: collected.meta.fromCache.length === dayKeys.length,
        cachedDays: collected.meta.fromCache.length,
        outdated: collected.meta.outdated.length > 0,
      },
      jira: { configured: jiraResult.configured, error: jiraResult.error },
      message: summary.buildWeekMessage({ days, cfg }),
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/cache', (req, res) => {
  try {
    res.json(cache.stats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Drops cached reads so the next view collects again. Only touches derived
// data — your entries and anything in Jira are untouched.
router.delete('/cache', (req, res) => {
  try {
    const { dates } = req.body || {};
    const removed = Array.isArray(dates) && dates.length ? cache.clearDays(dates) : cache.clearAll();
    if (Array.isArray(dates) && dates.length) dates.forEach(d => jiraCache.invalidateWorklogDay(d));
    else jiraCache.clear();
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/day/:date/entries', (req, res) => {
  if (!validDay(req.params.date)) return badDay(res);
  try {
    res.json(store.addEntry(req.params.date, req.body || {}));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/day/:date/entries/:id', (req, res) => {
  if (!validDay(req.params.date)) return badDay(res);
  try {
    const updated = store.updateEntry(req.params.date, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'No such entry' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/day/:date/entries/:id', (req, res) => {
  if (!validDay(req.params.date)) return badDay(res);
  try {
    store.removeEntry(req.params.date, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/day/:date/dismiss', (req, res) => {
  if (!validDay(req.params.date)) return badDay(res);
  try {
    const { candidateKey } = req.body || {};
    if (!candidateKey) return res.status(400).json({ error: 'candidateKey is required' });
    res.json(store.dismissCandidate(req.params.date, candidateKey));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/day/:date/restore', (req, res) => {
  if (!validDay(req.params.date)) return badDay(res);
  try {
    const { candidateKey } = req.body || {};
    if (!candidateKey) return res.status(400).json({ error: 'candidateKey is required' });
    res.json(store.restoreCandidate(req.params.date, candidateKey));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Back to the text a row was first written with.
router.post('/day/:date/entries/:id/revert', (req, res) => {
  if (!validDay(req.params.date)) return badDay(res);
  try {
    const reverted = store.revertEntry(req.params.date, req.params.id, {
      includeMinutes: req.body?.includeMinutes === true,
    });
    if (!reverted) return res.status(404).json({ error: 'No such entry, or nothing to revert to' });
    res.json(reverted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The EOD you posted, kept beside the generated one. `drafted` is the
// generated message at the moment you saved, so the two can be compared later.
router.put('/day/:date/eod', (req, res) => {
  if (!validDay(req.params.date)) return badDay(res);
  try {
    const { text, drafted, source, slackTs } = req.body || {};
    res.json(store.setEod(req.params.date, { text, drafted, source, slackTs }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/day/:date/eod', (req, res) => {
  if (!validDay(req.params.date)) return badDay(res);
  try {
    store.clearEod(req.params.date);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Paste one or more Slack posts; each fenced block is filed under the date on
// its first line. A post covering two days lands on both.
router.post('/eod/import', (req, res) => {
  try {
    const days = summary.parsePosted(req.body?.text);
    if (!days.length) return res.status(400).json({ error: 'No dated EOD block found — the first line of each block should be YYYY-MM-DD' });
    const saved = days.map(({ date, text }) => ({ date, eod: store.setEod(date, { text, source: 'slack', slackTs: req.body?.slackTs || null }) }));
    res.json({ saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// The only path that writes to Jira.
//
// It runs for one entry, only when called, and only with an explicit confirm
// in the body. Nothing schedules it and no supervisor reaches it: time landing
// on a ticket in your name is a claim, and a person makes it.
router.post('/day/:date/entries/:id/push', async (req, res) => {
  if (!validDay(req.params.date)) return badDay(res);

  const { confirm } = req.body || {};
  if (confirm !== true) {
    return res.status(400).json({ error: 'Pushing to Jira requires an explicit confirm' });
  }

  try {
    const cfg = config.read();
    const day = store.readDay(req.params.date);
    const entry = day.entries.find(e => e.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'No such entry' });
    if (!entry.ticket) return res.status(400).json({ error: 'This entry has no ticket to log against' });
    if (!entry.minutes) return res.status(400).json({ error: 'This entry has no time to log' });

    const started = time.jiraStarted(
      time.instantFor(entry.date, entry.startTime || cfg.defaultStartHour, cfg.workTimezone),
      cfg.workTimezone,
    );

    const payload = {
      ticket: entry.ticket,
      minutes: entry.minutes,
      started,
      // Jira gets the short note, not the summary. The summary is a private
      // record of what happened; a shared ticket only wants the shape of it.
      comment: entry.note || '',
    };

    // An entry that already carries a worklog id is repaired in place, so the
    // worklog keeps its identity and history instead of being replaced.
    const result = entry.push?.worklogId
      ? await jira.updateWorklog({ ...payload, worklogId: entry.push.worklogId })
      : await jira.createWorklog(payload);

    // What Jira holds for this day just changed; the next view must not
    // show the copy from before it.
    jiraCache.invalidateWorklogDay(req.params.date);

    const saved = store.setPush(req.params.date, entry.id, {
      state: 'pushed',
      worklogId: result.worklogId,
      pushedAt: new Date().toISOString(),
      pushedMinutes: result.minutes,
      error: null,
    });

    res.json({ entry: saved, jira: result });
  } catch (err) {
    // A failure may still have landed (a timeout after Jira wrote it), so the
    // next view asks Jira rather than trusting the cached copy.
    jiraCache.invalidateWorklogDay(req.params.date);
    store.setPush(req.params.date, req.params.id, { state: 'failed', error: err.message });
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
