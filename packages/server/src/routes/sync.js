const { Router } = require('express');
const { syncAll } = require('../services/orbisxSync');

const router = Router();

router.get('/now', async (req, res) => {
  try {
    const summary = await syncAll();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
