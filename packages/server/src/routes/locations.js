const { Router } = require('express');
const db = require('../../db/schema');

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const rows = await db.query('SELECT id, name, city FROM locations ORDER BY id');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
