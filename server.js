const express = require('express');
const http = require('http');
const path = require('path');
const { attachTerminalSocket } = require('./lib/terminalSocket');

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

attachTerminalSocket(server);

server.listen(PORT, HOST, () => {
  console.log(`OpenOrcha running at http://${HOST}:${PORT}`);
});
