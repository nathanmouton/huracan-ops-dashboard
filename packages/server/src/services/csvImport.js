const { parse } = require('csv-parse');
const fs   = require('fs');
const path = require('path');
const { getDb } = require('../../db/schema');
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

// Fire all notify promises without blocking; errors are swallowed inside each fn
function fireAndForget(promises) {
  Promise.allSettled(promises).catch(() => {});
}

// ─── importJobs ─────────────────────────────────────────────────────────────

async function importJobs(filePath, locationId) {
  const REQUIRED = ['external_id', 'customer_name', 'status'];
  const summary = makeSummary();

  let rows;
  try {
    rows = await parseCsv(filePath);
  } catch (err) {
    rowError(summary, 0, `CSV parse failed: ${err.message}`, null);
    return summary;
  }

  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO jobs
      (external_id, location_id, rep_id, customer_name, service_type,
       vehicle_year, vehicle_make, vehicle_model, revenue,
       status, scheduled_at, completed_at)
    VALUES
      (@external_id, @location_id, @rep_id, @customer_name, @service_type,
       @vehicle_year, @vehicle_make, @vehicle_model, @revenue,
       @status, @scheduled_at, @completed_at)
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
      completed_at  = excluded.completed_at
  `);

  const exists     = db.prepare('SELECT id FROM jobs WHERE external_id = ?');
  const getRepName = db.prepare('SELECT name FROM reps WHERE id = ?');
  const getLocCity = db.prepare('SELECT city FROM locations WHERE id = ?');

  const toNotify = []; // { type: 'confirmation'|'checkout', payload }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const missing = missingColumns(row, REQUIRED);
    if (missing.length) {
      rowError(summary, i + 1, `Missing required columns: ${missing.join(', ')}`, row);
      continue;
    }

    try {
      const isUpdate    = !!exists.get(row.external_id);
      const resolvedLoc = parseInt(nullish(row.location_id) ?? locationId, 10);

      upsert.run({
        external_id:   row.external_id,
        location_id:   resolvedLoc,
        rep_id:        nullish(row.rep_id),
        customer_name: row.customer_name,
        service_type:  nullish(row.service_type),
        vehicle_year:  nullish(row.vehicle_year),
        vehicle_make:  nullish(row.vehicle_make),
        vehicle_model: nullish(row.vehicle_model),
        revenue:       toFloat(row.revenue),
        status:        row.status,
        scheduled_at:  nullish(row.scheduled_at),
        completed_at:  nullish(row.completed_at),
      });

      isUpdate ? summary.updated++ : summary.inserted++;

      // Only notify on new inserts to avoid noise from re-imports
      if (!isUpdate) {
        const repIdNum  = row.rep_id ? parseInt(row.rep_id, 10) : null;
        const repName   = repIdNum && !isNaN(repIdNum) ? (getRepName.get(repIdNum)?.name ?? 'Unassigned') : 'Unassigned';
        const locCity   = getLocCity.get(resolvedLoc)?.city ?? '';
        const payload   = {
          customer_name: row.customer_name,
          service_type:  row.service_type || '—',
          vehicle_year:  row.vehicle_year,
          vehicle_make:  row.vehicle_make,
          vehicle_model: row.vehicle_model,
          revenue:       toFloat(row.revenue),
          scheduled_at:  row.scheduled_at,
          rep_name:      repName,
          location_name: locCity,
        };

        if (row.status === 'scheduled')  toNotify.push({ type: 'confirmation', payload });
        if (row.status === 'completed')  toNotify.push({ type: 'checkout',     payload });
      }
    } catch (err) {
      rowError(summary, i + 1, err.message, row);
    }
  }

  db.close();

  fireAndForget([
    ...toNotify.map((n) =>
      n.type === 'confirmation'
        ? slack.notifyConfirmation(n.payload)
        : slack.notifyCheckout(n.payload)
    ),
    slack.notifyManagers({
      filename:    path.basename(filePath),
      type:        'jobs',
      inserted:    summary.inserted,
      updated:     summary.updated,
      errors:      summary.errors.length,
      location_id: locationId,
    }),
  ]);

  return summary;
}

// ─── importInvoices ──────────────────────────────────────────────────────────

async function importInvoices(filePath, locationId) {
  const REQUIRED = ['external_id', 'job_id', 'amount', 'status'];
  const summary = makeSummary();

  let rows;
  try {
    rows = await parseCsv(filePath);
  } catch (err) {
    rowError(summary, 0, `CSV parse failed: ${err.message}`, null);
    return summary;
  }

  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO invoices
      (external_id, job_id, location_id, amount, status, issued_at, paid_at)
    VALUES
      (@external_id, @job_id, @location_id, @amount, @status, @issued_at, @paid_at)
    ON CONFLICT(external_id) DO UPDATE SET
      job_id      = excluded.job_id,
      location_id = excluded.location_id,
      amount      = excluded.amount,
      status      = excluded.status,
      issued_at   = excluded.issued_at,
      paid_at     = excluded.paid_at
  `);

  const jobById    = db.prepare('SELECT id FROM jobs WHERE external_id = ?');
  const getJobCtx  = db.prepare(`
    SELECT j.customer_name, j.service_type, l.city AS location_name
    FROM   jobs j LEFT JOIN locations l ON j.location_id = l.id
    WHERE  j.id = ?
  `);
  const exists     = db.prepare('SELECT id FROM invoices WHERE external_id = ?');

  const invoiceNotifications = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const missing = missingColumns(row, REQUIRED);
    if (missing.length) {
      rowError(summary, i + 1, `Missing required columns: ${missing.join(', ')}`, row);
      continue;
    }

    try {
      let jobId = parseInt(row.job_id, 10);
      if (isNaN(jobId)) {
        const job = jobById.get(row.job_id);
        if (!job) {
          rowError(summary, i + 1, `No job found for job_id "${row.job_id}"`, row);
          continue;
        }
        jobId = job.id;
      }

      const isUpdate = !!exists.get(row.external_id);
      upsert.run({
        external_id: row.external_id,
        job_id:      jobId,
        location_id: nullish(row.location_id) ?? locationId,
        amount:      toFloat(row.amount) ?? 0,
        status:      row.status,
        issued_at:   nullish(row.issued_at),
        paid_at:     nullish(row.paid_at),
      });

      isUpdate ? summary.updated++ : summary.inserted++;

      if (!isUpdate) {
        const ctx = getJobCtx.get(jobId);
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

  db.close();

  fireAndForget([
    ...invoiceNotifications.map((inv) => slack.notifyInvoice(inv)),
    slack.notifyManagers({
      filename:    path.basename(filePath),
      type:        'invoices',
      inserted:    summary.inserted,
      updated:     summary.updated,
      errors:      summary.errors.length,
      location_id: locationId,
    }),
  ]);

  return summary;
}

// ─── importReps ──────────────────────────────────────────────────────────────

async function importReps(filePath, locationId) {
  const REQUIRED = ['external_id', 'name'];
  const summary = makeSummary();

  let rows;
  try {
    rows = await parseCsv(filePath);
  } catch (err) {
    rowError(summary, 0, `CSV parse failed: ${err.message}`, null);
    return summary;
  }

  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO reps (external_id, location_id, name, email, phone)
    VALUES (@external_id, @location_id, @name, @email, @phone)
    ON CONFLICT(external_id) DO UPDATE SET
      location_id = excluded.location_id,
      name        = excluded.name,
      email       = excluded.email,
      phone       = excluded.phone
  `);

  const exists = db.prepare('SELECT id FROM reps WHERE external_id = ?');

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const missing = missingColumns(row, REQUIRED);
    if (missing.length) {
      rowError(summary, i + 1, `Missing required columns: ${missing.join(', ')}`, row);
      continue;
    }

    try {
      const isUpdate = !!exists.get(row.external_id);
      upsert.run({
        external_id: row.external_id,
        location_id: nullish(row.location_id) ?? locationId,
        name:        row.name,
        email:       nullish(row.email),
        phone:       nullish(row.phone),
      });
      isUpdate ? summary.updated++ : summary.inserted++;
    } catch (err) {
      rowError(summary, i + 1, err.message, row);
    }
  }

  db.close();

  fireAndForget([
    slack.notifyManagers({
      filename:    path.basename(filePath),
      type:        'reps',
      inserted:    summary.inserted,
      updated:     summary.updated,
      errors:      summary.errors.length,
      location_id: locationId,
    }),
  ]);

  return summary;
}

// ─── importUpsells ───────────────────────────────────────────────────────────

async function importUpsells(filePath, locationId) {
  const REQUIRED = ['external_id', 'job_id', 'item', 'amount'];
  const summary = makeSummary();

  let rows;
  try {
    rows = await parseCsv(filePath);
  } catch (err) {
    rowError(summary, 0, `CSV parse failed: ${err.message}`, null);
    return summary;
  }

  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO upsells (external_id, job_id, rep_id, location_id, service, price, sold_at)
    VALUES (@external_id, @job_id, @rep_id, @location_id, @service, @price, @sold_at)
    ON CONFLICT(external_id) DO UPDATE SET
      job_id      = excluded.job_id,
      rep_id      = excluded.rep_id,
      location_id = excluded.location_id,
      service     = excluded.service,
      price       = excluded.price,
      sold_at     = excluded.sold_at
  `);

  const jobById    = db.prepare('SELECT id FROM jobs WHERE external_id = ?');
  const repById    = db.prepare('SELECT id FROM reps WHERE external_id = ?');
  const getRepName = db.prepare('SELECT name FROM reps WHERE id = ?');
  const getLocCity = db.prepare('SELECT city FROM locations WHERE id = ?');
  const exists     = db.prepare('SELECT id FROM upsells WHERE external_id = ?');

  const upsellNotifications = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const missing = missingColumns(row, REQUIRED);
    if (missing.length) {
      rowError(summary, i + 1, `Missing required columns: ${missing.join(', ')}`, row);
      continue;
    }

    try {
      let jobId = parseInt(row.job_id, 10);
      if (isNaN(jobId)) {
        const job = jobById.get(row.job_id);
        if (!job) {
          rowError(summary, i + 1, `No job found for job_id "${row.job_id}"`, row);
          continue;
        }
        jobId = job.id;
      }

      let repId = nullish(row.rep_id);
      if (repId && isNaN(parseInt(repId, 10))) {
        repId = repById.get(repId)?.id ?? null;
      }

      const resolvedLoc = parseInt(nullish(row.location_id) ?? locationId, 10);
      const isUpdate    = !!exists.get(row.external_id);

      upsert.run({
        external_id: row.external_id,
        job_id:      jobId,
        rep_id:      repId,
        location_id: resolvedLoc,
        service:     row.item,
        price:       toFloat(row.amount) ?? 0,
        sold_at:     nullish(row.sold_at),
      });

      isUpdate ? summary.updated++ : summary.inserted++;

      if (!isUpdate) {
        const repIdNum = repId ? parseInt(repId, 10) : null;
        const repName  = repIdNum && !isNaN(repIdNum) ? (getRepName.get(repIdNum)?.name ?? 'Unassigned') : 'Unassigned';
        const locCity  = getLocCity.get(resolvedLoc)?.city ?? '';
        upsellNotifications.push({
          service:       row.item,
          price:         toFloat(row.amount) ?? 0,
          rep_name:      repName,
          location_name: locCity,
        });
      }
    } catch (err) {
      rowError(summary, i + 1, err.message, row);
    }
  }

  db.close();

  fireAndForget([
    ...upsellNotifications.map((u) => slack.notifyUpsell(u)),
    slack.notifyManagers({
      filename:    path.basename(filePath),
      type:        'upsells',
      inserted:    summary.inserted,
      updated:     summary.updated,
      errors:      summary.errors.length,
      location_id: locationId,
    }),
  ]);

  return summary;
}

module.exports = { importJobs, importInvoices, importReps, importUpsells };
