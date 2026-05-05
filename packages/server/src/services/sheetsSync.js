'use strict';

const { google } = require('googleapis');
const pool = require('../db');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const API_KEY        = process.env.GOOGLE_SHEETS_API_KEY;

const TABS = {
  closes:         'closes',
  daily_activity: 'daily_activity',
  pipeline:       'pipeline',
};

// Canonical rep names — must match exactly what's in the reps table
const REP_NAME_MAP = {
  'alex martinez':      'Alex Martinez',
  'rodrigo lopez':      'Rodrigo Lopez',
  'jahmad lumar':       'Jahmad Lumar',
  'alejandro ramirez':  'Alejandro Ramirez',
  'jacob hernandez':    'Jacob Hernandez',
  'gage weiser':        'Gage Weiser',
};

// Lead source normalization map
const LEAD_SOURCE_MAP = {
  'meta':         'Meta',
  'website':      'Website',
  'google':       'Google',
  'referral':     'Referral',
  'repeat client':'Repeat Client',
  'walk in':      'Walk In',
  'walkin':       'Walk In',
  'phone call':   'Phone Call',
  'phone':        'Phone Call',
  'dm':           'DM',
  'ai':           'Other',
  'other':        'Other',
};

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/**
 * Convert a Google Sheets / Excel serial date number to a JS Date.
 * Sheets epoch: Dec 30 1899
 */
