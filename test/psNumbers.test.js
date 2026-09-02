const test = require('node:test');
const assert = require('node:assert/strict');

const { psFloat, parsePsLine, parsePsLineShort, parsePsStats } = require('../lib/psNumbers');

// ps formats floats in the machine's locale. On a machine that writes decimals
// with a comma, every dot-only pattern silently matches nothing — which meant
// no agent was ever detected, and the supervisor concluded its agents had died
// and relaunched them, for ever.

test('a ps line parses in both decimal conventions', () => {
  const comma = parsePsLine('82935   0,1  0,4 ttys010     08:38:31 claude');
  const dot = parsePsLine('82935   0.1  0.4 ttys010     08:38:31 claude');
  assert.deepEqual(comma, dot);
  assert.equal(comma.pid, '82935');
  assert.equal(comma.cpu, 0.1);
  assert.equal(comma.mem, 0.4);
  assert.equal(comma.tty, 'ttys010');
  assert.equal(comma.args, 'claude');
});

test('args keep their spaces and flags', () => {
  const p = parsePsLine('123   12,5  3,1 ttys001  1-02:03:04 claude --resume abc --model opus');
  assert.equal(p.args, 'claude --resume abc --model opus');
  assert.equal(p.etime, '1-02:03:04');
  assert.equal(p.cpu, 12.5);
});

test('the short form used by the supervisor parses too', () => {
  const p = parsePsLineShort('93136   0,0 ttys044 claude');
  assert.equal(p.pid, '93136');
  assert.equal(p.cpu, 0);
  assert.equal(p.args, 'claude');
});

test('integer cpu with no decimal part still parses', () => {
  assert.equal(parsePsLine('1   0  0 ?? 10:00 launchd').cpu, 0);
  assert.equal(parsePsLineShort('1   7 ?? launchd').cpu, 7);
});

test('per-process stats parse in both conventions', () => {
  assert.deepEqual(parsePsStats(' 12,5   3,1 08:38:31'), { cpu: 12.5, mem: 3.1, etime: '08:38:31' });
  assert.deepEqual(parsePsStats(' 12.5   3.1 08:38:31'), { cpu: 12.5, mem: 3.1, etime: '08:38:31' });
});

test('header and junk lines are rejected rather than half-parsed', () => {
  assert.equal(parsePsLine('  PID %CPU %MEM   TT       ELAPSED COMMAND'), null);
  assert.equal(parsePsLine(''), null);
  assert.equal(parsePsLineShort('not a ps line'), null);
  assert.equal(parsePsStats('nonsense'), null);
});

test('psFloat is safe on anything ps might hand back', () => {
  assert.equal(psFloat('0,4'), 0.4);
  assert.equal(psFloat('0.4'), 0.4);
  assert.equal(psFloat('12'), 12);
  assert.equal(psFloat(''), 0);
  assert.equal(psFloat(undefined), 0);
  assert.equal(psFloat('junk'), 0);
});

test('a real agent line is recognised as an agent in a comma locale', () => {
  const { AGENT_DEFS } = require('../lib/agentParsers');
  const path = require('path');
  const parsed = parsePsLine('65403   4,5  1,2 ttys015     06:14:12 claude');
  assert.ok(parsed, 'the line must parse at all');
  const bin = path.basename(parsed.args.split(/\s+/)[0]);
  assert.ok(AGENT_DEFS.find(d => d.match(bin, parsed.args)), 'and be matched as Claude Code');
});

// The trust prompt lives in the same pane-parsing path, and missing it kills
// agents: its highlighted option is "No, exit".
test('the workspace trust prompt parses out of a real pane capture', () => {
  const { parsePermissionPrompt } = require('../lib/multiplexer');
  const pane = [
    '────────────────────────────────────────────',
    ' Accessing workspace:',
    ' /Users/soci/soci/worktrees/SO-1/thing',
    " Quick safety check: Is this a project you created or one you trust? (Like your",
    ' own code, a well-known open source project, or work from your team).',
    " Claude Code'll be able to read, edit, and execute files here.",
    ' Security guide',
    ' ❯ No, exit',
    '   Yes, I trust this folder',
    ' Enter to confirm · Esc to cancel',
  ].join('\n');

  const prompt = parsePermissionPrompt(pane);
  assert.ok(prompt, 'the prompt must be detected at all');
  assert.match(prompt.question, /Quick safety check/, 'the question, not an option label');
  assert.deepEqual(prompt.options.map(o => o.label), ['No, exit', 'Yes, I trust this folder']);
  assert.equal(prompt.options[prompt.selectedIdx].label, 'No, exit', 'which is what Enter would have picked');
});
