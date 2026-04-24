const { Router } = require('express');
const { getDb } = require('../../db/schema');

const router = Router();

function locId(req) {
  const raw = req.query.location_id;
  return raw ? parseInt(raw, 10) : null;
}

// GET /api/dashboard/kpis
router.get('/kpis', (req, res) => {
  const locationId = locId(req);
  const db = getDb();

  const revenue = db.prepare(`
    SELECT COALESCE(SUM(revenue), 0) AS value
    FROM jobs
    WHERE status = 'completed'
      AND strftime('%Y-%m', scheduled_at) = strftime('%Y-%m', 'now')
      AND (@locationId IS NULL OR location_id = @locationId)
  `).get({ locationId });

  const completed = db.prepare(`
    SELECT COUNT(*) AS value
    FROM jobs
    WHERE status = 'completed'
      AND strftime('%Y-%m', completed_at) = strftime('%Y-%m', 'now')
      AND (@locationId IS NULL OR location_id = @locationId)
  `).get({ locationId });

  const open = db.prepare(`
    SELECT COUNT(*) AS value
    FROM jobs
    WHERE status IN ('scheduled', 'in_progress')
      AND (@locationId IS NULL OR location_id = @locationId)
  `).get({ locationId });

  const upsells = db.prepare(`
    SELECT COALESCE(SUM(price), 0) AS value
    FROM upsells
    WHERE strftime('%Y-%W', sold_at) = strftime('%Y-%W', 'now')
      AND (@locationId IS NULL OR location_id = @locationId)
  `).get({ locationId });

  db.close();

  res.json({
    total_revenue:      revenue.value,
    jobs_completed:     completed.value,
    open_appointments:  open.value,
    upsells_this_week:  upsells.value,
  });
});

// GET /api/dashboard/revenue-by-rep
router.get('/revenue-by-rep', (req, res) => {
  const locationId = locId(req);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      COALESCE(r.name, 'Unassigned') AS rep_name,
      COALESCE(SUM(j.revenue), 0)    AS revenue
    FROM jobs j
    LEFT JOIN reps r ON j.rep_id = r.id
    WHERE j.status = 'completed'
      AND j.rep_id IS NOT NULL
      AND strftime('%Y-%W', j.completed_at) = strftime('%Y-%W', 'now')
      AND (@locationId IS NULL OR j.location_id = @locationId)
    GROUP BY j.rep_id, r.name
    ORDER BY revenue DESC
  `).all({ locationId });

  db.close();
  res.json(rows);
});

// GET /api/dashboard/daily-revenue
router.get('/daily-revenue', (req, res) => {
  const locationId = locId(req);
  const db = getDb();

  // CTE generates a 30-day spine so days with no revenue still appear as 0
  const rows = db.prepare(`
    WITH RECURSIVE dates(date) AS (
      SELECT date('now', '-29 days')
      UNION ALL
      SELECT date(date, '+1 day') FROM dates WHERE date < date('now')
    ),
    rev AS (
      SELECT date(paid_at) AS d, SUM(amount) AS revenue
      FROM invoices
      WHERE status = 'paid'
        AND date(paid_at) >= date('now', '-29 days')
        AND (@locationId IS NULL OR location_id = @locationId)
      GROUP BY date(paid_at)
    )
    SELECT dates.date, COALESCE(rev.revenue, 0) AS revenue
    FROM dates
    LEFT JOIN rev ON rev.d = dates.date
    ORDER BY dates.date ASC
  `).all({ locationId });

  db.close();
  res.json(rows);
});

// GET /api/dashboard/recent-jobs
router.get('/recent-jobs', (req, res) => {
  const locationId = locId(req);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
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
    WHERE (@locationId IS NULL OR j.location_id = @locationId)
    ORDER BY j.created_at DESC
    LIMIT 50
  `).all({ locationId });

  db.close();
  res.json(rows);
});

module.exports = router;
