const express = require('express');
const path = require('path');
const { execSync } = require('child_process');
const { AGENT_DEFS, findClaudeSessionFile, parseClaudeSession, findCodexSessionFile, parseCodexSession, parseOpenCodeSession } = require('../lib/agentParsers');
const { buildProcTable, findAncestorApp, getCwdMap } = require('../lib/processTree');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const out = execSync('ps -eo pid,pcpu,pmem,tty,etime,args 2>/dev/null', { encoding: 'utf8' });
    const procs = buildProcTable();
    const matched = [];

    for (const line of out.trim().split('\n').slice(1)) {
      const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(.*)/);
      if (!m) continue;
      const [, pid, cpu, mem, tty, etime, args] = m;
      const bin = path.basename(args.split(/\s+/)[0]);
      const def = AGENT_DEFS.find(d => d.match(bin, args));
      if (!def) continue;
      matched.push({ pid, cpu, mem, tty, etime, args, bin, def });
    }

    const cwdMap = getCwdMap(matched.map(m => m.pid));

    const raw = matched.map(({ pid, cpu, mem, tty, etime, args, bin, def }) => {
      const proc = procs[pid];
      let terminalApp = null;
      if (proc && proc.tty !== '??') {
        terminalApp = findAncestorApp(proc.ppid, procs) || null;
      }
      const cwd = cwdMap[pid] || null;
      const project = cwd ? path.basename(cwd) : null;

      return {
        agentId: def.id,
        agentName: def.name,
        pid,
        cpu: parseFloat(cpu),
        mem: parseFloat(mem),
        tty: tty === '??' ? null : tty,
        etime,
        cwd,
        project,
        terminalApp,
        args,
      };
    });

    // Deduplicate: each agent session (tty+agentId) may spawn multiple processes.
    // Group them and keep only the root (parent not in the same group).
    const groups = {};
    for (const a of raw) {
      const key = `${a.agentId}:${a.tty || a.pid}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(a);
    }

    const agents = [];
    for (const group of Object.values(groups)) {
      if (group.length === 1) {
        agents.push(group[0]);
      } else {
        const pids = new Set(group.map(a => a.pid));
        // Root = the one whose parent PID is not in this group
        const root = group.find(a => !pids.has(procs[a.pid]?.ppid)) || group[0];
        // Sum CPU/MEM across all processes in the group
        root.cpu = group.reduce((s, a) => s + a.cpu, 0);
        root.mem = group.reduce((s, a) => s + a.mem, 0);
        agents.push(root);
      }
    }

    agents.sort((a, b) => a.agentId.localeCompare(b.agentId) || (a.cwd || '').localeCompare(b.cwd || ''));
    res.json({ agents });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:pid/messages', (req, res) => {
  try {
    const { pid } = req.params;
    const psOut = execSync(`ps -p ${pid} -o args= 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (!psOut) return res.status(404).json({ error: 'Process not found' });

    const bin = path.basename(psOut.split(/\s+/)[0]);
    const def = AGENT_DEFS.find(d => d.match(bin, psOut));
    if (!def) return res.status(400).json({ error: 'Not a recognized agent' });

    const cwdMap = getCwdMap([pid]);
    const cwd = cwdMap[pid];
    if (!cwd) return res.json({ messages: [], cwd: null, note: 'Could not determine working directory' });

    let messages = null;
    let sessionFile = null;

    if (def.id === 'claude') {
      sessionFile = findClaudeSessionFile(cwd);
      if (sessionFile) messages = parseClaudeSession(sessionFile);
    } else if (def.id === 'codex') {
      sessionFile = findCodexSessionFile(cwd, psOut);
      if (sessionFile) messages = parseCodexSession(sessionFile);
    } else if (def.id === 'opencode') {
      messages = parseOpenCodeSession(cwd);
    }

    if (messages === null) {
      return res.json({ messages: [], cwd, note: 'No session data found' });
    }

    res.json({
      agentId: def.id,
      agentName: def.name,
      cwd,
      sessionFile: sessionFile ? path.basename(sessionFile) : null,
      messages: messages.slice(-150),
      total: messages.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:pid', (req, res) => {
  try {
    const pid = parseInt(req.params.pid, 10);
    if (!pid || pid <= 1) return res.status(400).json({ error: 'Invalid PID' });
    execSync(`kill ${pid}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
