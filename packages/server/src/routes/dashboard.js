const { Router } = require('express');
const db = require('../../db/schema');

const router = Router();

function locId(req) {
  const raw = req.query.location_id;
  return raw ? parseInt(raw, 10) : null;
}

// Build a WHERE clause fragment + params array for an optional location filter.
// Usage: const { clause, params } = locWhere(locationId);
//        sql + clause, [...otherParams, ...params]
function locWhere(locationId) {
  return locationId
    ? { clause: 'AND location_id = ?', params: [locationId] }
    : { clause: '', params: [] };
}

// Current month as 'YYYY-MM' (e.g. '2026-04')
function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

// ISO date string for N days ago: 'YYYY-MM-DD'
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// ISO week bounds for the current week (Sunday–Saturday)
function currentWeekBounds() {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - now.getDay());
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return {
    start: start.toISOString().split('T')[0],
    end:   end.toISOString().split('T')[0],
  };
}

// GET /api/dashboard/kpis
router.get('/kpis', async (req, res) => {
  try {
    const locationId = locId(req);
    const month = currentMonth();
    const week  = currentWeekBounds();
    const lw    = locWhere(locationId);

    const revenue = await db.queryOne(
      `SELECT COALESCE(SUM(revenue), 0) AS value
       FROM jobs
       WHERE status = 'completed'
         AND SUBSTR(scheduled_at, 1, 7) = ?
         ${lw.clause}`,
      [month, ...lw.params]
    );

    const completed = await db.queryOne(
      `SELECT CAST(COUNT(*) AS INTEGER) AS value
       FROM jobs
       WHERE status = 'completed'
         AND SUBSTR(completed_at, 1, 7) = ?
         ${lw.clause}`,
      [month, ...lw.params]
    );

    const open = await db.queryOne(
      `SELECT CAST(COUNT(*) AS INTEGER) AS value
       FROM jobs
       WHERE status IN ('scheduled','in_progress')
         ${lw.clause}`,
      lw.params
    );

    const upsells = await db.queryOne(
      `SELECT COALESCE(SUM(price), 0) AS value
       FROM upsells
       WHERE SUBSTR(sold_at, 1, 10) >= ? AND SUBSTR(sold_at, 1, 10) <= ?
         ${lw.clause}`,
      [week.start, week.end, ...lw.params]
    );

    res.json({
      total_revenue:     revenue.value,
      jobs_completed:    completed.value,
      open_appointments: open.value,
      upsells_this_week: upsells.value,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/revenue-by-rep
router.get('/revenue-by-rep', async (req, res) => {
  try {
    const locationId = locId(req);
    const week = currentWeekBounds();
    const lw   = locWhere(locationId);

    const rows = await db.query(
      `SELECT
         COALESCE(r.name, 'Unassigned') AS rep_name,
         COALESCE(SUM(j.revenue), 0)    AS revenue
       FROM jobs j
       LEFT JOIN reps r ON j.rep_id = r.id
       WHERE j.status = 'completed'
         AND j.rep_id IS NOT NULL
         AND SUBSTR(j.completed_at, 1, 10) >= ?
         AND SUBSTR(j.completed_at, 1, 10) <= ?
         ${lw.clause.replace('location_id', 'j.location_id')}
       GROUP BY j.rep_id, r.name
       ORDER BY revenue DESC`,
      [week.start, week.end, ...lw.params]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/daily-revenue
router.get('/daily-revenue', async (req, res) => {
  try {
    const locationId = locId(req);
    const lw = locWhere(locationId);

    // Generate 30-day spine in JS — avoids the SQLite-only recursive CTE
    const spine = [];
    for (let i = 29; i >= 0; i--) spine.push(daysAgoStr(i));
    const since = spine[0];

    const revenueRows = await db.query(
      `SELECT SUBSTR(paid_at, 1, 10) AS d, SUM(amount) AS revenue
       FROM invoices
       WHERE status = 'paid'
         AND SUBSTR(paid_at, 1, 10) >= ?
         ${lw.clause}
       GROUP BY SUBSTR(paid_at, 1, 10)`,
      [since, ...lw.params]
    );

    const revMap = {};
    for (const r of revenueRows) revMap[r.d] = Number(r.revenue) || 0;
    const rows = spine.map((date) => ({ date, revenue: revMap[date] || 0 }));

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/recent-jobs
router.get('/recent-jobs', async (req, res) => {
  try {
    const locationId = locId(req);
    const lw = locWhere(locationId);

    const rows = await db.query(
      `SELECT
         j.id,
         COALESCE(r.name, 'Unassigned') AS rep_name,
         j.customer_name,
         COALESCE(j.service_type, '—')  AS service_type,
         CASE
           WHEN j.vehicle_year IS NULL AND j.vehicle_make IS NULL AND j.vehicle_model IS NULL
             THEN '—'
           ELSE TRIM(
             COALESCE(j.vehicle_year  || ' ', '') ||
             COALESCE(j.vehicle_make  || ' ', '') ||
             COALESCE(j.vehicle_model,        '')
           )
         END AS vehicle,
         j.status,
         COALESCE(j.revenue, 0) AS revenue,
         COALESCE(j.completed_at, j.scheduled_at, j.created_at) AS date
       FROM jobs j
       LEFT JOIN reps r ON j.rep_id = r.id
       WHERE 1=1 ${lw.clause.replace('location_id', 'j.location_id')}
       ORDER BY j.created_at DESC
       LIMIT 50`,
      lw.params
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
