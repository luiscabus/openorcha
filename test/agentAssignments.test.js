const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-assignments-'));
process.env.OPENORCHA_ASSIGNMENTS_DIR = TMP;

const assignments = require('../lib/agentAssignments');

test.afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

// Every agent looks alike in `ps`. Whoever is choosing who to talk to can only
// be as careful as the record lets them be.

test('an agent remembers what it was launched to do', () => {
  assignments.record({
    sessionName: 'init-discovery',
    agentId: 'claude',
    cwd: '/Users/x/soci',
    purpose: 'SO-1 ticket discovery',
    launchedBy: 'initiative:i-1',
    role: 'worker',
  });

  const found = assignments.get('init-discovery');
  assert.equal(found.purpose, 'SO-1 ticket discovery');
  assert.equal(found.cwd, '/Users/x/soci');
  assert.equal(found.launchedBy, 'initiative:i-1');
  assert.equal(found.role, 'worker');
});

test('an agent nobody recorded a reason for reads as unknown, not as available', () => {
  assert.equal(assignments.get('some-random-session'), null);
  assert.equal(assignments.get(null), null);
});

test('relaunching into the same session replaces the remit rather than stacking one', () => {
  assignments.record({ sessionName: 's', purpose: 'first job', cwd: '/a' });
  assignments.record({ sessionName: 's', purpose: 'second job', cwd: '/b' });

  assert.equal(assignments.list().length, 1);
  assert.equal(assignments.get('s').purpose, 'second job');
});

test('an unrecognised role is nobody in particular, not a worker', () => {
  assignments.record({ sessionName: 's', purpose: 'x', role: 'wizard' });
  assert.equal(assignments.get('s').role, 'operator');
});

// The question the whole record exists to answer: is this work this agent's?
test('work belongs to an agent only when it is inside the directory it was given', () => {
  const discovery = { cwd: '/Users/x/soci-services' };

  assert.equal(assignments.covers(discovery, '/Users/x/soci-services'), true);
  assert.equal(assignments.covers(discovery, '/Users/x/soci-services/llp-editor'), true);
  assert.equal(assignments.covers(discovery, '/Users/x/openorcha'), false, 'another project is not its job');
  assert.equal(assignments.covers(discovery, '/Users/x/soci-services-old'), false, 'a prefix is not a parent');
  assert.equal(assignments.covers({ cwd: null }, '/anywhere'), false);
});

test('records for sessions that are gone are pruned, and live ones are kept', () => {
  assignments.record({ sessionName: 'alive', purpose: 'a' });
  assignments.record({ sessionName: 'dead', purpose: 'b' });

  assignments.prune(['alive']);
  assert.deepEqual(assignments.list().map(a => a.sessionName), ['alive']);
  assert.equal(assignments.forget('alive'), true);
  assert.equal(assignments.forget('alive'), false);
});