function serialToDate(serial) {
  if (!serial && serial !== 0) return null;
  const num = typeof serial === 'string' ? parseFloat(serial) : serial;
  if (isNaN(num) || num <= 0) return null;
  const date = new Date(Date.UTC(1899, 11, 30) + Math.round(num) * 86400000);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Parse revenue — numbers only, never from daily activity.
 * Strips $, commas, and any trailing text like "(25%)".
 * Returns null if unparseable.
 */
function parseRevenue(raw) {
  if (raw === null || raw === undefined || raw === '' || raw === '-') return null;
  const str = String(raw).replace(/[$,]/g, '').trim();
  // Extract leading numeric portion only
  const match = str.match(/^(\d+(\.\d+)?)/);
  if (!match) return null;
  const val = parseFloat(match[1]);
  return isNaN(val) ? null : val;
}

/**
 * Parse an integer field (dials, texts, closes, conversations).
 */
function parseInt2(raw) {
  if (raw === null || raw === undefined || raw === '' || raw === '-') return 0;
  const val = parseInt(String(raw).replace(/[^0-9-]/g, ''), 10);
  return isNaN(val) ? 0 : val;
}

/**
 * Normalize rep name to canonical form.
 */
function normalizeRepName(raw) {
  if (!raw) return null;
  const key = String(raw).toLowerCase().trim();
  return REP_NAME_MAP[key] || null;
}

/**
 * Normalize lead source to canonical form.
 */
function normalizeLeadSource(raw) {
  if (!raw) return 'Other';
  const key = String(raw).toLowerCase().trim();
  return LEAD_SOURCE_MAP[key] || 'Other';
}

/**
 * Fetch all rows from a named tab.
 * Returns array of row arrays (strings/numbers).
 */
async function fetchTab(sheets, tabName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tabName}!A1:Z2000`,
    key: API_KEY,
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return { headers: [], data: [] };
  const headers = rows[0].map(h => String(h).toLowerCase().trim().replace(/\s+/g, '_'));
  const data = rows.slice(1);
  return { headers, data };
}

/**
 * Map a row array to an object using headers.
 */
function rowToObj(headers, row) {
  const obj = {};
  headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : null; });
  return obj;
}

/**
 * Load reps from DB into a name→id map.
 */
async function loadRepMap() {
  const { rows } = await pool.query('SELECT id, name FROM reps');
  const map = {};
  rows.forEach(r => { map[r.name] = r.id; });
  return map;
}

// ─────────────────────────────────────────────
// SYNC CLOSES
// Revenue ONLY comes from the closes tab.
// Never from daily_activity.
// ─────────────────────────────────────────────
async function syncCloses(sheets, repMap) {
  const { headers, data } = await fetchTab(sheets, TABS.closes);
  console.log(`[sheetsSync] closes tab: ${data.length} rows read`);

  let upserted = 0;
  let skipped  = 0;

  for (const row of data) {
    const obj = rowToObj(headers, row);

    const repName = normalizeRepName(obj.rep_name);
    if (!repName) { skipped++; continue; }

    const repId = repMap[repName];
    if (!repId) { skipped++; continue; }

    // Date from serial
    const saleDate = serialToDate(obj.sale_date);
    if (!saleDate) { skipped++; continue; }

    // Revenue ONLY from closes tab column — never daily activity
    const revenue = parseRevenue(obj.revenue);
    if (revenue === null) { skipped++; continue; }

    const weekStart   = serialToDate(obj.week_start);
    const leadSource  = normalizeLeadSource(obj.lead_source);
    const location    = obj.location    ? String(obj.location).trim()    : null;
    const dealType    = obj.deal_type   ? String(obj.deal_type).trim()   : null;
    const bookingStatus = obj.booking_status ? String(obj.booking_status).trim() : null;

    await pool.query(
      `INSERT INTO rep_closes
         (rep_id, sale_date, revenue, lead_source, location, booking_status, deal_type, week_start)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (rep_id, sale_date, revenue, lead_source, location)
         DO UPDATE SET
           booking_status = EXCLUDED.booking_status,
           deal_type      = EXCLUDED.deal_type,
           week_start     = EXCLUDED.week_start`,
      [repId, saleDate, revenue, leadSource, location, bookingStatus, dealType, weekStart]
    );
    upserted++;
  }

  console.log(`[sheetsSync] closes: ${upserted} upserted, ${skipped} skipped`);
  return upserted;
}

// ─────────────────────────────────────────────
// SYNC DAILY ACTIVITY
// NO revenue stored here — effort metrics only.
// ─────────────────────────────────────────────
async function syncDailyActivity(sheets, repMap) {
  const { headers, data } = await fetchTab(sheets, TABS.daily_activity);
  console.log(`[sheetsSync] daily_activity tab: ${data.length} rows read`);

  let upserted = 0;
  let skipped  = 0;

  for (const row of data) {
    const obj = rowToObj(headers, row);

    const repName = normalizeRepName(obj.rep_name);
    if (!repName) { skipped++; continue; }

    const repId = repMap[repName];
    if (!repId) { skipped++; continue; }

    const date  = serialToDate(obj.date);
    if (!date)  { skipped++; continue; }

    const dials         = parseInt2(obj.dials);
    const texts         = parseInt2(obj.texts);
    const conversations = parseInt2(obj.conversations);
    const closes        = parseInt2(obj.closes);

    // Skip entirely empty rows
    if (dials === 0 && texts === 0 && conversations === 0 && closes === 0) {
      skipped++;
      continue;
    }

    // NOTE: revenue is intentionally NOT read or stored from this tab.
    // All revenue comes from rep_closes only.

    await pool.query(
      `INSERT INTO rep_daily_activity
         (rep_id, date, dials, texts, conversations, closes)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (rep_id, date)
         DO UPDATE SET
           dials         = EXCLUDED.dials,
           texts         = EXCLUDED.texts,
           conversations = EXCLUDED.conversations,
           closes        = EXCLUDED.closes`,
      [repId, date, dials, texts, conversations, closes]
    );
    upserted++;
  }

  console.log(`[sheetsSync] daily_activity: ${upserted} upserted, ${skipped} skipped`);
  return upserted;
}

// ─────────────────────────────────────────────
// COMPUTE WEEKLY STATS
// Revenue comes from rep_closes — never daily_activity.
// Activity (dials/texts) comes from rep_daily_activity.
// ─────────────────────────────────────────────
async function computeWeeklyStats() {
  // Revenue + closes per rep per week — sourced from rep_closes only
  const closesRes = await pool.query(`
    SELECT
      rep_id,
      week_start,
      SUM(revenue)  AS revenue,
      COUNT(*)      AS closes
    FROM rep_closes
    WHERE booking_status = 'Completed'
      AND week_start IS NOT NULL
    GROUP BY rep_id, week_start
  `);

  let upserted = 0;

  for (const row of closesRes.rows) {
    // Activity for same rep + week range
    const actRes = await pool.query(`
      SELECT
        COALESCE(SUM(dials), 0)  AS dials,
        COALESCE(SUM(texts), 0)  AS texts
      FROM rep_daily_activity
      WHERE rep_id = $1
        AND date >= $2
        AND date <  $2::date + INTERVAL '7 days'
    `, [row.rep_id, row.week_start]);

    const dials = parseInt2(actRes.rows[0]?.dials);
    const texts = parseInt2(actRes.rows[0]?.texts);

    await pool.query(
      `INSERT INTO rep_weekly_stats
         (rep_id, week_start, revenue, closes, dials, texts)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (rep_id, week_start)
         DO UPDATE SET
           revenue = EXCLUDED.revenue,
           closes  = EXCLUDED.closes,
           dials   = EXCLUDED.dials,
           texts   = EXCLUDED.texts`,
      [row.rep_id, row.week_start, row.revenue, row.closes, dials, texts]
    );
    upserted++;
  }

  console.log(`[sheetsSync] weekly_stats: ${upserted} upserted`);
  return upserted;
}

// ─────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────
async function syncSheets() {
  if (!SPREADSHEET_ID) {
    console.error('[sheetsSync] GOOGLE_SHEETS_SPREADSHEET_ID not set');
    return;
  }

  console.log('[sheetsSync] Starting full sync...');

  const sheets = google.sheets({ version: 'v4', auth: API_KEY });
  const repMap = await loadRepMap();
  console.log(`[sheetsSync] Loaded ${Object.keys(repMap).length} reps from DB`);

  const closesCount   = await syncCloses(sheets, repMap);
  const activityCount = await syncDailyActivity(sheets, repMap);
  const weeklyCount   = await computeWeeklyStats();

  console.log(`[sheetsSync] Done — closes: ${closesCount}, activity: ${activityCount}, weekly: ${weeklyCount}`);
}

module.exports = { syncSheets };
