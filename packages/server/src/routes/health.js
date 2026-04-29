const { Router } = require('express');
const db = require('../../db/schema');

const router = Router();

router.get('/health', async (_req, res) => {
  try {
    const row = await db.queryOne('SELECT CURRENT_TIMESTAMP AS ts');
    res.json({ status: 'ok', db_time: row.ts });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
