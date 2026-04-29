const { Router } = require('express');
const { getDb } = require('../../db/schema');
const { syncSheetsData } = require('../services/sheetsSync');

const router = Router();

const LOCATION_GOALS = {
  Austin: 100000, Houston: 100000, 'Fort Worth': 100000,
  Roanoke: 100000, Frisco: 100000,
};
const REP_GOAL = 100000;

// ─── GET /api/sales/kpis ─────────────────────────────────────────────────────

router.get('/kpis', (req, res) => {
  const db = getDb();

  // Default to current calendar month; caller can pass ?month=2026-04
  const month = (req.query.month || '').match(/^\d{4}-\d{2}$/)
    ? req.query.month
    : new Date().toISOString().slice(0, 7);

  // Top-line totals — revenue/closes always from rep_closes (close log)
  const closeTotals = db.prepare(`
    SELECT COUNT(*) AS closes, COALESCE(SUM(revenue), 0) AS revenue
    FROM rep_closes
    WHERE strftime('%Y-%m', close_date) = ?
  `).get(month);

  const activityTotals = db.prepare(`
    SELECT COALESCE(SUM(dials), 0) AS dials, COALESCE(SUM(texts), 0) AS texts
    FROM rep_weekly_stats
    WHERE strftime('%Y-%m', week_start) = ?
  `).get(month);

  // Per-rep: dials/texts from rep_weekly_stats, closes/revenue from rep_closes
  const actPerRep = db.prepare(`
    SELECT rep_name,
      COALESCE(SUM(dials), 0) AS dials,
      COALESCE(SUM(texts), 0) AS texts
    FROM rep_weekly_stats
    WHERE strftime('%Y-%m', week_start) = ?
    GROUP BY rep_name
  `).all(month);

  const closesPerRep = db.prepare(`
    SELECT rep_name,
      COUNT(*)                  AS closes,
      COALESCE(SUM(revenue), 0) AS revenue
    FROM rep_closes
    WHERE strftime('%Y-%m', close_date) = ?
    GROUP BY rep_name
  `).all(month);

  // Merge: every rep seen in either table
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
  const weeklyData = db.prepare(`
    SELECT rep_name, week_start, week_end, dials, texts, closes, revenue
    FROM rep_weekly_stats
    WHERE strftime('%Y-%m', week_start) = ?
    ORDER BY week_start ASC, revenue DESC
  `).all(month);

  // Lead sources
  const leadSources = db.prepare(`
    SELECT
      COALESCE(lead_source, 'Unknown') AS lead_source,
      COUNT(*)                         AS closes,
      COALESCE(SUM(revenue), 0)        AS revenue
    FROM rep_closes
    WHERE strftime('%Y-%m', close_date) = ?
    GROUP BY lead_source
    ORDER BY closes DESC
  `).all(month);

  // Locations with goal
  const locationsRaw = db.prepare(`
    SELECT
      COALESCE(location, 'Unknown') AS location,
      COUNT(*)                      AS closes,
      COALESCE(SUM(revenue), 0)     AS revenue
    FROM rep_closes
    WHERE strftime('%Y-%m', close_date) = ?
    GROUP BY location
    ORDER BY closes DESC
  `).all(month);

  const locations = locationsRaw.map((l) => {
    const goal = LOCATION_GOALS[l.location] || 100000;
    return {
      ...l,
      goal,
      goal_pct:  Math.min(Math.round((l.revenue / goal) * 100), 100),
      remaining: Math.max(0, goal - l.revenue),
    };
  });

  // Sparkline data for the selected month — frontend filters to the active week range
  const sparklinesRaw = db.prepare(`
    SELECT rep_name, close_date, COALESCE(SUM(revenue), 0) AS revenue
    FROM rep_closes
    WHERE strftime('%Y-%m', close_date) = ?
    GROUP BY rep_name, close_date
    ORDER BY rep_name, close_date
  `).all(month);

  db.close();

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
});

// ─── GET /api/sales/today ─────────────────────────────────────────────────────

