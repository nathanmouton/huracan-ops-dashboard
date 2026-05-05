'use strict';

const fetch = require('node-fetch');
const db    = require('../../db/schema');

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
  console.log(`[sheetsSync] fetchTab(${tabName}) -> requesting`);
  const startedAt = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    console.error(`[sheetsSync] fetchTab(${tabName}) aborting after 30s`);
    controller.abort();
  }, 30000);

  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    console.error(`[sheetsSync] fetchTab(${tabName}) network/abort error:`, err);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  console.log(`[sheetsSync] fetchTab(${tabName}) -> status ${res.status} in ${Date.now() - startedAt}ms`);

  if (!res.ok) {
    let text = '';
    try { text = await res.text(); }
    catch (err) { console.error(`[sheetsSync] fetchTab(${tabName}) failed to read error body:`, err); }
    throw new Error(`Sheets API error for tab "${tabName}": ${res.status} ${text}`);
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error(`[sheetsSync] fetchTab(${tabName}) JSON parse error:`, err);
    throw err;
  }
  const rows = json.values || [];
  console.log(`[sheetsSync] fetchTab(${tabName}) -> ${rows.length} raw rows`);
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

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function weekBounds(d) {
  const day    = d.getUTCDay();           // 0=Sun..6=Sat
  const offset = (day + 6) % 7;           // days since Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { weekStart: isoDate(monday), weekEnd: isoDate(sunday) };
}

async function syncCloses() {
  let headers, data;
  try {
    ({ headers, data } = await fetchTab(TABS.closes));
  } catch (err) {
    console.error('[sheetsSync] syncCloses: fetchTab(closes) failed:', err);
    throw err;
  }
  console.log(`[sheetsSync] closes tab: ${data.length} rows read`);
  let upserted = 0, skipped = 0;

  for (const row of data) {
    const obj = rowToObj(headers, row);
    const repName = normalizeRep(obj.rep_name);
    if (!repName) { skipped++; continue; }
    const saleDate = serialToDate(obj.sale_date);
    if (!saleDate) { skipped++; continue; }
    const revenue = parseRevenue(obj.revenue);
    if (revenue === null) { skipped++; continue; }

    const closeDate  = isoDate(saleDate);
    const leadSource = normalizeLeadSource(obj.lead_source);
    const location   = obj.location ? String(obj.location).trim() : null;

    try {
      await db.run(
        `INSERT INTO rep_closes (rep_name, close_date, revenue, lead_source, location)
         VALUES (?,?,?,?,?)
         ON CONFLICT (rep_name, close_date, revenue) DO UPDATE SET
           lead_source = EXCLUDED.lead_source,
           location    = EXCLUDED.location,
           synced_at   = CURRENT_TIMESTAMP`,
        [repName, closeDate, revenue, leadSource, location]
      );
    } catch (err) {
      console.error('[sheetsSync] syncCloses upsert failed for row:', { repName, closeDate, revenue, leadSource, location }, err);
      throw err;
    }
    upserted++;
  }

  console.log(`[sheetsSync] closes: ${upserted} upserted, ${skipped} skipped`);
  return upserted;
}

async function syncDailyActivity() {
  let headers, data;
  try {
    ({ headers, data } = await fetchTab(TABS.daily_activity));
  } catch (err) {
    console.error('[sheetsSync] syncDailyActivity: fetchTab(daily_activity) failed:', err);
    throw err;
  }
  console.log(`[sheetsSync] daily_activity tab: ${data.length} rows read`);
  let upserted = 0, skipped = 0;

  for (const row of data) {
    const obj = rowToObj(headers, row);
    const repName = normalizeRep(obj.rep_name);
    if (!repName) { skipped++; continue; }
    const date = serialToDate(obj.date);
    if (!date) { skipped++; continue; }

    const dials = parseIntVal(obj.dials);
    const texts = parseIntVal(obj.texts);
    if (dials === 0 && texts === 0) { skipped++; continue; }

    const activityDate = isoDate(date);

    try {
      await db.run(
        `INSERT INTO rep_daily_activity (rep_name, activity_date, dials, texts)
         VALUES (?,?,?,?)
         ON CONFLICT (rep_name, activity_date) DO UPDATE SET
           dials     = EXCLUDED.dials,
           texts     = EXCLUDED.texts,
           synced_at = CURRENT_TIMESTAMP`,
        [repName, activityDate, dials, texts]
      );
    } catch (err) {
      console.error('[sheetsSync] syncDailyActivity upsert failed for row:', { repName, activityDate, dials, texts }, err);
      throw err;
    }
    upserted++;
  }

  console.log(`[sheetsSync] daily_activity: ${upserted} upserted, ${skipped} skipped`);
  return upserted;
}

