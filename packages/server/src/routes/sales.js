const { Router } = require('express');
const db = require('../../db/schema');
const { syncSheetsData } = require('../services/sheetsSync');

const router = Router();

const LOCATION_GOALS = {
  Austin: 100000, Houston: 100000, 'Fort Worth': 100000,
  Roanoke: 100000, Frisco: 100000,
};
const REP_GOAL = 100000;

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
       WHERE SUBSTR(close_date, 1, 7) = ?`,
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
      || (await db.queryOne('SELECT MAX(close_date) AS d FROM rep_closes'))?.d
      || new Date().toISOString().split('T')[0];

    const byRep = await db.query(
      `SELECT rep_name, CAST(COUNT(*) AS INTEGER) AS closes, COALESCE(SUM(revenue), 0) AS revenue
       FROM rep_closes
       WHERE close_date = ?
       GROUP BY rep_name
       ORDER BY revenue DESC`,
      [date]
    );

    const closes = await db.query(
      `SELECT rowid AS seq, rep_name, close_date, revenue, lead_source, location
       FROM rep_closes
       WHERE close_date = ?
       ORDER BY rowid DESC`,
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
       WHERE SUBSTR(close_date, 1, 4) = ?`,
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

module.exports = router;
