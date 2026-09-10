const test = require('node:test');
const assert = require('node:assert/strict');

const time = require('../lib/workLogTime');

const TZ = 'America/Chicago';

test('offsetStamp follows daylight saving in the work timezone', () => {
  assert.equal(time.offsetStamp('2026-08-13T16:00:00Z', TZ), '-0500');
  assert.equal(time.offsetStamp('2026-01-13T16:00:00Z', TZ), '-0600');
});

test('jiraStarted renders the wall clock of the work timezone with its offset', () => {
  const instant = time.instantFor('2026-08-13', '11:00', TZ);
  assert.equal(time.jiraStarted(instant, TZ), '2026-08-13T11:00:00.000-0500');
});

test('instantFor round-trips through dayKey and wallClock', () => {
  const instant = time.instantFor('2026-08-13', '09:30', TZ);
  assert.equal(time.dayKey(instant, TZ), '2026-08-13');
  assert.equal(time.wallClock(instant, TZ), '09:30');
});

test('a day is bucketed by the work timezone, not the machine clock', () => {
  // 00:30 on Aug 20 in Chicago is 02:30 on a UTC-3 machine, same Chicago day.
  assert.equal(time.dayKey('2026-08-20T05:30:00Z', TZ), '2026-08-20');
  // 23:30 Chicago on Aug 19 is already Aug 20 in UTC, and must not drift.
  assert.equal(time.dayKey('2026-08-20T04:30:00Z', TZ), '2026-08-19');
});

test('dayRange covers the whole day in the work timezone', () => {
  const { from, to } = time.dayRange('2026-08-13', '2026-08-13', TZ);
  assert.equal(from.toISOString(), '2026-08-13T05:00:00.000Z');
  assert.equal(to.toISOString(), '2026-08-14T05:00:00.000Z');
});

test('weekStart is the Monday of that week', () => {
  assert.equal(time.weekStart('2026-08-13'), '2026-08-10'); // Thursday
  assert.equal(time.weekStart('2026-08-10'), '2026-08-10'); // Monday itself
  assert.equal(time.weekStart('2026-08-16'), '2026-08-10'); // Sunday belongs back
});

test('clusterMinutes measures spans, not signal counts', () => {
  const tight = time.clusterMinutes([
    '2026-08-13T14:00:00Z',
    '2026-08-13T14:20:00Z',
    '2026-08-13T14:40:00Z',
  ]);
  assert.equal(tight.minutes, 40);
  assert.equal(tight.blocks.length, 1);
});

test('clusterMinutes splits on a long silence', () => {
  const split = time.clusterMinutes([
    '2026-08-13T14:00:00Z',
    '2026-08-13T14:20:00Z',
    '2026-08-13T17:00:00Z',
    '2026-08-13T17:30:00Z',
  ]);
  assert.equal(split.blocks.length, 2);
  assert.equal(split.minutes, 50);
});

test('a lone signal still costs something', () => {
  assert.equal(time.clusterMinutes(['2026-08-13T14:00:00Z']).minutes, 15);
  assert.equal(time.clusterMinutes([]).minutes, 0);
});

test('roundMinutes never rounds real work down to nothing', () => {
  assert.equal(time.roundMinutes(7, 15), 15);
  assert.equal(time.roundMinutes(34, 15), 30);
  assert.equal(time.roundMinutes(40, 15), 45);
});

test('formatDuration reads the way a worklog does', () => {
  assert.equal(time.formatDuration(75), '1h 15m');
  assert.equal(time.formatDuration(120), '2h');
  assert.equal(time.formatDuration(45), '45m');
});
