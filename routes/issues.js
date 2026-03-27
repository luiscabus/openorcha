const express = require('express');
const { fetchGitHubIssuesData } = require('../lib/githubIssues');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const state = req.query.state || 'open';
    const perPage = req.query.perPage || 30;
    const data = await fetchGitHubIssuesData({ state, perPage });
    res.json(data);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
