const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findClaudeSessionFile, findCodexSessionFile } = require('../lib/agentParsers');
const { getSessionResolver } = require('../lib/sessionResolvers');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openorcha-session-test-'));
}

function writeJsonl(filePath, entries) {
  fs.writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('Claude matcher separates parallel sessions in the same cwd by pane text', () => {
  const dir = makeTempDir();
  try {
    const faqFile = path.join(dir, 'faq-session.jsonl');
    const locatorFile = path.join(dir, 'locator-session.jsonl');

    writeJsonl(faqFile, [
      {
        type: 'user',
        timestamp: '2026-03-24T12:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'trying to figure out which clients have fields that are faq' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-24T12:05:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'The database query tool is failing at the landlord credential lookup.' }] },
      },
    ]);

    writeJsonl(locatorFile, [
      {
        type: 'user',
        timestamp: '2026-03-24T12:10:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'fetch SO-79132 and perform initial discovery, find relevant parts in code, do not make any changes' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-03-24T12:15:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'SO-79132: Locator API returning outdated data - the approval flow is not promoting changes.' }] },
      },
    ]);

    const faqPane = 'The database query tool is failing at the landlord credential lookup.';
    const locatorPane = 'SO-79132: Locator API returning outdated data - the approval flow is not promoting changes.';

    assert.equal(
      findClaudeSessionFile('/home/ubuntu/soci/soci-dev', '31568', 'claude', 1774353880000, faqPane, { sessionDir: dir }),
      faqFile
    );
    assert.equal(
      findClaudeSessionFile('/home/ubuntu/soci/soci-dev', '24982', 'claude', 1774354637000, locatorPane, { sessionDir: dir }),
      locatorFile
    );
  } finally {
    cleanup(dir);
  }
});

test('Codex matcher separates parallel sessions in the same cwd by pane text', () => {
  const dir = makeTempDir();
  try {
    const cloudflareFile = path.join(dir, 'cloudflare.jsonl');
    const debugFile = path.join(dir, 'debug.jsonl');

    writeJsonl(cloudflareFile, [
      {
        timestamp: '2026-03-24T00:15:44.960Z',
        type: 'session_meta',
        payload: { id: 'cloudflare-session', cwd: '/home/ubuntu/personal/agent-orch' },
      },
      {
        timestamp: '2026-03-24T00:20:00.000Z',
        type: 'response_item',
        payload: { role: 'user', content: [{ type: 'input_text', text: 'I think we need to make available www.openorcha.com as well' }] },
      },
      {
        timestamp: '2026-03-24T00:21:00.000Z',
        type: 'response_item',
        payload: { role: 'assistant', content: [{ type: 'output_text', text: 'www.openorcha.com is now attached to the same Pages project.' }] },
      },
    ]);

    writeJsonl(debugFile, [
      {
        timestamp: '2026-03-24T01:15:44.960Z',
        type: 'session_meta',
        payload: { id: 'debug-session', cwd: '/home/ubuntu/personal/agent-orch' },
      },
      {
        timestamp: '2026-03-24T01:20:00.000Z',
        type: 'response_item',
        payload: { role: 'user', content: [{ type: 'input_text', text: 'current codex sessions are displaying wrong messages' }] },
      },
      {
        timestamp: '2026-03-24T01:21:00.000Z',
        type: 'response_item',
        payload: { role: 'assistant', content: [{ type: 'output_text', text: 'The live panes confirm the two tmux sessions are attached to different Codex processes.' }] },
      },
    ]);

    const files = [
      { fp: cloudflareFile, id: 'cloudflare-session', birthtime: 1000, mtime: 3000, size: fs.statSync(cloudflareFile).size },
      { fp: debugFile, id: 'debug-session', birthtime: 1100, mtime: 4000, size: fs.statSync(debugFile).size },
    ];

    const cloudflarePane = 'www.openorcha.com is now attached to the same Pages project.';
    const debugPane = 'The live panes confirm the two tmux sessions are attached to different Codex processes.';

    assert.equal(
      findCodexSessionFile('/home/ubuntu/personal/agent-orch', '8383', 'codex', 1774335422000, cloudflarePane, { files }),
      cloudflareFile
    );
    assert.equal(
      findCodexSessionFile('/home/ubuntu/personal/agent-orch', '22073', 'codex', 1774357092000, debugPane, { files }),
      debugFile
    );
  } finally {
    cleanup(dir);
  }
});

test('session resolvers expose separate implementations per CLI', () => {
  const claudeResolver = getSessionResolver('claude');
  const codexResolver = getSessionResolver('codex');

  assert.ok(claudeResolver);
  assert.ok(codexResolver);
  assert.notEqual(claudeResolver, codexResolver);
  assert.equal(typeof claudeResolver.resolveLiveSession, 'function');
  assert.equal(typeof codexResolver.resolveLiveSession, 'function');
  assert.equal(typeof claudeResolver.getResumeSessionId, 'function');
  assert.equal(typeof codexResolver.getResumeSessionId, 'function');
});
