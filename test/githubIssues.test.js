const test = require('node:test');
const assert = require('node:assert/strict');

const { parseGitHubRemote } = require('../lib/githubIssues');

test('parseGitHubRemote supports ssh origin urls', () => {
  assert.deepEqual(parseGitHubRemote('git@github.com:luiscabus/openorcha.git'), {
    owner: 'luiscabus',
    repo: 'openorcha',
    slug: 'luiscabus/openorcha',
    remoteUrl: 'git@github.com:luiscabus/openorcha.git',
    repoUrl: 'https://github.com/luiscabus/openorcha',
    issuesUrl: 'https://github.com/luiscabus/openorcha/issues',
  });
});

test('parseGitHubRemote supports https origin urls', () => {
  assert.deepEqual(parseGitHubRemote('https://github.com/luiscabus/openorcha.git'), {
    owner: 'luiscabus',
    repo: 'openorcha',
    slug: 'luiscabus/openorcha',
    remoteUrl: 'https://github.com/luiscabus/openorcha.git',
    repoUrl: 'https://github.com/luiscabus/openorcha',
    issuesUrl: 'https://github.com/luiscabus/openorcha/issues',
  });
});

test('parseGitHubRemote rejects non-github remotes', () => {
  assert.equal(parseGitHubRemote('git@gitlab.com:luiscabus/openorcha.git'), null);
});
