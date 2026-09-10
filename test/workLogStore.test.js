const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-worklog-store-'));
process.env.OPENORCHA_WORKLOG_DIR = TMP;

const store = require('../lib/workLogStore');

test.afterEach(() => {
  for (const file of fs.readdirSync(TMP)) fs.rmSync(path.join(TMP, file));
});

test('an entry normalises its ticket and duration', () => {
  const entry = store.addEntry('2026-09-08', { ticket: ' so-1 ', minutes: '90.4', summary: '  did a thing  ' });
  assert.equal(entry.ticket, 'SO-1');
  assert.equal(entry.minutes, 90);
  assert.equal(entry.summary, 'did a thing');
  assert.equal(entry.push.state, 'unpushed');
});

test('editing a pushed entry marks it drifted rather than losing the link', () => {
  const entry = store.addEntry('2026-09-08', { ticket: 'SO-1', minutes: 60 });
  store.setPush('2026-09-08', entry.id, { state: 'pushed', worklogId: '99', pushedMinutes: 60 });

  const updated = store.updateEntry('2026-09-08', entry.id, { minutes: 90 });
  assert.equal(updated.push.state, 'stale');
  assert.equal(updated.push.worklogId, '99');
});

test('an edit that changes nothing leaves a pushed entry alone', () => {
  const entry = store.addEntry('2026-09-08', { ticket: 'SO-1', minutes: 60, summary: 'x' });
  store.setPush('2026-09-08', entry.id, { state: 'pushed', worklogId: '99', pushedMinutes: 60 });

  const updated = store.updateEntry('2026-09-08', entry.id, { notes: 'a private note' });
  assert.equal(updated.push.state, 'pushed');
});

test('an entry keeps its context name, attention kind, and Jira note apart', () => {
  const entry = store.addEntry('2026-09-08', {
    ticket: 'SO-1',
    minutes: 60,
    label: 'SO-1',
    attention: 'peer-review',
    summary: 'Reviewed the directory-level renderer handler and left six findings.',
    note: 'Code review.',
  });
  assert.equal(entry.attention, 'peer-review');
  assert.equal(entry.note, 'Code review.');
  // The private description and the shared note are deliberately different.
  assert.notEqual(entry.summary, entry.note);
});

test('editing the private summary does not mark a pushed row drifted', () => {
  // Jira only ever received the note, so rewriting the local description
  // cannot put the two out of step.
  const entry = store.addEntry('2026-09-08', { ticket: 'SO-1', minutes: 60, note: 'Code review.' });
  store.setPush('2026-09-08', entry.id, { state: 'pushed', worklogId: '99', pushedMinutes: 60 });

  const updated = store.updateEntry('2026-09-08', entry.id, { summary: 'A fuller account for my own memory.' });
  assert.equal(updated.push.state, 'pushed');
});

test('editing the note does mark a pushed row drifted', () => {
  const entry = store.addEntry('2026-09-08', { ticket: 'SO-1', minutes: 60, note: 'Code review.' });
  store.setPush('2026-09-08', entry.id, { state: 'pushed', worklogId: '99', pushedMinutes: 60 });

  const updated = store.updateEntry('2026-09-08', entry.id, { note: 'Review and fixes.' });
  assert.equal(updated.push.state, 'stale');
});

test('removing a detected entry remembers the dismissal', () => {
  const entry = store.addEntry('2026-09-08', { ticket: 'SO-1', minutes: 60, candidateKey: '2026-09-08|SO-1' });
  store.removeEntry('2026-09-08', entry.id);

  const day = store.readDay('2026-09-08');
  assert.equal(day.entries.length, 0);
  assert.deepEqual(day.dismissed, ['2026-09-08|SO-1']);
});

test('a restored candidate can be offered again', () => {
  store.dismissCandidate('2026-09-08', '2026-09-08|SO-1');
  store.restoreCandidate('2026-09-08', '2026-09-08|SO-1');
  assert.deepEqual(store.readDay('2026-09-08').dismissed, []);
});

test('a day that was never written reads as empty rather than throwing', () => {
  const day = store.readDay('1999-01-01');
  assert.deepEqual(day.entries, []);
  assert.equal(day.date, '1999-01-01');
});

test('an unknown push state cannot be smuggled in', () => {
  const entry = store.addEntry('2026-09-08', { ticket: 'SO-1', minutes: 60, push: { state: 'definitely-fine' } });
  assert.equal(entry.push.state, 'unpushed');
});
