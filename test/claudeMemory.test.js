const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listProjects, getProjectMemory, writeClaudeMd, writeMemoryFile, createMemoryFile, deleteMemoryFile } = require('../lib/claudeMemory');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-memory-test-'));
}
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test('listProjects returns decoded paths with counts', () => {
  const dir = makeTempDir();
  try {
    const projDir = path.join(dir, 'projects', '-home-ubuntu-myproj');
    fs.mkdirSync(path.join(projDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(projDir, 'memory', 'user_role.md'), '---\nname: Role\ntype: user\n---\nDev');
    fs.writeFileSync(path.join(projDir, 'CLAUDE.md'), '# Rules');
    const list = listProjects(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].decoded, '/home/ubuntu/myproj');
    assert.equal(list[0].memoryCount, 1);
    assert.equal(list[0].hasClaudeMd, true);
  } finally {
    cleanup(dir);
  }
});

test('getProjectMemory returns claudeMd, memoryMd, and parsed memory files', () => {
  const dir = makeTempDir();
  try {
    const projDir = path.join(dir, 'projects', '-home-ubuntu-myproj');
    fs.mkdirSync(path.join(projDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(projDir, 'CLAUDE.md'), '# Rules\nNo mocks');
    fs.writeFileSync(path.join(projDir, 'MEMORY.md'), '- [Role](memory/role.md)');
    fs.writeFileSync(path.join(projDir, 'memory', 'role.md'), '---\nname: User Role\ndescription: Dev role\ntype: user\n---\nSenior dev');
    const result = getProjectMemory(dir, '-home-ubuntu-myproj');
    assert.equal(result.claudeMd, '# Rules\nNo mocks');
    assert.equal(result.memoryMd, '- [Role](memory/role.md)');
    assert.equal(result.memories.length, 1);
    assert.equal(result.memories[0].name, 'User Role');
    assert.equal(result.memories[0].type, 'user');
    assert.equal(result.memories[0].body, 'Senior dev');
  } finally {
    cleanup(dir);
  }
});

test('writeClaudeMd creates and overwrites', () => {
  const dir = makeTempDir();
  try {
    const projDir = path.join(dir, 'projects', '-home-ubuntu-myproj');
    fs.mkdirSync(projDir, { recursive: true });
    writeClaudeMd(dir, '-home-ubuntu-myproj', '# New');
    assert.equal(fs.readFileSync(path.join(projDir, 'CLAUDE.md'), 'utf8'), '# New');
    writeClaudeMd(dir, '-home-ubuntu-myproj', '# Updated');
    assert.equal(fs.readFileSync(path.join(projDir, 'CLAUDE.md'), 'utf8'), '# Updated');
  } finally {
    cleanup(dir);
  }
});

test('createMemoryFile writes with frontmatter', () => {
  const dir = makeTempDir();
  try {
    const projDir = path.join(dir, 'projects', '-home-ubuntu-myproj');
    fs.mkdirSync(path.join(projDir, 'memory'), { recursive: true });
    const filename = createMemoryFile(dir, '-home-ubuntu-myproj', {
      name: 'Test', description: 'A test', type: 'feedback', body: 'Content here',
    });
    const content = fs.readFileSync(path.join(projDir, 'memory', filename), 'utf8');
    assert.ok(content.includes('name: Test'));
    assert.ok(content.includes('type: feedback'));
    assert.ok(content.includes('Content here'));
  } finally {
    cleanup(dir);
  }
});

test('deleteMemoryFile removes the file', () => {
  const dir = makeTempDir();
  try {
    const projDir = path.join(dir, 'projects', '-home-ubuntu-myproj');
    fs.mkdirSync(path.join(projDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(projDir, 'memory', 'test.md'), 'data');
    deleteMemoryFile(dir, '-home-ubuntu-myproj', 'test.md');
    assert.equal(fs.existsSync(path.join(projDir, 'memory', 'test.md')), false);
  } finally {
    cleanup(dir);
  }
});
