const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listFileChanges, getVersionDiff } = require('../lib/claudeDiffs');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-diffs-test-'));
}
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test('listFileChanges finds versioned files grouped by hash', () => {
  const dir = makeTempDir();
  try {
    const sessDir = path.join(dir, 'file-history', 'sess-aaa');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'abc123@v1'), 'function hello() {}');
    fs.writeFileSync(path.join(sessDir, 'abc123@v2'), 'function hello() { return 1; }');
    fs.writeFileSync(path.join(sessDir, 'def456@v1'), 'const x = 1;');

    const sessions = path.join(dir, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, '100.json'), JSON.stringify({
      pid: 100, sessionId: 'sess-aaa', cwd: '/home/ubuntu/proj', startedAt: 1000,
    }));

    const changes = listFileChanges(dir, {});
    assert.equal(changes.length, 2);
    const abc = changes.find(c => c.hash === 'abc123');
    assert.equal(abc.versions, 2);
    assert.equal(abc.project, '/home/ubuntu/proj');
    assert.ok(abc.preview.includes('function hello'));
  } finally {
    cleanup(dir);
  }
});

test('getVersionDiff returns diff between two versions', () => {
  const dir = makeTempDir();
  try {
    const sessDir = path.join(dir, 'file-history', 'sess-bbb');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'abc123@v1'), 'line1\nline2\n');
    fs.writeFileSync(path.join(sessDir, 'abc123@v2'), 'line1\nline2 changed\nline3\n');

    const result = getVersionDiff(dir, 'sess-bbb', 'abc123', 1, 2);
    assert.ok(result.oldContent.includes('line2'));
    assert.ok(result.newContent.includes('line2 changed'));
    assert.ok(result.hunks.length > 0);
  } finally {
    cleanup(dir);
  }
});

test('getVersionDiff returns diff from empty for v1', () => {
  const dir = makeTempDir();
  try {
    const sessDir = path.join(dir, 'file-history', 'sess-ccc');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'xyz789@v1'), 'new file content\n');

    const result = getVersionDiff(dir, 'sess-ccc', 'xyz789', 0, 1);
    assert.equal(result.oldContent, '');
    assert.ok(result.newContent.includes('new file content'));
  } finally {
    cleanup(dir);
  }
});
