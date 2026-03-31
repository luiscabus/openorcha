const fs = require('fs');
const path = require('path');

function readJsonSafe(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function buildSessionProjectMap(claudeDir) {
  const map = {};
  const sessDir = path.join(claudeDir, 'sessions');
  try {
    for (const f of fs.readdirSync(sessDir)) {
      if (!f.endsWith('.json')) continue;
      const data = readJsonSafe(path.join(sessDir, f));
      if (data && data.sessionId) map[data.sessionId] = data.cwd || '';
    }
  } catch {}
  return map;
}

function readSessionTasks(tasksDir, sessionId) {
  const sessDir = path.join(tasksDir, sessionId);
  const tasks = [];
  try {
    for (const f of fs.readdirSync(sessDir)) {
      if (!f.endsWith('.json')) continue;
      const data = readJsonSafe(path.join(sessDir, f));
      if (data && data.id) {
        data.sessionId = sessionId;
        tasks.push(data);
      }
    }
  } catch {}
  return tasks;
}

function listAllTasks(claudeDir, { status, project } = {}) {
  const tasksDir = path.join(claudeDir, 'tasks');
  const sessionProjectMap = buildSessionProjectMap(claudeDir);
  let all = [];

  try {
    for (const sessionId of fs.readdirSync(tasksDir)) {
      const sessPath = path.join(tasksDir, sessionId);
      let stat;
      try { stat = fs.statSync(sessPath); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const tasks = readSessionTasks(tasksDir, sessionId);
      for (const t of tasks) {
        t.project = sessionProjectMap[sessionId] || '';
      }
      all.push(...tasks);
    }
  } catch {}

  if (status) {
    all = all.filter(t => t.status === status);
  }
  if (project) {
    all = all.filter(t => t.project === project);
  }

  const statusOrder = { in_progress: 0, pending: 1, completed: 2 };
  all.sort((a, b) => (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3));

  return all;
}

function getSessionTasks(claudeDir, sessionId) {
  return readSessionTasks(path.join(claudeDir, 'tasks'), sessionId);
}

function promoteTask(claudeDir, sessionId, taskId) {
  const fp = path.join(claudeDir, 'tasks', sessionId, `${taskId}.json`);
  const task = readJsonSafe(fp);
  if (!task) throw new Error('Task not found');
  return {
    text: task.subject || `Task ${taskId}`,
    description: task.description || '',
    status: 'todo',
    source: 'claude-tasks',
    sourceSession: sessionId,
    sourceTaskId: taskId,
  };
}

module.exports = { listAllTasks, getSessionTasks, promoteTask };
