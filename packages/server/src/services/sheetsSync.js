const fetch = require('node-fetch');
const { getDb } = require('../../db/schema');

const BASE_URL   = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEET_ID   = () => process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const API_KEY    = () => process.env.GOOGLE_SHEETS_API_KEY;

// ─── API client ──────────────────────────────────────────────────────────────

async function sheetsGet(range) {
  const url = `${BASE_URL}/${SHEET_ID()}/values/${encodeURIComponent(range)}?key=${API_KEY()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheets "${range}" → ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.values || [];
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// "4/13/2026" → "2026-04-13". Returns null for blank or malformed (e.g. "4/23/0206").
function parseDate(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const year = parseInt(m[3], 10);
  if (year < 2000 || year > 2100) return null;
  return `${year}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

// "$14,034.00" or "14034" → 14034
function parseRevenue(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[$,]/g, '')) || 0;
}

// ─── parsers ─────────────────────────────────────────────────────────────────

const WEEKLY_SENTINELS = new Set(['', 'Rep Name', 'TOTAL', 'END', 'Huracan Nero Auto Spa']);

// Weekly Summary sheet:
//   Date-range label row  → "04/13-04/19" in col A (skip)
//   Header row            → "Rep Name" in col A; cols J/K hold ISO start/end dates
//   Rep data rows         → rep_name, dials, texts (col 1 is an integer, not a date)
//   Close log rows        → col[1] is a valid full date — skip here, parsed by parseCloseLog
//   Sentinel rows         → "TOTAL", "END", blank — all skipped
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

    // Close log rows have a full date in col[1] — skip them here
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

// Close log section at the bottom of the Weekly Summary sheet:
//   Rep | Date | Revenue | Lead Source | Location
// A close log row is identified by col[1] being a valid full date (M/D/YYYY).
// This works for all weeks/months as long as new rows follow the same format.
function parseCloseLog(rows) {
  const results = [];
  for (const row of rows) {
    const rep = (row[0] || '').trim();
    if (!rep || WEEKLY_SENTINELS.has(rep)) continue;
    const date = parseDate(row[1]);
    if (!date) continue; // not a close log row (date range, header, weekly stat, etc.)
    results.push({
      rep_name:    rep,
      close_date:  date,
      revenue:     parseRevenue(row[2]),
      lead_source: (row[3] || '').trim() || null,
      location:    (row[4] || '').trim() || null,
    });
  }
  return results;
}

// KPI_RAW sheet: Rep | Date | Dials | Texts
// Row 0 is the header. Rows with no dials/texts (e.g. future date placeholders) are skipped.
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
    results.push({
      rep_name:      rep,
      activity_date: date,
      dials,
      texts,
    });
  }
  return results;
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

  // Both weekly stats and close log come from the same Weekly Summary sheet.
  // Weekly stat rows: col[1] is dials (integer). Close log rows: col[1] is a full date.
  const weeklyStats = parseWeeklyStats(weeklyRows);
  const closes      = parseCloseLog(weeklyRows);
  const activity    = parseDailyActivity(activityRows);

  const db  = getDb();
  const now = new Date().toISOString();

  try {
    db.transaction(() => {
      // Weekly stats: upsert by (rep_name, week_start) — one row per rep per week
      const upsertWeekly = db.prepare(`
        INSERT INTO rep_weekly_stats
          (rep_name, week_start, week_end, dials, texts, closes, revenue, lead_sources, locations, synced_at)
        VALUES
          (@rep_name, @week_start, @week_end, @dials, @texts, @closes, @revenue, @lead_sources, @locations, @synced_at)
        ON CONFLICT(rep_name, week_start) DO UPDATE SET
          week_end     = excluded.week_end,
          dials        = excluded.dials,
          texts        = excluded.texts,
          closes       = excluded.closes,
          revenue      = excluded.revenue,
          lead_sources = excluded.lead_sources,
          locations    = excluded.locations,
          synced_at    = excluded.synced_at
      `);
      for (const row of weeklyStats) {
        upsertWeekly.run({ ...row, synced_at: now });
        summary.weekly++;
      }

      // Closes: full replace — a rep can have multiple closes on the same date,
      // so (rep_name, close_date) is not unique enough for upserts.
      db.prepare('DELETE FROM rep_closes').run();
      const insertClose = db.prepare(`
        INSERT INTO rep_closes (rep_name, close_date, revenue, lead_source, location, synced_at)
        VALUES (@rep_name, @close_date, @revenue, @lead_source, @location, @synced_at)
      `);
      for (const row of closes) {
        insertClose.run({ ...row, synced_at: now });
        summary.closes++;
      }

      // Daily activity: upsert by (rep_name, activity_date)
      const upsertActivity = db.prepare(`
        INSERT INTO rep_daily_activity
          (rep_name, activity_date, dials, texts, synced_at)
        VALUES
          (@rep_name, @activity_date, @dials, @texts, @synced_at)
        ON CONFLICT(rep_name, activity_date) DO UPDATE SET
          dials     = excluded.dials,
          texts     = excluded.texts,
          synced_at = excluded.synced_at
      `);
      for (const row of activity) {
        upsertActivity.run({ ...row, synced_at: now });
        summary.activity++;
      }
    })();
  } catch (err) {
    summary.errors.push({ source: 'db', error: err.message });
  } finally {
    db.close();
  }

  console.log(`[sheetsSync] Done — weekly: ${summary.weekly}, closes: ${summary.closes}, activity: ${summary.activity}, errors: ${summary.errors.length}`);
  return summary;
}

module.exports = { syncSheetsData };
