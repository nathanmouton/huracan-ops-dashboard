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
  // Trim first — Google Sheets sometimes pads with whitespace
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const year = parseInt(m[3], 10);
  if (year < 2000 || year > 2100) return null;
  return `${year}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

// "$14,034.00" or "14034" → 14034
function parseRevenue(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[$,\s]/g, '')) || 0;
}

// ─── parsers ─────────────────────────────────────────────────────────────────

const WEEKLY_SENTINELS = new Set(['', 'Rep Name', 'TOTAL', 'END', 'Huracan Nero Auto Spa']);

// Known sales rep first names — used for positive identification of close log rows.
// Case-insensitive partial match handles "Martinez", "martinez", etc.
const KNOWN_REP_NAMES = ['martinez', 'alejandro', 'jahmad', 'jacob', 'rodrigo'];

function isKnownRep(name) {
  const lower = name.toLowerCase();
  return KNOWN_REP_NAMES.some((rep) => lower.includes(rep) || rep.includes(lower));
}

// A revenue cell starts with "$" or begins with a digit (after trimming).
function isRevenueCell(str) {
  if (!str) return false;
  const s = String(str).trim();
  return s.startsWith('$') || /^\d/.test(s);
}

// Weekly Summary sheet — reads dials/texts from weekly table blocks.
// Skips rows where col[1] is a valid full date (those are close log rows).
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

// Close log section: Rep | Date | Revenue | Lead Source | Location
//
// Detection uses POSITIVE matching on all three of:
//   col[0] — known rep name (case-insensitive partial match)
//   col[1] — valid M/D/YYYY date
//   col[2] — revenue cell (starts with $ or is numeric)
//
// This is more reliable than the previous negative-sentinel approach and
// correctly ignores weekly-block header/total rows without needing to track
// whether we are "inside" a week block.
function parseCloseLog(rows) {
  // ── diagnostic: log first 20 non-empty rows so mismatches are visible ──────
  const sample = rows
    .filter((r) => r && r.length > 0 && String(r[0] || '').trim())
    .slice(0, 20);
  console.log('[parseCloseLog] First 20 non-empty rows from sheet:');
  sample.forEach((row, i) => {
    console.log(
      `  [${i}] col0=${JSON.stringify(row[0])} col1=${JSON.stringify(row[1])} ` +
      `col2=${JSON.stringify(row[2])} col3=${JSON.stringify(row[3])} col4=${JSON.stringify(row[4])}`
    );
  });

  const results = [];
  let skippedNoRep = 0, skippedSentinel = 0, skippedUnknownRep = 0;
  let skippedNoDate = 0, skippedNoRevenue = 0;

  for (const row of rows) {
    const rep = (row[0] || '').trim();

    if (!rep)                          { skippedNoRep++;      continue; }
    if (WEEKLY_SENTINELS.has(rep))     { skippedSentinel++;   continue; }
    if (!isKnownRep(rep))              { skippedUnknownRep++; continue; }

    const date = parseDate(row[1]);
    if (!date)                         { skippedNoDate++;     continue; }

    if (!isRevenueCell(row[2]))        { skippedNoRevenue++;  continue; }

    results.push({
      rep_name:    rep,
      close_date:  date,
      revenue:     parseRevenue(row[2]),
      lead_source: (row[3] || '').trim() || null,
      location:    (row[4] || '').trim() || null,
    });
  }

  console.log(
    `[parseCloseLog] Parsed ${results.length} closes. ` +
    `Skipped: empty=${skippedNoRep}, sentinel=${skippedSentinel}, ` +
    `unknown-rep=${skippedUnknownRep}, no-date=${skippedNoDate}, no-revenue=${skippedNoRevenue}`
  );

  return results;
}

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

// Fetches both sheets and returns the parsed data without writing anything to
// the database. Used by GET /api/sales/debug-sync so parsing can be verified
// in production without affecting live data.
async function fetchParsed() {
  const [weeklyRows, activityRows] = await Promise.all([
    sheetsGet('Weekly Summary!A1:Z2000'),
    sheetsGet('KPI_RAW!A1:Z2000'),
  ]);

  return {
    weekly_stats: parseWeeklyStats(weeklyRows),
    closes:       parseCloseLog(weeklyRows),
    activity:     parseDailyActivity(activityRows),
    // Raw sample so the caller can see exactly what Google Sheets returned
    raw_weekly_sample: weeklyRows.slice(0, 30),
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

  const weeklyStats = parseWeeklyStats(weeklyRows);
  const closes      = parseCloseLog(weeklyRows);
  const activity    = parseDailyActivity(activityRows);
  const now         = new Date().toISOString();

  try {
    await db.transaction(async (tx) => {
      // Weekly stats: upsert by (rep_name, week_start)
      for (const row of weeklyStats) {
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
      // DO NOTHING preserves closes that were imported in previous syncs and
      // are no longer present in the current sheet window.
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
