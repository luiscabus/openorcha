const express = require('express');
const path = require('path');

const app = express();
const PORT = 3456;
const HOST = '127.0.0.1';

app.use(express.json());
app.use(express.text());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/config',       require('./routes/config'));
app.use('/api/keys',         require('./routes/keys'));
app.use('/api/known-hosts',  require('./routes/known-hosts'));
app.use('/api/sessions',     require('./routes/sessions'));
app.use('/api/agents',       require('./routes/agents'));

app.listen(PORT, HOST, () => {
  console.log(`OpenOrcha running at http://${HOST}:${PORT}`);
});
