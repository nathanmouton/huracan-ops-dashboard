const fetch = require('node-fetch');
const db = require('../../db/schema');

const BASE_URL = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEET_ID = () => process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const API_KEY  = () => process.env.GOOGLE_SHEETS_API_KEY;

// ─── API client ──────────────────────────────────────────────────────────────

async function sheetsGet(range) {
  const url = `${BASE_URL}/${SHEET_ID()}/values/${encodeURIComponent(range)}?key=${API_KEY()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheets "${range}" → ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.values || [];
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// "4/13/2026" → "2026-04-13". Returns null for blank or malformed.
function parseDate(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const year = parseInt(m[3], 10);
  if (year < 2024 || year > 2027) return null;
  return `${year}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

// "$14,034.00" or "14034" → 14034
function parseRevenue(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[$,\s]/g, '')) || 0;
}

// ─── parseWeeklyStats ────────────────────────────────────────────────────────

// Weekly Summary sheet — reads dials/texts from weekly table blocks.
// Skips rows where col[1] is a valid full date (those are close log rows).
const WEEKLY_SENTINELS = new Set(['', 'Rep Name', 'TOTAL', 'END', 'Huracan Nero Auto Spa']);

function parseWeeklyStats(rows) {
  const results = [];
  let weekStart = null;
  let weekEnd   = null;

  for (const row of rows) {
    const cell0 = (row[0] || '').trim();

    if (cell0 === 'Rep Name') {
      weekStart = parseDate(row[9]);
      weekEnd   = parseDate(row[10]);
      continue;
    }

    if (WEEKLY_SENTINELS.has(cell0) || /^\d{2}\/\d{2}-\d{2}\/\d{2}$/.test(cell0)) continue;

    // Close log rows have a full date in col[1] — skip here
    if (parseDate(row[1])) continue;

    // Skip once we hit the close log header row
    if (cell0 === 'Rep' && (row[1] || '').trim() === 'Date') continue;

    if (!weekStart) continue;

    results.push({
      rep_name:     cell0,
      week_start:   weekStart,
      week_end:     weekEnd,
      dials:        parseInt(row[1], 10) || 0,
      texts:        parseInt(row[2], 10) || 0,
      closes:       parseInt(row[3], 10) || 0,
      revenue:      parseRevenue(row[4]),
      lead_sources: row[5] || null,
      locations:    row[6] || null,
    });
  }

  return results;
}

// ─── parseCloseLog ───────────────────────────────────────────────────────────

// Scans for the close log header row: col[0]="Rep", col[1]="Date", col[2]="Revenue"
// Reads entries until the daily activity header: col[0]="Rep", col[3]="Dials"
function parseCloseLog(rows) {
  // Find close log header
  let closeStart = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (
      (r[0] || '').trim() === 'Rep' &&
      (r[1] || '').trim() === 'Date' &&
      (r[2] || '').trim() === 'Revenue'
    ) {
      closeStart = i + 1;
      console.log(`[parseCloseLog] Header found at row index ${i}`);
      break;
    }
  }

  if (closeStart === -1) {
    console.warn('[parseCloseLog] Close log header not found — no closes parsed');
    return [];
  }

  const results = [];
  let skippedEmpty = 0, skippedDate = 0, skippedRevenue = 0, total = 0;

  for (let i = closeStart; i < rows.length; i++) {
    const row  = rows[i];
    const col0 = (row[0] || '').trim();
    const col1 = (row[1] || '').trim();
    const col3 = (row[3] || '').trim();

    // Stop at daily activity header: Rep | Date | Dials | Texts
    if (col0 === 'Rep' && col1 === 'Date' && col3 === 'Dials') {
      console.log(`[parseCloseLog] Activity header found at row index ${i} — stopping`);
      break;
    }

    total++;

    if (!col0) { skippedEmpty++; continue; }

    const date = parseDate(col1);
    if (!date) { skippedDate++; continue; }

    const revenue = parseRevenue(row[2]);
    if (!revenue) { skippedRevenue++; continue; }

    results.push({
      rep_name:    col0,
      close_date:  date,
      revenue,
      lead_source: (row[3] || '').trim() || null,
      location:    (row[4] || '').trim() || null,
    });
  }

  console.log(
    `[parseCloseLog] Parsed ${results.length} closes from ${total} rows. ` +
    `Skipped: empty=${skippedEmpty}, bad-date=${skippedDate}, no-revenue=${skippedRevenue}`
  );

  return results;
}

// ─── parseMonthlyTotals ──────────────────────────────────────────────────────

// Finds the "Huracan Nero Auto Spa" section and reads month-labeled rows.
// Each month row has: Rep Name | Dials | Texts | Closes | Revenue
// Stored in rep_weekly_stats with week_start = first day of that month.
const MONTH_NAMES = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
};

