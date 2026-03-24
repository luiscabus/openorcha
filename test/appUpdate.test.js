const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveUpdateFlags, parseGitStatus } = require('../lib/appUpdate');

test('parseGitStatus counts staged, changed, and untracked files', () => {
  const summary = parseGitStatus('M  lib/appUpdate.js\n M public/js/main.js\n?? test/appUpdate.test.js\n');

  assert.equal(summary.files.length, 3);
  assert.equal(summary.stagedCount, 1);
  assert.equal(summary.changedCount, 1);
  assert.equal(summary.untrackedCount, 1);
  assert.deepEqual(summary.files[2], {
    code: '??',
    path: 'test/appUpdate.test.js',
  });
});

test('deriveUpdateFlags marks behind dirty checkouts as blocked', () => {
  const flags = deriveUpdateFlags({
    isRepo: true,
    upstream: 'origin/master',
    behind: 3,
    dirty: true,
    fetchError: '',
  });

  assert.deepEqual(flags, {
    availability: 'blocked',
    canUpdate: false,
  });
});

test('deriveUpdateFlags marks clean behind checkouts as updateable', () => {
  const flags = deriveUpdateFlags({
    isRepo: true,
    upstream: 'origin/master',
    behind: 2,
    dirty: false,
    fetchError: '',
  });

  assert.deepEqual(flags, {
    availability: 'available',
    canUpdate: true,
  });
});
