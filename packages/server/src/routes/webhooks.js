const { Router } = require('express');
const { syncEvents, syncInvoices, syncStaff } = require('../services/orbisxSync');

const router = Router();

router.post('/orbisx', (req, res) => {
  // Respond 200 immediately — OrbisX retries on timeout
  res.sendStatus(200);

  const payload = req.body ?? {};

  // Determine resource type from payload shape
  async function dispatch() {
    try {
      if (payload.invoice_id || payload.type === 'invoice') {
        const summary = await syncInvoices();
        console.log('[webhook/orbisx] invoice sync —', JSON.stringify(summary));
      } else if (payload.type === 'staff' || payload.staff_id) {
        const summary = await syncStaff();
        console.log('[webhook/orbisx] staff sync —', JSON.stringify(summary));
      } else {
        // Default: treat as event/appointment update
        const summary = await syncEvents();
        console.log('[webhook/orbisx] event sync —', JSON.stringify(summary));
      }
    } catch (err) {
      console.error('[webhook/orbisx] dispatch error:', err.message);
    }
  }

  dispatch();
});

module.exports = router;