function parseMonthlyTotals(rows) {
  const results = [];

  // Find the "Huracan Nero Auto Spa" sentinel
  let sectionStart = -1;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || '').trim() === 'Huracan Nero Auto Spa') {
      sectionStart = i + 1;
      console.log(`[parseMonthlyTotals] Section found at row index ${i}`);
      break;
    }
  }

  if (sectionStart === -1) {
    console.warn('[parseMonthlyTotals] "Huracan Nero Auto Spa" section not found');
    return [];
  }

  // Current year — monthly totals are assumed to be for the current year
  const year = new Date().getFullYear();

  for (let i = sectionStart; i < rows.length; i++) {
    const row  = rows[i];
    const col0 = (row[0] || '').trim();

    // Stop when we hit another section or known sentinel
    if (!col0) continue;
    if (col0 === 'Rep Name' || col0 === 'Rep' || col0 === 'TOTAL') break;

    // Match month names (case-insensitive)
    const monthKey = col0.toLowerCase();
    const monthNum = MONTH_NAMES[monthKey];

    if (!monthNum) continue; // not a month row — skip

    // Col layout: Month | Dials | Texts | Closes | Revenue
    const dials   = parseInt(row[1], 10) || 0;
    const texts   = parseInt(row[2], 10) || 0;
    const closes  = parseInt(row[3], 10) || 0;
    const revenue = parseRevenue(row[4]);

    if (!dials && !texts && !closes && !revenue) continue;

    const weekStart = `${year}-${monthNum}-01`;
    // Last day of the month
    const lastDay   = new Date(year, parseInt(monthNum, 10), 0).getDate();
    const weekEnd   = `${year}-${monthNum}-${String(lastDay).padStart(2, '0')}`;

    results.push({
      rep_name:     'Huracan Nero Auto Spa',
      week_start:   weekStart,
      week_end:     weekEnd,
      dials,
      texts,
      closes,
      revenue,
      lead_sources: null,
      locations:    null,
    });
  }

  console.log(`[parseMonthlyTotals] Parsed ${results.length} monthly total rows`);
  return results;
}

// ─── parseDailyActivity ──────────────────────────────────────────────────────

// KPI_RAW sheet: Rep | Date | Dials | Texts
function parseDailyActivity(rows) {
  const results = [];
  for (let i = 1; i < rows.length; i++) {
    const row   = rows[i];
    const rep   = (row[0] || '').trim();
    if (!rep || rep === 'Rep') continue;
    const date  = parseDate(row[1]);
    if (!date) continue;
    const dials = parseInt(row[2], 10) || 0;
    const texts = parseInt(row[3], 10) || 0;
    if (!dials && !texts) continue;
    results.push({ rep_name: rep, activity_date: date, dials, texts });
  }
  return results;
}

// ─── fetchParsed (debug — no DB writes) ──────────────────────────────────────

async function fetchParsed() {
  const [weeklyRows, activityRows] = await Promise.all([
    sheetsGet('Weekly Summary!A1:Z2000'),
    sheetsGet('KPI_RAW!A1:Z2000'),
  ]);

  return {
    weekly_stats:    parseWeeklyStats(weeklyRows),
    monthly_totals:  parseMonthlyTotals(weeklyRows),
    closes:          parseCloseLog(weeklyRows),
    activity:        parseDailyActivity(activityRows),
    raw_weekly_sample: weeklyRows.slice(0, 40),
  };
}

// ─── syncSheetsData ──────────────────────────────────────────────────────────

async function syncSheetsData() {
  const summary = { weekly: 0, closes: 0, activity: 0, errors: [] };

  let weeklyRows, activityRows;
  try {
    [weeklyRows, activityRows] = await Promise.all([
      sheetsGet('Weekly Summary!A1:Z2000'),
      sheetsGet('KPI_RAW!A1:Z2000'),
    ]);
  } catch (err) {
    summary.errors.push({ source: 'fetch', error: err.message });
    return summary;
  }

  const weeklyStats    = parseWeeklyStats(weeklyRows);
  const monthlyTotals  = parseMonthlyTotals(weeklyRows);
  const closes         = parseCloseLog(weeklyRows);
  const activity       = parseDailyActivity(activityRows);
  const now            = new Date().toISOString();

  try {
    await db.transaction(async (tx) => {
      // Weekly stats + monthly totals: upsert by (rep_name, week_start)
      for (const row of [...weeklyStats, ...monthlyTotals]) {
        await tx.run(
          `INSERT INTO rep_weekly_stats
             (rep_name, week_start, week_end, dials, texts, closes, revenue, lead_sources, locations, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(rep_name, week_start) DO UPDATE SET
             week_end     = excluded.week_end,
             dials        = excluded.dials,
             texts        = excluded.texts,
             closes       = excluded.closes,
             revenue      = excluded.revenue,
             lead_sources = excluded.lead_sources,
             locations    = excluded.locations,
             synced_at    = excluded.synced_at`,
          [row.rep_name, row.week_start, row.week_end, row.dials, row.texts,
           row.closes, row.revenue, row.lead_sources, row.locations, now]
        );
        summary.weekly++;
      }

      // Closes: non-destructive upsert keyed on (rep_name, close_date, revenue).
      for (const row of closes) {
        const { lastId } = await tx.run(
          `INSERT INTO rep_closes (rep_name, close_date, revenue, lead_source, location, synced_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(rep_name, close_date, revenue) DO NOTHING`,
          [row.rep_name, row.close_date, row.revenue, row.lead_source, row.location, now]
        );
        if (lastId !== null) summary.closes++;
      }

      // Daily activity: upsert by (rep_name, activity_date)
      for (const row of activity) {
        await tx.run(
          `INSERT INTO rep_daily_activity (rep_name, activity_date, dials, texts, synced_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(rep_name, activity_date) DO UPDATE SET
             dials     = excluded.dials,
             texts     = excluded.texts,
             synced_at = excluded.synced_at`,
          [row.rep_name, row.activity_date, row.dials, row.texts, now]
        );
        summary.activity++;
      }
    });
  } catch (err) {
    summary.errors.push({ source: 'db', error: err.message });
  }

  console.log(`[sheetsSync] Done — weekly: ${summary.weekly}, closes: ${summary.closes}, activity: ${summary.activity}, errors: ${summary.errors.length}`);
  return summary;
}

module.exports = { syncSheetsData, fetchParsed };
