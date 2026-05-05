'use strict';

const fetch = require('node-fetch');
const pool  = require('../db');

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const API_KEY        = process.env.GOOGLE_SHEETS_API_KEY;

const TABS = {
  closes:         'closes',
  daily_activity: 'daily_activity',
};

const REP_NAME_MAP = {
  'alex martinez':      'Alex Martinez',
  'rodrigo lopez':      'Rodrigo Lopez',
  'jahmad lumar':       'Jahmad Lumar',
  'alejandro ramirez':  'Alejandro Ramirez',
  'jacob hernandez':    'Jacob Hernandez',
  'gage weiser':        'Gage Weiser',
};

const LEAD_SOURCE_MAP = {
  'meta':          'Meta',
  'website':       'Website',
  'google':        'Google',
  'referral':      'Referral',
  'repeat client': 'Repeat Client',
  'walk in':       'Walk In',
  'walkin':        'Walk In',
  'phone call':    'Phone Call',
  'phone':         'Phone Call',
  'dm':            'DM',
  'ai':            'Other',
  'other':         'Other',
};

async function fetchTab(tabName) {
  const range = encodeURIComponent(`${tabName}!A1:Z2000`);
  const url   = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}?key=${API_KEY}`;
  const res   = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sheets API error for tab "${tabName}": ${res.status} ${text}`);
  }
  const json = await res.json();
  const rows = json.values || [];
  if (rows.length < 2) return { headers: [], data: [] };
  const headers = rows[0].map(h => String(h).toLowerCase().trim().replace(/[\s-]+/g, '_'));
  const data    = rows.slice(1);
  return { headers, data };
}

function rowToObj(headers, row) {
  const obj = {};
  headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : null; });
  return obj;
}

function serialToDate(serial) {
  if (serial === null || serial === undefined || serial === '' || serial === '-') return null;
  const num = typeof serial === 'string' ? parseFloat(serial) : Number(serial);
  if (isNaN(num) || num <= 0) return null;
  const date = new Date(Date.UTC(1899, 11, 30) + Math.round(num) * 86400000);
  return isNaN(date.getTime()) ? null : date;
}

function parseRevenue(raw) {
  if (raw === null || raw === undefined || raw === '' || raw === '-') return null;
  const str   = String(raw).replace(/[$,]/g, '').trim();
  const match = str.match(/^(\d+(\.\d+)?)/);
  if (!match) return null;
  const val = parseFloat(match[1]);
  return isNaN(val) ? null : val;
}

function parseIntVal(raw) {
  if (raw === null || raw === undefined || raw === '' || raw === '-') return 0;
  const val = parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
  return isNaN(val) ? 0 : val;
}

function normalizeRep(raw) {
  if (!raw) return null;
  return REP_NAME_MAP[String(raw).toLowerCase().trim()] || null;
}

function normalizeLeadSource(raw) {
  if (!raw) return 'Other';
  return LEAD_SOURCE_MAP[String(raw).toLowerCase().trim()] || 'Other';
}

async function loadRepMap() {
  const { rows } = await pool.query('SELECT id, name FROM reps');
  const map = {};
  rows.forEach(r => { map[r.name] = r.id; });
  return map;
}

async function syncCloses(repMap) {
  const { headers, data } = await fetchTab(TABS.closes);
  console.log(`[sheetsSync] closes tab: ${data.length} rows read`);
  let upserted = 0, skipped = 0;

  for (const row of data) {
    const obj = rowToObj(headers, row);
    const repName = normalizeRep(obj.rep_name);
    if (!repName) { skipped++; continue; }
    const repId = repMap[repName];
    if (!repId)  { skipped++; continue; }
    const saleDate = serialToDate(obj.sale_date);
    if (!saleDate) { skipped++; continue; }
    // Revenue ONLY from closes tab — never daily_activity
    const revenue = parseRevenue(obj.revenue);
    if (revenue === null) { skipped++; continue; }

    const weekStart     = serialToDate(obj.week_start);
    const leadSource    = normalizeLeadSource(obj.lead_source);
    const location      = obj.location       ? String(obj.location).trim()       : null;
    const dealType      = obj.deal_type      ? String(obj.deal_type).trim()      : null;
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

async function syncDailyActivity(repMap) {
  const { headers, data } = await fetchTab(TABS.daily_activity);
  console.log(`[sheetsSync] daily_activity tab: ${data.length} rows read`);
  let upserted = 0, skipped = 0;

  for (const row of data) {
    const obj = rowToObj(headers, row);
    const repName = normalizeRep(obj.rep_name);
    if (!repName) { skipped++; continue; }
    const repId = repMap[repName];
    if (!repId)  { skipped++; continue; }
    const date = serialToDate(obj.date);
    if (!date)   { skipped++; continue; }

    const dials         = parseIntVal(obj.dials);
    const texts         = parseIntVal(obj.texts);
    const conversations = parseIntVal(obj.conversations);
    const closes        = parseIntVal(obj.closes);

    if (dials === 0 && texts === 0 && conversations === 0 && closes === 0) {
      skipped++; continue;
    }

    // Revenue intentionally NOT read or stored from daily_activity.
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

async function computeWeeklyStats() {
  const closesRes = await pool.query(`
    SELECT rep_id, week_start,
           SUM(revenue) AS revenue,
           COUNT(*)     AS closes
    FROM rep_closes
    WHERE booking_status = 'Completed'
      AND week_start IS NOT NULL
    GROUP BY rep_id, week_start
  `);

  let upserted = 0;
  for (const row of closesRes.rows) {
    const actRes = await pool.query(`
      SELECT COALESCE(SUM(dials),0) AS dials,
             COALESCE(SUM(texts),0) AS texts
      FROM rep_daily_activity
      WHERE rep_id = $1
        AND date >= $2
        AND date <  $2::date + INTERVAL '7 days'
    `, [row.rep_id, row.week_start]);

    const dials = parseIntVal(actRes.rows[0]?.dials);
    const texts = parseIntVal(actRes.rows[0]?.texts);

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

async function syncSheets() {
  if (!SPREADSHEET_ID) { console.error('[sheetsSync] GOOGLE_SHEETS_SPREADSHEET_ID not set'); return; }
  if (!API_KEY)        { console.error('[sheetsSync] GOOGLE_SHEETS_API_KEY not set'); return; }

  console.log('[sheetsSync] Starting full sync...');
  const repMap = await loadRepMap();
  console.log(`[sheetsSync] Loaded ${Object.keys(repMap).length} reps from DB`);

  const closesCount   = await syncCloses(repMap);
  const activityCount = await syncDailyActivity(repMap);
  const weeklyCount   = await computeWeeklyStats();

  console.log(`[sheetsSync] Done — closes: ${closesCount}, activity: ${activityCount}, weekly: ${weeklyCount}`);
}

module.exports = { syncSheets };
