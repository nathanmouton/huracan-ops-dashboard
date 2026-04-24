const cron = require('node-cron');
const fs   = require('fs');
const path = require('path');
const { importJobs, importInvoices, importReps, importUpsells } = require('./csvImport');
const { notifyDailyGameplan } = require('./slack');
const { syncAll } = require('./orbisxSync');
const { syncSheetsData } = require('./sheetsSync');
const { getDb } = require('../../db/schema');

const WATCH_DIR     = path.join(__dirname, '../../data/watch');
const PROCESSED_DIR = path.join(__dirname, '../../data/processed');

const IMPORTERS = {
  jobs_:     importJobs,
  invoices_: importInvoices,
  reps_:     importReps,
  upsells_:  importUpsells,
};

// ─── watch-dir import (every 5 hours) ────────────────────────────────────────

async function processWatchDir() {
  const ts = new Date().toISOString();
  console.log(`[scheduler] ${ts} — scanning watch dir`);

  let files;
  try {
    files = fs.readdirSync(WATCH_DIR).filter((f) => f.endsWith('.csv'));
  } catch (err) {
    console.error('[scheduler] Cannot read watch dir:', err.message);
    return;
  }

  if (files.length === 0) {
    console.log('[scheduler] No CSV files found.');
    return;
  }

  for (const filename of files) {
    const prefix = Object.keys(IMPORTERS).find((p) => filename.startsWith(p));
    if (!prefix) {
      console.warn(`[scheduler] Skipping "${filename}" — no matching importer (expected prefix: ${Object.keys(IMPORTERS).join(', ')})`);
      continue;
    }

    const filePath = path.join(WATCH_DIR, filename);
    console.log(`[scheduler] Importing "${filename}" with ${prefix.replace('_', '')} importer`);

    try {
      const summary = await IMPORTERS[prefix](filePath, null);
      console.log(`[scheduler] "${filename}" done — inserted: ${summary.inserted}, updated: ${summary.updated}, errors: ${summary.errors.length}`);

      const dest = path.join(PROCESSED_DIR, `${Date.now()}_${filename}`);
      fs.renameSync(filePath, dest);
    } catch (err) {
      console.error(`[scheduler] Failed to process "${filename}":`, err.message);
    }
  }
}

// ─── daily 7 AM gameplan (Central Time) ──────────────────────────────────────

async function sendDailyGameplans() {
  console.log('[scheduler] Sending daily gameplans to Slack...');

  const db = getDb();

  // Pull tomorrow's scheduled jobs, grouped by location
  const jobs = db.prepare(`
    SELECT
      j.id,
      j.customer_name,
      j.service_type,
      j.vehicle_year,
      j.vehicle_make,
      j.vehicle_model,
      j.scheduled_at,
      COALESCE(r.name, 'Unassigned') AS rep_name,
      l.city                         AS location_name
    FROM jobs j
    LEFT JOIN reps      r ON j.rep_id      = r.id
    LEFT JOIN locations l ON j.location_id = l.id
    WHERE j.status = 'scheduled'
      AND date(j.scheduled_at) = date('now', '+1 day')
    ORDER BY l.city, j.scheduled_at
  `).all();

  db.close();

  if (jobs.length === 0) {
    console.log('[scheduler] No jobs scheduled for tomorrow.');
    return;
  }

  // Group by location city
  const byLocation = {};
  for (const job of jobs) {
    const city = job.location_name;
    if (!byLocation[city]) byLocation[city] = [];
    byLocation[city].push(job);
  }

  // Fire one Slack message per location
  await Promise.allSettled(
    Object.entries(byLocation).map(([city, locationJobs]) =>
      notifyDailyGameplan(city, locationJobs)
    )
  );

  console.log(`[scheduler] Gameplans sent for: ${Object.keys(byLocation).join(', ')}`);
}

// ─── start ────────────────────────────────────────────────────────────────────

async function runSync() {
  await processWatchDir();
  await syncAll().catch((err) => console.error('[scheduler] OrbisX sync error:', err.message));
  await syncSheetsData().catch((err) => console.error('[scheduler] Sheets sync error:', err.message));
}

function startScheduler() {
  cron.schedule('0 */5 * * *', runSync);
  console.log('[scheduler] OrbisX sync + watch-dir import scheduled every 5 hours.');

  cron.schedule('0 7 * * *', sendDailyGameplans, { timezone: 'America/Chicago' });
  console.log('[scheduler] Daily gameplan scheduled at 7:00 AM CT.');
}

module.exports = { startScheduler, processWatchDir, sendDailyGameplans, runSync };
