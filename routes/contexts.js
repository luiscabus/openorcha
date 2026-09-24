const express = require('express');
const config = require('../lib/workLogConfig');
const contexts = require('../lib/contexts');
const store = require('../lib/contextStore');
const sources = require('../lib/contextSources');
const time = require('../lib/workLogTime');

const router = express.Router();

function validDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

router.get('/config', (req, res) => {
  try {
    const cfg = config.read();
    res.json({
      settings: sources.settings(cfg),
      sources: sources.describe(cfg),
      lastObservation: store.lastObservation(),
      due: contexts.dueForObservation(cfg),
      today: time.todayKey(cfg.workTimezone),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The board. Opening it takes a look as well, unless one was taken recently —
// the history is only as good as how often something writes to it, and this is
// the moment you are most likely to care.
router.get('/', async (req, res) => {
  try {
    const cfg = config.read();
    const { from, to } = req.query;
    if (from && !validDay(from)) return res.status(400).json({ error: 'Expected from as YYYY-MM-DD' });
    if (to && !validDay(to)) return res.status(400).json({ error: 'Expected to as YYYY-MM-DD' });

    let observation = null;
    let observeError = null;
    if (req.query.observe !== 'false') {
      try {
        observation = (await contexts.record({ cfg, force: req.query.observe === 'now' })).observation;
      } catch (err) {
        // A board drawn from what is already recorded beats an error page.
        observeError = err.message;
      }
    }

    res.json({ ...contexts.board({ from, to, cfg }), observation, observeError });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// What was open on one day, and how near the closest look was. The second part
// is not decoration: an answer assembled from an observation four days later is
// a weaker claim, and the caller should be able to see that.
router.get('/open/:date', (req, res) => {
  try {
    if (!validDay(req.params.date)) return res.status(400).json({ error: 'Expected a date as YYYY-MM-DD' });
    res.json(contexts.openOn(req.params.date, { cfg: config.read() }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Keys carry slashes and hashes (meetsoci/soci#24754), so they travel as a
// query rather than a path segment.
router.get('/history', (req, res) => {
  try {
    const key = String(req.query.key || '').trim();
    if (!key) return res.status(400).json({ error: 'Expected ?key=' });
    const found = contexts.history(key, { cfg: config.read() });
    if (!found) return res.status(404).json({ error: `Nothing recorded for ${key}` });
    res.json(found);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/observations', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 2000));
    const all = store.readObservations();
    res.json({ observations: all.slice(-limit).reverse(), total: all.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/observe', async (req, res) => {
  try {
    res.json(await contexts.record({ cfg: config.read(), force: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/', (req, res) => {
  try {
    const key = String(req.query.key || '').trim();
    if (!key) return res.status(400).json({ error: 'Expected ?key=' });
    res.json({ removed: store.forget(key) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
