const express = require('express');
const { applyAppUpdate, getAppUpdateStatus } = require('../lib/appUpdate');

const router = express.Router();

router.get('/update-status', (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    const localOnly = req.query.local === '1';
    res.json(getAppUpdateStatus({ forceFetch: refresh, localOnly }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/update', (req, res) => {
  try {
    res.json(applyAppUpdate());
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details || {}),
    });
  }
});

module.exports = router;
