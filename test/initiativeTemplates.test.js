const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const templates = require('../lib/initiativeTemplates');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-templates-test-'));
process.env.OPENORCHA_INITIATIVES_DIR = dir;
// Never start a real agent from a test run.
process.env.OPENORCHA_NO_LAUNCH = '1';
const store = require('../lib/initiativeStore');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the shipped templates cover the kinds of work that actually happen', () => {
  const ids = templates.list().map(t => t.id);
  for (const expected of ['pr-review', 'spec-to-tickets', 'ticket-to-pr', 'poc-spike', 'discovery']) {
    assert.ok(ids.includes(expected), `missing template: ${expected}`);
  }
});

test('every template is usable: stages with instructions, a known profile, a fan-out point', () => {
  for (const t of templates.list()) {
    assert.ok(t.stages.length >= 3, `${t.id} needs stages`);
    assert.ok(t.summary && t.when, `${t.id} needs a summary and a when`);
    assert.ok(['conservative', 'standard', 'ship'].includes(t.profile), `${t.id} has an unknown profile`);
    for (const stage of t.stages) {
      assert.ok(stage.instruction.length > 30, `${t.id}/${stage.id} needs a real instruction`);
    }
    if (t.fanOutStage) {
      assert.ok(t.stages.some(s => s.id === t.fanOutStage), `${t.id} fans out on a stage it does not have`);
    }
  }
});

test('creating from a template takes its stages, profile and parallelism', () => {
  const initiative = store.create({ name: 'Review 12502', cwd: dir, template: 'pr-review' });
  assert.equal(initiative.template, 'pr-review');
  assert.equal(initiative.profile, 'ship');
  assert.equal(initiative.maxParallel, 4);
  assert.deepEqual(initiative.stages.map(s => s.id), ['fetch', 'assess', 'draft', 'post', 'follow-up']);
});

test('what the caller sets explicitly beats the template', () => {
  const initiative = store.create({ name: 'Careful review', cwd: dir, template: 'pr-review', profile: 'conservative', maxParallel: 1 });
  assert.equal(initiative.profile, 'conservative');
  assert.equal(initiative.maxParallel, 1);
});

test('an unknown template falls back to the default pipeline rather than failing', () => {
  const initiative = store.create({ name: 'Whatever', cwd: dir, template: 'no-such-template' });
  assert.deepEqual(initiative.stages.map(s => s.id), ['plan', 'branch', 'implement', 'verify', 'commit', 'ship']);
});

test('the default pipeline is the ticket-to-pr template, defined in one place', () => {
  assert.deepEqual(
    store.defaultStages().map(s => s.id),
    templates.get('ticket-to-pr').stages.map(s => s.id),
  );
});
