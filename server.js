const express = require('express');
const http = require('http');
const path = require('path');
const { attachTerminalSocket } = require('./lib/terminalSocket');
const initiativeSupervisor = require('./lib/initiativeSupervisor');
const contexts = require('./lib/contexts');

const app = express();
const server = http.createServer(app);
const PORT = 3456;
const HOST = '127.0.0.1';

app.use(express.json());
app.use(express.text());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit', 'lib')));

app.use('/api/app',          require('./routes/app'));
app.use('/api/config',       require('./routes/config'));
app.use('/api/keys',         require('./routes/keys'));
app.use('/api/known-hosts',  require('./routes/known-hosts'));
app.use('/api/sessions',     require('./routes/sessions'));
app.use('/api/issues',       require('./routes/issues'));
app.use('/api/agents',       require('./routes/agents'));
app.use('/api/claude',       require('./routes/claudeCode'));
app.use('/api/initiatives',  require('./routes/initiatives'));
app.use('/api/worklog',      require('./routes/workLog'));
app.use('/api/contexts',     require('./routes/contexts'));

attachTerminalSocket(server);

server.listen(PORT, HOST, () => {
  console.log(`OpenOrcha running at http://${HOST}:${PORT}`);
  // Supervises running initiatives: approves in-policy prompts, keeps agents
  // moving between stages, and parks the decisions that need a human.
  initiativeSupervisor.start();
  // What is open can only be recorded as it happens — nothing can tell you
  // later what was waiting on you last Tuesday. A week the server was never
  // running is a blank stretch in the one history here that cannot be rebuilt.
  contexts.startRecording();
});
