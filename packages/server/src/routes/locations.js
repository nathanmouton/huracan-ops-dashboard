const { Router } = require('express');
const { getDb } = require('../../db/schema');

const router = Router();

router.get('/', (_req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT id, name, city FROM locations ORDER BY id').all();
  db.close();
  res.json(rows);
});

module.exports = router;
