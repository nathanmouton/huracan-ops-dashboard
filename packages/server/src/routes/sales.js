const { Router } = require('express');
const db = require('../../db/schema');
const { syncSheetsData, computeWeeklyStats, fetchParsed } = require('../services/sheetsSync');

const router = Router();

const LOCATION_GOALS = {
  Austin: 100000, Houston: 100000, 'Fort Worth': 100000,
  Roanoke: 100000, Frisco: 100000,
};
const REP_GOAL = 100000;

// Booking statuses that count toward revenue/closes. Canceled and No Show
// are excluded. NULL is included so legacy rows (synced before the
// booking_status column existed) still show up until the next sync.
const ACTIVE_STATUS_SQL =
  `(booking_status IS NULL OR booking_status IN ('Completed','Scheduled','Rescheduled','Waitlisted'))`;

// ─── GET /api/sales/kpis ─────────────────────────────────────────────────────

router.get('/kpis', async (req, res) => {
  try {
    // Default to current calendar month; caller can pass ?month=2026-04
    const month = (req.query.month || '').match(/^\d{4}-\d{2}$/)
      ? req.query.month
      : new Date().toISOString().slice(0, 7);

    // Top-line totals — revenue/closes from rep_closes (close log)
    const closeTotals = await db.queryOne(
      `SELECT CAST(COUNT(*) AS INTEGER) AS closes, COALESCE(SUM(revenue), 0) AS revenue
       FROM rep_closes
       WHERE SUBSTR(close_date, 1, 7) = ?
         AND ${ACTIVE_STATUS_SQL}`,
      [month]
    );

    const activityTotals = await db.queryOne(
      `SELECT COALESCE(SUM(dials), 0) AS dials, COALESCE(SUM(texts), 0) AS texts
       FROM rep_weekly_stats
       WHERE SUBSTR(week_start, 1, 7) = ?`,
      [month]
    );

    // Per-rep: dials/texts from rep_weekly_stats, closes/revenue from rep_closes
    const actPerRep = await db.query(
      `SELECT rep_name,
         COALESCE(SUM(dials), 0) AS dials,
         COALESCE(SUM(texts), 0) AS texts
       FROM rep_weekly_stats
       WHERE SUBSTR(week_start, 1, 7) = ?
       GROUP BY rep_name`,
      [month]
    );

    const closesPerRep = await db.query(
      `SELECT rep_name,
         CAST(COUNT(*) AS INTEGER)  AS closes,
         COALESCE(SUM(revenue), 0) AS revenue
       FROM rep_closes
       WHERE SUBSTR(close_date, 1, 7) = ?
         AND ${ACTIVE_STATUS_SQL}
       GROUP BY rep_name`,
      [month]
    );

    // Merge: all reps from either table
    const repMap = {};
    for (const r of actPerRep) {
      repMap[r.rep_name] = { rep_name: r.rep_name, dials: r.dials, texts: r.texts, closes: 0, revenue: 0 };
    }
    for (const r of closesPerRep) {
      if (!repMap[r.rep_name]) repMap[r.rep_name] = { rep_name: r.rep_name, dials: 0, texts: 0, closes: 0, revenue: 0 };
      repMap[r.rep_name].closes  = r.closes;
      repMap[r.rep_name].revenue = r.revenue;
    }
    const monthlyByRep = Object.values(repMap)
      .map((r) => ({ ...r, goal: REP_GOAL, goal_pct: Math.min(Math.round((r.revenue / REP_GOAL) * 100), 100) }))
      .sort((a, b) => b.revenue - a.revenue);

    // All weekly rows for selected month
    const weeklyData = await db.query(
      `SELECT rep_name, week_start, week_end, dials, texts, closes, revenue
       FROM rep_weekly_stats
       WHERE SUBSTR(week_start, 1, 7) = ?
       ORDER BY week_start ASC, revenue DESC`,
      [month]
    );

    // Lead sources
    const leadSources = await db.query(
      `SELECT
         COALESCE(lead_source, 'Unknown') AS lead_source,
         CAST(COUNT(*) AS INTEGER)         AS closes,
         COALESCE(SUM(revenue), 0)         AS revenue
       FROM rep_closes
       WHERE SUBSTR(close_date, 1, 7) = ?
         AND ${ACTIVE_STATUS_SQL}
       GROUP BY lead_source
       ORDER BY closes DESC`,
      [month]
    );

    // Locations with goal
    const locationsRaw = await db.query(
      `SELECT
         COALESCE(location, 'Unknown') AS location,
         CAST(COUNT(*) AS INTEGER)      AS closes,
         COALESCE(SUM(revenue), 0)      AS revenue
       FROM rep_closes
       WHERE SUBSTR(close_date, 1, 7) = ?
         AND ${ACTIVE_STATUS_SQL}
       GROUP BY location
       ORDER BY closes DESC`,
      [month]
    );

    const locations = locationsRaw.map((l) => {
      const goal = LOCATION_GOALS[l.location] || 100000;
      return {
        ...l,
        goal,
        goal_pct:  Math.min(Math.round((l.revenue / goal) * 100), 100),
        remaining: Math.max(0, goal - l.revenue),
      };
    });

    // Sparkline data for the selected month
    const sparklinesRaw = await db.query(
      `SELECT rep_name, close_date, COALESCE(SUM(revenue), 0) AS revenue
       FROM rep_closes
       WHERE SUBSTR(close_date, 1, 7) = ?
         AND ${ACTIVE_STATUS_SQL}
       GROUP BY rep_name, close_date
       ORDER BY rep_name, close_date`,
      [month]
    );

    res.json({
      month,
      totals: {
        closes:  closeTotals.closes,
        revenue: closeTotals.revenue,
        dials:   activityTotals.dials,
        texts:   activityTotals.texts,
      },
      rep_goal:       REP_GOAL,
      monthly_by_rep: monthlyByRep,
      weekly_data:    weeklyData,
      lead_sources:   leadSources,
      locations,
      sparklines_raw: sparklinesRaw,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sales/today ─────────────────────────────────────────────────────

router.get('/today', async (req, res) => {
  try {
    // Accept browser local date to avoid UTC vs local mismatch.
    const date = req.query.date
      || (await db.queryOne(`SELECT MAX(close_date) AS d FROM rep_closes WHERE ${ACTIVE_STATUS_SQL}`))?.d
      || new Date().toISOString().split('T')[0];

    const byRep = await db.query(
      `SELECT rep_name, CAST(COUNT(*) AS INTEGER) AS closes, COALESCE(SUM(revenue), 0) AS revenue
       FROM rep_closes
       WHERE close_date = ?
         AND ${ACTIVE_STATUS_SQL}
       GROUP BY rep_name
       ORDER BY revenue DESC`,
      [date]
    );

    const closes = await db.query(
      `SELECT id AS seq, rep_name, close_date, revenue, lead_source, location, booking_status
       FROM rep_closes
       WHERE close_date = ?
         AND ${ACTIVE_STATUS_SQL}
       ORDER BY id DESC`,
      [date]
    );

    const active = await db.query(
      `SELECT
         all_reps.rep_name,
         COALESCE(da.dials, 0) AS dials,
         COALESCE(da.texts, 0) AS texts
       FROM (
         SELECT DISTINCT rep_name
         FROM rep_weekly_stats
         WHERE SUBSTR(week_start, 1, 7) = SUBSTR(?, 1, 7)
       ) all_reps
       LEFT JOIN rep_daily_activity da
         ON da.rep_name = all_reps.rep_name AND da.activity_date = ?
       ORDER BY COALESCE(da.dials, 0) + COALESCE(da.texts, 0) DESC`,
      [date, date]
    );

    res.json({ date, by_rep: byRep, closes, active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sales/annual ───────────────────────────────────────────────────

router.get('/annual', async (req, res) => {
  try {
    const yearStr = String(new Date().getFullYear());

    const totals = await db.queryOne(
      `SELECT CAST(COUNT(*) AS INTEGER) AS closes, COALESCE(SUM(revenue), 0) AS revenue
       FROM rep_closes
       WHERE SUBSTR(close_date, 1, 4) = ?
         AND ${ACTIVE_STATUS_SQL}`,
      [yearStr]
    );

    const activityByRep = await db.query(
      `SELECT rep_name,
         COALESCE(SUM(dials), 0) AS dials,
         COALESCE(SUM(texts), 0) AS texts
       FROM rep_weekly_stats
       WHERE SUBSTR(week_start, 1, 4) = ?
       GROUP BY rep_name`,
      [yearStr]
    );

    const closesByRep = await db.query(
      `SELECT rep_name, CAST(COUNT(*) AS INTEGER) AS closes, COALESCE(SUM(revenue), 0) AS revenue
       FROM rep_closes
       WHERE SUBSTR(close_date, 1, 4) = ?
         AND ${ACTIVE_STATUS_SQL}
       GROUP BY rep_name`,
      [yearStr]
    );

    const monthly_breakdown = await db.query(
      `SELECT
         SUBSTR(close_date, 1, 7)          AS month,
         CAST(COUNT(*) AS INTEGER)           AS closes,
         COALESCE(SUM(revenue), 0)           AS revenue
       FROM rep_closes
       WHERE SUBSTR(close_date, 1, 4) = ?
         AND ${ACTIVE_STATUS_SQL}
       GROUP BY SUBSTR(close_date, 1, 7)
       ORDER BY month ASC`,
      [yearStr]
    );

    const lead_sources = await db.query(
      `SELECT
         COALESCE(lead_source, 'Unknown') AS lead_source,
         CAST(COUNT(*) AS INTEGER)         AS closes,
         COALESCE(SUM(revenue), 0)         AS revenue
       FROM rep_closes
       WHERE SUBSTR(close_date, 1, 4) = ?
         AND ${ACTIVE_STATUS_SQL}
       GROUP BY lead_source
       ORDER BY revenue DESC`,
      [yearStr]
    );

    const locations = await db.query(
      `SELECT
         COALESCE(location, 'Unknown') AS location,
         CAST(COUNT(*) AS INTEGER)      AS closes,
         COALESCE(SUM(revenue), 0)      AS revenue
       FROM rep_closes
       WHERE SUBSTR(close_date, 1, 4) = ?
         AND ${ACTIVE_STATUS_SQL}
       GROUP BY location
       ORDER BY revenue DESC`,
      [yearStr]
    );

    // Merge activity + closes per rep
    const closesMap = {};
    for (const r of closesByRep) closesMap[r.rep_name] = r;

    const by_rep = activityByRep
      .map((r) => ({
        rep_name: r.rep_name,
        dials:    r.dials,
        texts:    r.texts,
        closes:   closesMap[r.rep_name]?.closes  ?? 0,
        revenue:  closesMap[r.rep_name]?.revenue ?? 0,
      }))
      .sort((a, b) => b.revenue - a.revenue || b.closes - a.closes);

    res.json({
      year: parseInt(yearStr, 10),
      totals,
      by_rep,
      monthly_breakdown,
      lead_sources,
      locations,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sales/sync/now ──────────────────────────────────────────────────

router.get('/sync/now', async (_req, res) => {
  try {
    const summary = await syncSheetsData();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sales/debug-sync ───────────────────────────────────────────────

router.get('/debug-sync', async (_req, res) => {
  try {
    const data = await fetchParsed();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/sales/cleanup-stale-reps ──────────────────────────────────────
// One-shot: remove rows written under short/wrong rep_name values, then
// recompute weekly stats. Remove this route after running it once.

const STALE_REP_NAMES = ['Alejandro', 'Jahmad', 'Martinez', 'Rodrigo', 'Jacob', 'Alex', '05/11-05/17'];

router.post('/cleanup-stale-reps', async (_req, res) => {
  try {
    const placeholders = STALE_REP_NAMES.map(() => '?').join(',');

    const before = {
      rep_closes:         (await db.queryOne(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM rep_closes         WHERE rep_name IN (${placeholders})`, STALE_REP_NAMES))?.n ?? 0,
      rep_daily_activity: (await db.queryOne(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM rep_daily_activity WHERE rep_name IN (${placeholders})`, STALE_REP_NAMES))?.n ?? 0,
      rep_weekly_stats:   (await db.queryOne(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM rep_weekly_stats   WHERE rep_name IN (${placeholders})`, STALE_REP_NAMES))?.n ?? 0,
    };

    await db.run(`DELETE FROM rep_closes         WHERE rep_name IN (${placeholders})`, STALE_REP_NAMES);
    await db.run(`DELETE FROM rep_daily_activity WHERE rep_name IN (${placeholders})`, STALE_REP_NAMES);
    await db.run(`DELETE FROM rep_weekly_stats   WHERE rep_name IN (${placeholders})`, STALE_REP_NAMES);

    const weekly_recomputed = await computeWeeklyStats();

    res.json({
      ok: true,
      stale_names: STALE_REP_NAMES,
      deleted: before,
      weekly_recomputed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/sales/debug-data ───────────────────────────────────────────────
// Snapshot of rep_closes / rep_daily_activity contents for diagnostics.

router.get('/debug-data', async (_req, res) => {
  try {
    const closesTotal     = await db.queryOne(`SELECT CAST(COUNT(*) AS INTEGER) AS n, COALESCE(SUM(revenue), 0) AS revenue FROM rep_closes`);
    const closesDateRange = await db.queryOne(`SELECT MIN(close_date) AS min_date, MAX(close_date) AS max_date FROM rep_closes`);
    const closesByMonth   = await db.query(
      `SELECT SUBSTR(close_date, 1, 7) AS month,
              CAST(COUNT(*) AS INTEGER) AS closes,
              COALESCE(SUM(revenue), 0) AS revenue
       FROM rep_closes
       GROUP BY SUBSTR(close_date, 1, 7)
       ORDER BY month`
    );
    const closesByRep = await db.query(
      `SELECT rep_name, CAST(COUNT(*) AS INTEGER) AS closes, COALESCE(SUM(revenue), 0) AS revenue
       FROM rep_closes
       GROUP BY rep_name
       ORDER BY revenue DESC`
    );
    const closesByStatus = await db.query(
      `SELECT COALESCE(booking_status, '<NULL>') AS booking_status,
              CAST(COUNT(*) AS INTEGER) AS n
       FROM rep_closes
       GROUP BY booking_status
       ORDER BY n DESC`
    );
    const closesSample = await db.query(`SELECT id, rep_name, close_date, revenue, lead_source, location, booking_status FROM rep_closes ORDER BY id DESC LIMIT 5`);

    const activityTotal     = await db.queryOne(`SELECT CAST(COUNT(*) AS INTEGER) AS n, COALESCE(SUM(dials), 0) AS dials, COALESCE(SUM(texts), 0) AS texts FROM rep_daily_activity`);
    const activityDateRange = await db.queryOne(`SELECT MIN(activity_date) AS min_date, MAX(activity_date) AS max_date FROM rep_daily_activity`);
    const activitySample    = await db.query(`SELECT id, rep_name, activity_date, dials, texts FROM rep_daily_activity ORDER BY id DESC LIMIT 5`);

    res.json({
      now: new Date().toISOString(),
      current_month_filter: new Date().toISOString().slice(0, 7),
      rep_closes: {
        total:        closesTotal.n,
        revenue_sum:  closesTotal.revenue,
        date_range:   closesDateRange,
        by_month:     closesByMonth,
        by_rep:       closesByRep,
        by_status:    closesByStatus,
        sample:       closesSample,
      },
      rep_daily_activity: {
        total:      activityTotal.n,
        dials_sum:  activityTotal.dials,
        texts_sum:  activityTotal.texts,
        date_range: activityDateRange,
        sample:     activitySample,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
