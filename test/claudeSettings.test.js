const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getGlobalSettings, getProjectList, getProjectSettings, writeSettings } = require('../lib/claudeSettings');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-settings-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('getGlobalSettings reads settings.json', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'opus' }));
    const result = getGlobalSettings(dir);
    assert.deepEqual(result, { model: 'opus' });
  } finally {
    cleanup(dir);
  }
});

test('getGlobalSettings returns empty object when file missing', () => {
  const dir = makeTempDir();
  try {
    const result = getGlobalSettings(dir);
    assert.deepEqual(result, {});
  } finally {
    cleanup(dir);
  }
});

test('getProjectList finds projects with settings', () => {
  const dir = makeTempDir();
  try {
    const projDir = path.join(dir, 'projects', '-home-ubuntu-myproj');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'settings.json'), '{}');
    const list = getProjectList(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].encoded, '-home-ubuntu-myproj');
    assert.equal(list[0].decoded, '/home/ubuntu/myproj');
  } finally {
    cleanup(dir);
  }
});

test('getProjectSettings reads both settings files', () => {
  const dir = makeTempDir();
  try {
    const projDir = path.join(dir, 'projects', '-home-ubuntu-myproj');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'settings.json'), '{"a":1}');
    fs.writeFileSync(path.join(projDir, 'settings.local.json'), '{"b":2}');
    const result = getProjectSettings(dir, '-home-ubuntu-myproj');
    assert.deepEqual(result.main, { a: 1 });
    assert.deepEqual(result.local, { b: 2 });
  } finally {
    cleanup(dir);
  }
});

test('writeSettings validates JSON and writes', () => {
  const dir = makeTempDir();
  const fp = path.join(dir, 'test.json');
  try {
    writeSettings(fp, '{"valid":true}');
    assert.deepEqual(JSON.parse(fs.readFileSync(fp, 'utf8')), { valid: true });
  } finally {
    cleanup(dir);
  }
});

test('writeSettings rejects invalid JSON', () => {
  const dir = makeTempDir();
  const fp = path.join(dir, 'test.json');
  try {
    assert.throws(() => writeSettings(fp, 'not json'), /Invalid JSON/);
    assert.equal(fs.existsSync(fp), false);
  } finally {
    cleanup(dir);
  }
});
