const { Router } = require('express');
const { getDb } = require('../../db/schema');

const router = Router();

router.get('/health', (req, res) => {
  try {
    const db = getDb();
    const { ts } = db.prepare("SELECT datetime('now') as ts").get();
    db.close();
    res.json({ status: 'ok', db_time: ts });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
