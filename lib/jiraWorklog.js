// Jira Cloud worklog client.
//
// Credentials come from the environment (JIRA_BASE_URL / JIRA_EMAIL /
// JIRA_API_TOKEN), the same shape githubIssues.js uses for GITHUB_TOKEN.
//
// Nothing in this module runs on a timer or a hook. Every write is called
// from a route that a person triggered, because time going onto a ticket is
// a claim made in someone's name and should never happen on its own.

const https = require('https');
const { jiraEnv } = require('./workLogConfig');

const USER_AGENT = 'OpenOrcha';

function authHeader(env) {
  return 'Basic ' + Buffer.from(`${env.email}:${env.token}`).toString('base64');
}

function requireConfigured() {
  const env = jiraEnv();
  if (!env.configured) {
    const err = new Error(`Jira is not configured. Missing: ${env.missing.join(', ')}`);
    err.statusCode = 412;
    throw err;
  }
  return env;
}

function request(method, apiPath, body) {
  const env = requireConfigured();
  const url = new URL(env.baseUrl + apiPath);
  const payload = body ? JSON.stringify(body) : null;

  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    Authorization: authHeader(env),
  };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers,
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        if (raw) {
          try { parsed = JSON.parse(raw); } catch { parsed = null; }
        }
        resolve({ statusCode: res.statusCode || 500, body: parsed, raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Jira API request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

function assertOk(response, what) {
  if (response.statusCode >= 200 && response.statusCode < 300) return response.body;

  const messages = response.body?.errorMessages;
  const detail = Array.isArray(messages) && messages.length
    ? messages.join('; ')
    : (response.body?.errors && JSON.stringify(response.body.errors))
      || response.raw?.slice(0, 200)
      || `HTTP ${response.statusCode}`;

  const err = new Error(`${what} failed: ${detail}`);
  err.statusCode = response.statusCode;
  throw err;
}

// Plain text in, Atlassian Document Format out. Jira rejects a bare string on
// the v3 API.
function toAdf(text) {
  const value = String(text || '').trim();
  if (!value) return undefined;
  return {
    type: 'doc',
    version: 1,
    content: value.split(/\n{2,}/).map(paragraph => ({
      type: 'paragraph',
      content: [{ type: 'text', text: paragraph.replace(/\n/g, ' ') }],
    })),
  };
}

function fromAdf(comment) {
  if (!comment) return '';
  if (typeof comment === 'string') return comment;
  const walk = node => {
    if (!node) return '';
    if (node.type === 'text') return node.text || '';
    return (node.content || []).map(walk).join('');
  };
  return (comment.content || []).map(walk).join(' ').trim();
}

/** The opening of a description: enough to say what a ticket is about. */
function firstSentences(text, limit) {
  const flat = String(text || '')
    .replace(/^\s*#+\s*/gm, '')          // headings add nothing here
    .replace(/\*\*?|`|_/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return (stop > 60 ? cut.slice(0, stop) : cut.replace(/\s+\S*$/, '')) + '…';
}

// Enough parallel requests to stop a week's tickets queuing, few enough that
// Jira Cloud's rate limiter does not start answering 429.
const JIRA_CONCURRENCY = 6;

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function currentUser() {
  const response = await request('GET', '/rest/api/3/myself');
  const body = assertOk(response, 'Reading the Jira account');
  return {
    accountId: body.accountId,
    displayName: body.displayName,
    emailAddress: body.emailAddress,
    timeZone: body.timeZone,
  };
}

// Issue keys carrying time from this account in the window. The JQL endpoint
// moved in recent Jira Cloud versions, so fall back to the classic one.
async function issuesWithMyWorklogs(fromDayKey, toDayKey) {
  const jql = `worklogAuthor = currentUser() AND worklogDate >= "${fromDayKey}" AND worklogDate <= "${toDayKey}"`;
  const params = new URLSearchParams({ jql, fields: 'summary', maxResults: '100' });

  let response = await request('GET', `/rest/api/3/search/jql?${params}`);
  if (response.statusCode === 404 || response.statusCode === 410) {
    response = await request('GET', `/rest/api/3/search?${params}`);
  }
  const body = assertOk(response, 'Searching Jira for your worklogs');

  return (body.issues || []).map(issue => ({
    key: issue.key,
    summary: issue.fields?.summary || '',
  }));
}

async function worklogsForIssue(issueKey) {
  const response = await request('GET', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog?maxResults=1000`);
  const body = assertOk(response, `Reading worklogs on ${issueKey}`);
  return body.worklogs || [];
}

// Everything this account has logged in the window, flattened. This is what
// makes "already pushed" honest: Jira is the source of truth, and time logged
// by hand or from another machine shows up here too.
async function myWorklogs(fromDayKey, toDayKey, { accountId } = {}) {
  const [me, issues] = await Promise.all([
    accountId ? { accountId } : currentUser(),
    issuesWithMyWorklogs(fromDayKey, toDayKey),
  ]);

  // One call per ticket, so they go out together rather than in a line.
  const perIssue = await mapLimit(issues, JIRA_CONCURRENCY, issue => worklogsForIssue(issue.key));

  const collected = [];
  issues.forEach((issue, index) => {
    for (const log of perIssue[index]) {
      if (log.author?.accountId !== me.accountId) continue;
      collected.push({
        worklogId: String(log.id),
        ticket: issue.key,
        ticketSummary: issue.summary,
        started: log.started,
        // The date as Jira itself renders it, so day bucketing matches the
        // ticket rather than our own timezone maths.
        startedDate: String(log.started || '').slice(0, 10),
        minutes: Math.round((log.timeSpentSeconds || 0) / 60),
        timeSpent: log.timeSpent || '',
        comment: fromAdf(log.comment),
      });
    }
  });
  return collected;
}

async function createWorklog({ ticket, minutes, started, comment }) {
  const body = {
    timeSpentSeconds: Math.max(60, Math.round(minutes) * 60),
    started,
  };
  const adf = toAdf(comment);
  if (adf) body.comment = adf;

  const response = await request('POST', `/rest/api/3/issue/${encodeURIComponent(ticket)}/worklog?notifyUsers=false`, body);
  const created = assertOk(response, `Logging time on ${ticket}`);
  return {
    worklogId: String(created.id),
    started: created.started,
    minutes: Math.round((created.timeSpentSeconds || 0) / 60),
  };
}

// Updating in place keeps the worklog's identity and history. Deleting and
// re-adding would lose both, so drift is always repaired with a PUT.
async function updateWorklog({ ticket, worklogId, minutes, started, comment }) {
  const body = {
    timeSpentSeconds: Math.max(60, Math.round(minutes) * 60),
  };
  if (started) body.started = started;
  const adf = toAdf(comment);
  if (adf) body.comment = adf;

  const response = await request(
    'PUT',
    `/rest/api/3/issue/${encodeURIComponent(ticket)}/worklog/${encodeURIComponent(worklogId)}?notifyUsers=false`,
    body,
  );
  const updated = assertOk(response, `Updating the worklog on ${ticket}`);
  return {
    worklogId: String(updated.id),
    started: updated.started,
    minutes: Math.round((updated.timeSpentSeconds || 0) / 60),
  };
}

// A JQL search with whatever fields the caller needs. The endpoint moved in
// recent Jira Cloud versions, so fall back to the classic path.
async function search({ jql, fields = 'summary', expand = null, maxResults = 50 }) {
  const params = new URLSearchParams({ jql, fields, maxResults: String(maxResults) });
  if (expand) params.set('expand', expand);

  let response = await request('GET', `/rest/api/3/search/jql?${params}`);
  if (response.statusCode === 404 || response.statusCode === 410) {
    response = await request('GET', `/rest/api/3/search?${params}`);
  }
  const body = assertOk(response, 'Searching Jira');
  return body.issues || [];
}

// Title and status for a set of tickets. The EOD post names both, and Jira is
// the only authority for either — inference from commits gets the wording
// close but never right.
async function issueDetails(keys) {
  const unique = [...new Set(keys.filter(Boolean))];
  const out = {};
  await mapLimit(unique, JIRA_CONCURRENCY, async key => {
    try {
      const response = await request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,description`);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        out[key] = {
          title: response.body?.fields?.summary || '',
          status: response.body?.fields?.status?.name || '',
          // What the ticket is for, in its own words. First sentence or two of
          // the description — the post wants the subject, not the spec.
          context: firstSentences(fromAdf({ body: response.body?.fields?.description }), 160),
        };
      }
    } catch {
      // A ticket we cannot read should not sink the whole view.
    }
  });
  return out;
}

module.exports = {
  firstSentences,
  search,
  toAdf,
  fromAdf,
  currentUser,
  myWorklogs,
  worklogsForIssue,
  issuesWithMyWorklogs,
  createWorklog,
  updateWorklog,
  issueDetails,
  requireConfigured,
};
