const { execSync } = require('child_process');
const https = require('https');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

function parseGitHubRemote(remoteUrl) {
  const value = String(remoteUrl || '').trim();
  if (!value) return null;

  const patterns = [
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
    /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match) continue;

    const owner = match[1];
    const repo = match[2];
    return {
      owner,
      repo,
      slug: `${owner}/${repo}`,
      remoteUrl: value,
      repoUrl: `https://github.com/${owner}/${repo}`,
      issuesUrl: `https://github.com/${owner}/${repo}/issues`,
    };
  }

  return null;
}

function getOriginRemote(cwd = REPO_ROOT) {
  try {
    return execSync('git config --get remote.origin.url', {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function getGitHubRepoFromOrigin(cwd = REPO_ROOT) {
  const remoteUrl = getOriginRemote(cwd);
  const repo = parseGitHubRemote(remoteUrl);
  if (repo) return repo;

  const err = new Error(remoteUrl
    ? 'Origin remote is not a GitHub repository'
    : 'No origin remote configured for this checkout');
  err.statusCode = 400;
  throw err;
}

function requestGitHubJson(apiPath) {
  const token = process.env.GITHUB_TOKEN || '';
  const headers = {
    'User-Agent': 'OpenOrcha',
    'Accept': 'application/vnd.github+json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      port: 443,
      path: apiPath,
      method: 'GET',
      headers,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let json = null;
        if (body) {
          try {
            json = JSON.parse(body);
          } catch {
            json = null;
          }
        }
        resolve({
          statusCode: res.statusCode || 500,
          headers: res.headers,
          body: json,
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('GitHub API request timed out')));
    req.end();
  });
}

function mapIssue(issue) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    htmlUrl: issue.html_url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    comments: issue.comments,
    author: issue.user?.login || '',
    labels: Array.isArray(issue.labels)
      ? issue.labels.map(label => ({
          name: label.name,
          color: label.color,
          description: label.description || '',
        }))
      : [],
  };
}

function buildGitHubApiError(response, repo) {
  const message = response.body?.message || 'GitHub API request failed';
  const err = new Error(message);
  err.statusCode = response.statusCode;

  if (response.statusCode === 404) {
    err.message = `GitHub could not access ${repo.slug}. The repository may be private or anonymous issue access is unavailable.`;
  } else if (response.statusCode === 403) {
    err.message = 'GitHub API rate limit exceeded or access was denied. Set GITHUB_TOKEN to increase limits.';
  }

  return err;
}

async function fetchGitHubIssuesData({ cwd = REPO_ROOT, state = 'open', perPage = 30 } = {}) {
  const repo = getGitHubRepoFromOrigin(cwd);
  const pageSize = Math.max(1, Math.min(Number(perPage) || 30, 100));
  const issueState = ['open', 'closed', 'all'].includes(state) ? state : 'open';
  const query = new URLSearchParams({
    state: issueState,
    sort: 'updated',
    direction: 'desc',
    per_page: String(pageSize),
  });

  const [repoResponse, issuesResponse] = await Promise.all([
    requestGitHubJson(`/repos/${repo.slug}`),
    requestGitHubJson(`/repos/${repo.slug}/issues?${query.toString()}`),
  ]);

  if (repoResponse.statusCode < 200 || repoResponse.statusCode >= 300) {
    throw buildGitHubApiError(repoResponse, repo);
  }
  if (issuesResponse.statusCode < 200 || issuesResponse.statusCode >= 300) {
    throw buildGitHubApiError(issuesResponse, repo);
  }

  const issues = Array.isArray(issuesResponse.body)
    ? issuesResponse.body.filter(issue => !issue.pull_request).map(mapIssue)
    : [];

  return {
    repo: {
      ...repo,
      visibility: repoResponse.body?.visibility || (repoResponse.body?.private ? 'private' : 'public'),
      isPrivate: !!repoResponse.body?.private,
      anonymousAccess: !process.env.GITHUB_TOKEN,
      openIssuesCount: repoResponse.body?.open_issues_count ?? null,
    },
    issues,
    filter: issueState,
    fetchedAt: new Date().toISOString(),
    rateLimit: {
      remaining: issuesResponse.headers['x-ratelimit-remaining'] || repoResponse.headers['x-ratelimit-remaining'] || null,
      reset: issuesResponse.headers['x-ratelimit-reset'] || repoResponse.headers['x-ratelimit-reset'] || null,
    },
  };
}

module.exports = {
  fetchGitHubIssuesData,
  getGitHubRepoFromOrigin,
  parseGitHubRemote,
};