router.get('/today', (req, res) => {
  const db = getDb();

  // Accept date from client (browser local date) to avoid UTC vs local mismatch.
  // Falls back to the most recent close_date in the table.
  const date = req.query.date
    || db.prepare('SELECT MAX(close_date) AS d FROM rep_closes').get()?.d
    || db.prepare("SELECT date('now') AS d").get().d;

  // Closes per rep today
  const byRep = db.prepare(`
    SELECT rep_name, COUNT(*) AS closes, COALESCE(SUM(revenue), 0) AS revenue
    FROM rep_closes
    WHERE close_date = ?
    GROUP BY rep_name
    ORDER BY revenue DESC
  `).all(date);

  // Individual closes today — rowid DESC approximates newest-first order
  const closes = db.prepare(`
    SELECT rowid AS seq, rep_name, close_date, revenue, lead_source, location
    FROM rep_closes
    WHERE close_date = ?
    ORDER BY rowid DESC
  `).all(date);

  // Active-today status for all reps seen this month
  const active = db.prepare(`
    SELECT
      all_reps.rep_name,
      COALESCE(da.dials, 0) AS dials,
      COALESCE(da.texts, 0) AS texts
    FROM (
      SELECT DISTINCT rep_name
      FROM rep_weekly_stats
      WHERE strftime('%Y-%m', week_start) = strftime('%Y-%m', 'now')
    ) all_reps
    LEFT JOIN rep_daily_activity da
      ON da.rep_name = all_reps.rep_name
      AND da.activity_date = ?
    ORDER BY COALESCE(da.dials, 0) + COALESCE(da.texts, 0) DESC
  `).all(date);

  db.close();

  res.json({ date, by_rep: byRep, closes, active });
});

// ─── GET /api/sales/annual ───────────────────────────────────────────────────

router.get('/annual', (req, res) => {
  const db      = getDb();
  const yearStr = String(new Date().getFullYear());

  // YTD top-line totals from individual close records
  const totals = db.prepare(`
    SELECT COUNT(*) AS closes, COALESCE(SUM(revenue), 0) AS revenue
    FROM rep_closes
    WHERE strftime('%Y', close_date) = ?
  `).get(yearStr);

  // All reps seen this year (from activity data — includes reps with 0 closes)
  const activityByRep = db.prepare(`
    SELECT
      rep_name,
      COALESCE(SUM(dials), 0)   AS dials,
      COALESCE(SUM(texts), 0)   AS texts
    FROM rep_weekly_stats
    WHERE strftime('%Y', week_start) = ?
    GROUP BY rep_name
  `).all(yearStr);

  // Closes and revenue by rep from SALES_RAW records
  const closesByRep = db.prepare(`
    SELECT rep_name, COUNT(*) AS closes, COALESCE(SUM(revenue), 0) AS revenue
    FROM rep_closes
    WHERE strftime('%Y', close_date) = ?
    GROUP BY rep_name
  `).all(yearStr);

  // Monthly breakdown — one row per calendar month
  const monthly_breakdown = db.prepare(`
    SELECT
      strftime('%Y-%m', close_date) AS month,
      COUNT(*)                      AS closes,
      COALESCE(SUM(revenue), 0)     AS revenue
    FROM rep_closes
    WHERE strftime('%Y', close_date) = ?
    GROUP BY month
    ORDER BY month ASC
  `).all(yearStr);

  // YTD lead sources
  const lead_sources = db.prepare(`
    SELECT
      COALESCE(lead_source, 'Unknown') AS lead_source,
      COUNT(*)                         AS closes,
      COALESCE(SUM(revenue), 0)        AS revenue
    FROM rep_closes
    WHERE strftime('%Y', close_date) = ?
    GROUP BY lead_source
    ORDER BY revenue DESC
  `).all(yearStr);

  // YTD locations
  const locations = db.prepare(`
    SELECT
      COALESCE(location, 'Unknown') AS location,
      COUNT(*)                      AS closes,
      COALESCE(SUM(revenue), 0)     AS revenue
    FROM rep_closes
    WHERE strftime('%Y', close_date) = ?
    GROUP BY location
    ORDER BY revenue DESC
  `).all(yearStr);

  db.close();

  // Merge: every rep from activity data + closes from rep_closes
  const closesMap = {};
  closesByRep.forEach(r => { closesMap[r.rep_name] = r; });

  const by_rep = activityByRep
    .map(r => ({
      rep_name: r.rep_name,
      dials:    r.dials,
      texts:    r.texts,
      closes:   closesMap[r.rep_name]?.closes  ?? 0,
      revenue:  closesMap[r.rep_name]?.revenue ?? 0,
    }))
    .sort((a, b) => b.revenue - a.revenue || b.closes - a.closes);

  res.json({
    year:               parseInt(yearStr, 10),
    totals,
    by_rep,
    monthly_breakdown,
    lead_sources,
    locations,
  });
});

// ─── GET /api/sales/sync/now ──────────────────────────────────────────────────

router.get('/sync/now', async (req, res) => {
  try {
    const summary = await syncSheetsData();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
