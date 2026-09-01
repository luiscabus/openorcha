const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseHistory, getSessions, getSessionDetail } = require('../lib/claudeHistory');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-history-test-'));
}
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test('parseHistory parses JSONL lines with filtering', () => {
  const dir = makeTempDir();
  try {
    const fp = path.join(dir, 'history.jsonl');
    const lines = [
      JSON.stringify({ display: 'fix the bug', pastedContents: {}, timestamp: 1000, project: '/home/ubuntu/proj', sessionId: 'aaa' }),
      JSON.stringify({ display: 'add tests', pastedContents: {}, timestamp: 2000, project: '/home/ubuntu/proj', sessionId: 'aaa' }),
      JSON.stringify({ display: 'deploy it', pastedContents: {}, timestamp: 3000, project: '/home/ubuntu/other', sessionId: 'bbb' }),
    ];
    fs.writeFileSync(fp, lines.join('\n') + '\n');

    const all = parseHistory(fp, {});
    assert.equal(all.length, 3);
    assert.equal(all[0].display, 'deploy it'); // newest first

    const filtered = parseHistory(fp, { project: '/home/ubuntu/proj' });
    assert.equal(filtered.length, 2);

    const searched = parseHistory(fp, { search: 'deploy' });
    assert.equal(searched.length, 1);
  } finally {
    cleanup(dir);
  }
});

test('getSessions groups history by sessionId with cwd from session files', () => {
  const dir = makeTempDir();
  try {
    const fp = path.join(dir, 'history.jsonl');
    const lines = [
      JSON.stringify({ display: 'msg1', pastedContents: {}, timestamp: 1000, project: '/home/ubuntu/proj', sessionId: 'sess-1' }),
      JSON.stringify({ display: 'msg2', pastedContents: {}, timestamp: 2000, project: '/home/ubuntu/proj', sessionId: 'sess-1' }),
      JSON.stringify({ display: 'msg3', pastedContents: {}, timestamp: 5000, project: '/home/ubuntu/other', sessionId: 'sess-2' }),
    ];
    fs.writeFileSync(fp, lines.join('\n') + '\n');

    const sessDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, '100.json'), JSON.stringify({
      pid: 100, sessionId: 'sess-1', cwd: '/home/ubuntu/proj', startedAt: 500,
    }));

    const sessions = getSessions(dir, {});
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].sessionId, 'sess-2'); // newest first
    assert.equal(sessions[1].sessionId, 'sess-1');
    assert.equal(sessions[1].messageCount, 2);
  } finally {
    cleanup(dir);
  }
});

test('getSessionDetail returns entries for a specific session', () => {
  const dir = makeTempDir();
  try {
    const fp = path.join(dir, 'history.jsonl');
    const lines = [
      JSON.stringify({ display: 'msg1', pastedContents: {}, timestamp: 1000, project: '/proj', sessionId: 'target' }),
      JSON.stringify({ display: 'msg2', pastedContents: {}, timestamp: 2000, project: '/proj', sessionId: 'other' }),
      JSON.stringify({ display: 'msg3', pastedContents: {}, timestamp: 3000, project: '/proj', sessionId: 'target' }),
    ];
    fs.writeFileSync(fp, lines.join('\n') + '\n');
    const entries = getSessionDetail(fp, 'target');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].display, 'msg1'); // chronological
  } finally {
    cleanup(dir);
  }
});
