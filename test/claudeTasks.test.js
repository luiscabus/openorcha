const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listAllTasks, getSessionTasks, promoteTask } = require('../lib/claudeTasks');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-tasks-test-'));
}
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test('listAllTasks finds tasks across session dirs', () => {
  const dir = makeTempDir();
  try {
    const sessDir = path.join(dir, 'tasks', 'sess-aaa');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, '1.json'), JSON.stringify({
      id: '1', subject: 'Fix bug', description: 'Fix the login bug', status: 'in_progress', blocks: [], blockedBy: [],
    }));
    fs.writeFileSync(path.join(sessDir, '2.json'), JSON.stringify({
      id: '2', subject: 'Add tests', description: 'Unit tests', status: 'completed', blocks: [], blockedBy: [],
    }));
    fs.writeFileSync(path.join(sessDir, '.highwatermark'), '2');

    const sessions = path.join(dir, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, '100.json'), JSON.stringify({
      pid: 100, sessionId: 'sess-aaa', cwd: '/home/ubuntu/proj', startedAt: 1000,
    }));

    const all = listAllTasks(dir, {});
    assert.equal(all.length, 2);
    assert.equal(all[0].subject, 'Fix bug');

    const filtered = listAllTasks(dir, { status: 'completed' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].subject, 'Add tests');
  } finally {
    cleanup(dir);
  }
});

test('getSessionTasks returns tasks for a specific session', () => {
  const dir = makeTempDir();
  try {
    const sessDir = path.join(dir, 'tasks', 'sess-bbb');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, '1.json'), JSON.stringify({
      id: '1', subject: 'Deploy', status: 'pending', blocks: [], blockedBy: [],
    }));

    const tasks = getSessionTasks(dir, 'sess-bbb');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].subject, 'Deploy');
  } finally {
    cleanup(dir);
  }
});

test('promoteTask returns a todo item', () => {
  const dir = makeTempDir();
  try {
    const sessDir = path.join(dir, 'tasks', 'sess-ccc');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, '3.json'), JSON.stringify({
      id: '3', subject: 'Review PR', description: 'Review the auth PR', status: 'pending', blocks: [], blockedBy: [],
    }));
    const todo = promoteTask(dir, 'sess-ccc', '3');
    assert.equal(todo.text, 'Review PR');
    assert.equal(todo.description, 'Review the auth PR');
    assert.equal(todo.source, 'claude-tasks');
  } finally {
    cleanup(dir);
  }
});