async function computeWeeklyStats() {
  // Aggregate weekly buckets in JS for dialect-portability (no PG-only date math).
  let closes;
  try {
    closes = await db.query(`SELECT rep_name, close_date, revenue FROM rep_closes`);
  } catch (err) {
    console.error('[sheetsSync] computeWeeklyStats: closes query failed:', err);
    throw err;
  }

  const buckets = new Map();
  for (const c of closes) {
    if (!c.rep_name || !c.close_date) continue;
    const d = new Date(c.close_date);
    if (isNaN(d.getTime())) continue;
    const { weekStart, weekEnd } = weekBounds(d);
    const key = `${c.rep_name}|${weekStart}`;
    let b = buckets.get(key);
    if (!b) {
      b = { rep_name: c.rep_name, week_start: weekStart, week_end: weekEnd, revenue: 0, closes: 0 };
      buckets.set(key, b);
    }
    b.revenue += Number(c.revenue) || 0;
    b.closes  += 1;
  }

  let upserted = 0;
  for (const b of buckets.values()) {
    let actRow;
    try {
      actRow = await db.queryOne(
        `SELECT COALESCE(SUM(dials),0) AS dials, COALESCE(SUM(texts),0) AS texts
         FROM rep_daily_activity
         WHERE rep_name = ?
           AND activity_date >= ?
           AND activity_date <= ?`,
        [b.rep_name, b.week_start, b.week_end]
      );
    } catch (err) {
      console.error('[sheetsSync] computeWeeklyStats: activity sum query failed for', { rep_name: b.rep_name, week_start: b.week_start }, err);
      throw err;
    }
    const dials = parseIntVal(actRow?.dials);
    const texts = parseIntVal(actRow?.texts);

    try {
      await db.run(
        `INSERT INTO rep_weekly_stats
           (rep_name, week_start, week_end, dials, texts, closes, revenue)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (rep_name, week_start) DO UPDATE SET
           week_end  = EXCLUDED.week_end,
           dials     = EXCLUDED.dials,
           texts     = EXCLUDED.texts,
           closes    = EXCLUDED.closes,
           revenue   = EXCLUDED.revenue,
           synced_at = CURRENT_TIMESTAMP`,
        [b.rep_name, b.week_start, b.week_end, dials, texts, b.closes, b.revenue]
      );
    } catch (err) {
      console.error('[sheetsSync] computeWeeklyStats: weekly upsert failed for', { rep_name: b.rep_name, week_start: b.week_start }, err);
      throw err;
    }
    upserted++;
  }

  console.log(`[sheetsSync] weekly_stats: ${upserted} upserted`);
  return upserted;
}

async function syncSheetsData() {
  console.log('[sheetsSync] env check:',
    'SPREADSHEET_ID=', SPREADSHEET_ID ? `present (len=${SPREADSHEET_ID.length})` : 'MISSING',
    '| API_KEY=',      API_KEY        ? `present (len=${API_KEY.length})`        : 'MISSING',
    '| DATABASE_URL=', process.env.DATABASE_URL ? 'present' : 'MISSING'
  );
  if (!SPREADSHEET_ID) { console.error('[sheetsSync] GOOGLE_SHEETS_SPREADSHEET_ID not set'); return; }
  if (!API_KEY)        { console.error('[sheetsSync] GOOGLE_SHEETS_API_KEY not set'); return; }

  console.log('[sheetsSync] Starting full sync...');

  let closesCount, activityCount, weeklyCount;
  try {
    closesCount = await syncCloses();
  } catch (err) {
    console.error('[sheetsSync] syncCloses failed:', err);
    throw err;
  }
  try {
    activityCount = await syncDailyActivity();
  } catch (err) {
    console.error('[sheetsSync] syncDailyActivity failed:', err);
    throw err;
  }
  try {
    weeklyCount = await computeWeeklyStats();
  } catch (err) {
    console.error('[sheetsSync] computeWeeklyStats failed:', err);
    throw err;
  }

  console.log(`[sheetsSync] Done — closes: ${closesCount}, activity: ${activityCount}, weekly: ${weeklyCount}`);
}

module.exports = { syncSheetsData };
