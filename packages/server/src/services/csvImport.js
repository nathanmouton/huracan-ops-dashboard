const { parse } = require('csv-parse');
const fs   = require('fs');
const path = require('path');
const db   = require('../../db/schema');
const slack = require('./slack');

// ─── helpers ────────────────────────────────────────────────────────────────

function parseCsv(filePath) {
  return new Promise((resolve, reject) => {
    const records = [];
    fs.createReadStream(filePath)
      .pipe(parse({ columns: true, trim: true, skip_empty_lines: true }))
      .on('data', (row) => records.push(row))
      .on('error', reject)
      .on('end', () => resolve(records));
  });
}

function missingColumns(row, required) {
  return required.filter((col) => !(col in row));
}

function nullish(val) {
  return val === '' || val === undefined ? null : val;
}

function toFloat(val) {
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

function makeSummary() {
  return { inserted: 0, updated: 0, errors: [] };
}

function rowError(summary, rowNum, message, data) {
  summary.errors.push({ row: rowNum, error: message, data });
}

function fireAndForget(promises) {
  Promise.allSettled(promises).catch(() => {});
}

// ─── importJobs ─────────────────────────────────────────────────────────────

async function importJobs(filePath, locationId) {
  const REQUIRED = ['external_id', 'customer_name', 'status'];
  const summary  = makeSummary();

  let rows;
  try {
    rows = await parseCsv(filePath);
  } catch (err) {
    rowError(summary, 0, `CSV parse failed: ${err.message}`, null);
    return summary;
  }

  const toNotify = [];

  for (let i = 0; i < rows.length; i++) {
    const row     = rows[i];
    const missing = missingColumns(row, REQUIRED);
    if (missing.length) {
      rowError(summary, i + 1, `Missing required columns: ${missing.join(', ')}`, row);
      continue;
    }

    try {
      const existing    = await db.queryOne('SELECT id FROM jobs WHERE external_id = ?', [row.external_id]);
      const isUpdate    = !!existing;
      const resolvedLoc = parseInt(nullish(row.location_id) ?? locationId, 10);

      await db.run(
        `INSERT INTO jobs
           (external_id, location_id, rep_id, customer_name, service_type,
            vehicle_year, vehicle_make, vehicle_model, revenue,
            status, scheduled_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(external_id) DO UPDATE SET
           location_id   = excluded.location_id,
           rep_id        = excluded.rep_id,
           customer_name = excluded.customer_name,
           service_type  = excluded.service_type,
           vehicle_year  = excluded.vehicle_year,
           vehicle_make  = excluded.vehicle_make,
           vehicle_model = excluded.vehicle_model,
           revenue       = excluded.revenue,
           status        = excluded.status,
           scheduled_at  = excluded.scheduled_at,
           completed_at  = excluded.completed_at`,
        [row.external_id, resolvedLoc, nullish(row.rep_id), row.customer_name,
         nullish(row.service_type), nullish(row.vehicle_year), nullish(row.vehicle_make),
         nullish(row.vehicle_model), toFloat(row.revenue), row.status,
         nullish(row.scheduled_at), nullish(row.completed_at)]
      );

      isUpdate ? summary.updated++ : summary.inserted++;

      if (!isUpdate) {
        const repIdNum = row.rep_id ? parseInt(row.rep_id, 10) : null;
        const repRow   = repIdNum && !isNaN(repIdNum)
          ? await db.queryOne('SELECT name FROM reps WHERE id = ?', [repIdNum])
          : null;
        const locRow   = await db.queryOne('SELECT city FROM locations WHERE id = ?', [resolvedLoc]);

        const payload = {
          customer_name: row.customer_name,
          service_type:  row.service_type || '—',
          vehicle_year:  row.vehicle_year,
          vehicle_make:  row.vehicle_make,
          vehicle_model: row.vehicle_model,
          revenue:       toFloat(row.revenue),
          scheduled_at:  row.scheduled_at,
          rep_name:      repRow?.name ?? 'Unassigned',
          location_name: locRow?.city ?? '',
        };
        if (row.status === 'scheduled') toNotify.push({ type: 'confirmation', payload });
        if (row.status === 'completed') toNotify.push({ type: 'checkout',     payload });
      }
    } catch (err) {
      rowError(summary, i + 1, err.message, row);
    }
  }

  fireAndForget([
    ...toNotify.map((n) =>
      n.type === 'confirmation'
        ? slack.notifyConfirmation(n.payload)
        : slack.notifyCheckout(n.payload)
    ),
    slack.notifyManagers({
      filename: path.basename(filePath), type: 'jobs',
      inserted: summary.inserted, updated: summary.updated,
      errors: summary.errors.length, location_id: locationId,
    }),
  ]);

  return summary;
}

// ─── importInvoices ──────────────────────────────────────────────────────────

async function importInvoices(filePath, locationId) {
  const REQUIRED = ['external_id', 'job_id', 'amount', 'status'];
  const summary  = makeSummary();

  let rows;
  try {
    rows = await parseCsv(filePath);
  } catch (err) {
    rowError(summary, 0, `CSV parse failed: ${err.message}`, null);
    return summary;
  }

  const invoiceNotifications = [];

  for (let i = 0; i < rows.length; i++) {
    const row     = rows[i];
    const missing = missingColumns(row, REQUIRED);
    if (missing.length) {
      rowError(summary, i + 1, `Missing required columns: ${missing.join(', ')}`, row);
      continue;
    }

    try {
      let jobId = parseInt(row.job_id, 10);
      if (isNaN(jobId)) {
        const job = await db.queryOne('SELECT id FROM jobs WHERE external_id = ?', [row.job_id]);
        if (!job) {
          rowError(summary, i + 1, `No job found for job_id "${row.job_id}"`, row);
          continue;
        }
        jobId = job.id;
      }

      const existing = await db.queryOne('SELECT id FROM invoices WHERE external_id = ?', [row.external_id]);
      await db.run(
        `INSERT INTO invoices (external_id, job_id, location_id, amount, status, issued_at, paid_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(external_id) DO UPDATE SET
           job_id      = excluded.job_id,
           location_id = excluded.location_id,
           amount      = excluded.amount,
           status      = excluded.status,
           issued_at   = excluded.issued_at,
           paid_at     = excluded.paid_at`,
        [row.external_id, jobId, nullish(row.location_id) ?? locationId,
         toFloat(row.amount) ?? 0, row.status, nullish(row.issued_at), nullish(row.paid_at)]
      );

      const isUpdate = !!existing;
      isUpdate ? summary.updated++ : summary.inserted++;

      if (!isUpdate) {
        const ctx = await db.queryOne(
          `SELECT j.customer_name, j.service_type, l.city AS location_name
           FROM jobs j LEFT JOIN locations l ON j.location_id = l.id
           WHERE j.id = ?`,
          [jobId]
        );
        invoiceNotifications.push({
          customer_name: ctx?.customer_name ?? '—',
          service_type:  ctx?.service_type  ?? '—',
          amount:        toFloat(row.amount) ?? 0,
          status:        row.status,
          location_name: ctx?.location_name ?? '—',
        });
      }
    } catch (err) {
      rowError(summary, i + 1, err.message, row);
    }
  }

  fireAndForget([
    ...invoiceNotifications.map((inv) => slack.notifyInvoice(inv)),
    slack.notifyManagers({
      filename: path.basename(filePath), type: 'invoices',
      inserted: summary.inserted, updated: summary.updated,
      errors: summary.errors.length, location_id: locationId,
    }),
  ]);

  return summary;
}

// ─── importReps ──────────────────────────────────────────────────────────────

async function importReps(filePath, locationId) {
  const REQUIRED = ['external_id', 'name'];
  const summary  = makeSummary();

  let rows;
  try {
    rows = await parseCsv(filePath);
  } catch (err) {
    rowError(summary, 0, `CSV parse failed: ${err.message}`, null);
    return summary;
  }

  for (let i = 0; i < rows.length; i++) {
    const row     = rows[i];
    const missing = missingColumns(row, REQUIRED);
    if (missing.length) {
      rowError(summary, i + 1, `Missing required columns: ${missing.join(', ')}`, row);
      continue;
    }

    try {
      const existing = await db.queryOne('SELECT id FROM reps WHERE external_id = ?', [row.external_id]);
      await db.run(
        `INSERT INTO reps (external_id, location_id, name, email, phone)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(external_id) DO UPDATE SET
           location_id = excluded.location_id,
           name        = excluded.name,
           email       = excluded.email,
           phone       = excluded.phone`,
        [row.external_id, nullish(row.location_id) ?? locationId,
         row.name, nullish(row.email), nullish(row.phone)]
      );
      existing ? summary.updated++ : summary.inserted++;
    } catch (err) {
      rowError(summary, i + 1, err.message, row);
    }
  }

  fireAndForget([
    slack.notifyManagers({
      filename: path.basename(filePath), type: 'reps',
      inserted: summary.inserted, updated: summary.updated,
      errors: summary.errors.length, location_id: locationId,
    }),
  ]);

  return summary;
}

// ─── importUpsells ───────────────────────────────────────────────────────────

async function importUpsells(filePath, locationId) {
  const REQUIRED = ['external_id', 'job_id', 'item', 'amount'];
  const summary  = makeSummary();

  let rows;
  try {
    rows = await parseCsv(filePath);
  } catch (err) {
    rowError(summary, 0, `CSV parse failed: ${err.message}`, null);
    return summary;
  }

  const upsellNotifications = [];

  for (let i = 0; i < rows.length; i++) {
    const row     = rows[i];
    const missing = missingColumns(row, REQUIRED);
    if (missing.length) {
      rowError(summary, i + 1, `Missing required columns: ${missing.join(', ')}`, row);
      continue;
    }

    try {
      let jobId = parseInt(row.job_id, 10);
      if (isNaN(jobId)) {
        const job = await db.queryOne('SELECT id FROM jobs WHERE external_id = ?', [row.job_id]);
        if (!job) {
          rowError(summary, i + 1, `No job found for job_id "${row.job_id}"`, row);
          continue;
        }
        jobId = job.id;
      }

      let repId = nullish(row.rep_id);
      if (repId && isNaN(parseInt(repId, 10))) {
        const rep = await db.queryOne('SELECT id FROM reps WHERE external_id = ?', [repId]);
        repId = rep?.id ?? null;
      }

      const resolvedLoc = parseInt(nullish(row.location_id) ?? locationId, 10);
      const existing    = await db.queryOne('SELECT id FROM upsells WHERE external_id = ?', [row.external_id]);

      await db.run(
        `INSERT INTO upsells (external_id, job_id, rep_id, location_id, service, price, sold_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(external_id) DO UPDATE SET
           job_id      = excluded.job_id,
           rep_id      = excluded.rep_id,
           location_id = excluded.location_id,
           service     = excluded.service,
           price       = excluded.price,
           sold_at     = excluded.sold_at`,
        [row.external_id, jobId, repId, resolvedLoc,
         row.item, toFloat(row.amount) ?? 0, nullish(row.sold_at)]
      );

      const isUpdate = !!existing;
      isUpdate ? summary.updated++ : summary.inserted++;

      if (!isUpdate) {
        const repIdNum = repId ? parseInt(repId, 10) : null;
        const repRow   = repIdNum && !isNaN(repIdNum)
          ? await db.queryOne('SELECT name FROM reps WHERE id = ?', [repIdNum])
          : null;
        const locRow   = await db.queryOne('SELECT city FROM locations WHERE id = ?', [resolvedLoc]);
        upsellNotifications.push({
          service:       row.item,
          price:         toFloat(row.amount) ?? 0,
          rep_name:      repRow?.name ?? 'Unassigned',
          location_name: locRow?.city ?? '',
        });
      }
    } catch (err) {
      rowError(summary, i + 1, err.message, row);
    }
  }

  fireAndForget([
    ...upsellNotifications.map((u) => slack.notifyUpsell(u)),
    slack.notifyManagers({
      filename: path.basename(filePath), type: 'upsells',
      inserted: summary.inserted, updated: summary.updated,
      errors: summary.errors.length, location_id: locationId,
    }),
  ]);

  return summary;
}

module.exports = { importJobs, importInvoices, importReps, importUpsells };
