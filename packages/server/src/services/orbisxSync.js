const fetch = require('node-fetch');
const db = require('../../db/schema');

const BASE_URL = 'https://orbisx.ca/app/open-api/v1';

const SALES_REP_IDS = new Set(['74686', '83331', '89695', '90150', '89911']);
const DEFAULT_LOC   = () => parseInt(process.env.ORBISX_LOCATION_ID || '1', 10);

// ─── API client ──────────────────────────────────────────────────────────────

async function orbisxGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'Authorization': `Bearer ${process.env.ORBISXAPI_KEY}`,
      'X-Business-ID': process.env.ORBISX_BUSINESS_ID,
      'Content-Type':  'application/json',
    },
  });
  if (!res.ok) throw new Error(`OrbisX ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeSummary() { return { inserted: 0, updated: 0, errors: [] }; }
function recordError(summary, id, message) { summary.errors.push({ id, error: message }); }
function isComplete(val) { return val === 1 || val === '1' || val === true; }

function parseVehicle(v) {
  if (!v || typeof v !== 'object') {
    return { display: typeof v === 'string' ? v : null, year: null, make: null, model: null };
  }
  const year  = v.year  || null;
  const make  = v.make  || null;
  const model = v.model || null;
  const display = v.ymm?.trim() || [year, make, model].filter(Boolean).join(' ') || null;
  return { display, year, make, model };
}

function mapInvoiceStatus(s) {
  if (s === 1 || s === '1') return 'paid';
  if (s === 2 || s === '2') return 'void';
  return 'pending';
}

// ─── syncStaff ───────────────────────────────────────────────────────────────

async function syncStaff() {
  const summary = makeSummary();

  let staff;
  try {
    const data = await orbisxGet('/staff');
    staff = Array.isArray(data) ? data : (data.data ?? data.staff ?? []);
  } catch (err) {
    recordError(summary, 'request', err.message);
    return summary;
  }

  for (const member of staff) {
    const externalId = String(member.id ?? member.staff_id ?? '');
    if (!externalId) { recordError(summary, '?', 'Missing id'); continue; }

    try {
      const existing = await db.queryOne('SELECT id FROM reps WHERE external_id = ?', [externalId]);
      await db.run(
        `INSERT INTO reps (external_id, location_id, name, email, phone)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(external_id) DO UPDATE SET
           name  = excluded.name,
           email = excluded.email,
           phone = excluded.phone`,
        [externalId, DEFAULT_LOC(),
         member.contact ?? member.name ?? member.full_name ?? 'Unknown',
         member.email ?? null,
         member.phone ?? member.mobile ?? null]
      );
      existing ? summary.updated++ : summary.inserted++;
    } catch (err) {
      recordError(summary, externalId, err.message);
    }
  }

  return summary;
}

// ─── syncEvents ──────────────────────────────────────────────────────────────

async function syncEvents() {
  const summary = makeSummary();

  let events;
  try {
    const data = await orbisxGet('/events');
    events = Array.isArray(data) ? data : (data.data ?? data.events ?? []);
  } catch (err) {
    recordError(summary, 'request', err.message);
    return summary;
  }

  for (const event of events) {
    const externalId = String(event.id ?? event.event_id ?? '');
    if (!externalId) { recordError(summary, '?', 'Missing id'); continue; }

    try {
      const complete  = isComplete(event.complete);
      const noShow    = event.no_show || (event.title || '').toLowerCase().includes('no show') || (event.title || '').toLowerCase().includes('no-show');
      const isPast    = event.starts && new Date(event.starts) < new Date();
      const status    = complete ? 'completed' : noShow ? 'no_show' : (!complete && isPast) ? 'incomplete' : 'scheduled';
      const customer  = (event.client?.contact || event.title || 'Unknown').trim();
      const services  = Array.isArray(event.services) ? event.services : [];
      const serviceType = services[0]?.name ?? null;
      const veh       = parseVehicle(event.vehicle);
      const revenue   = parseFloat(event.price ?? event.total ?? 0) || null;
      const scheduledAt = event.starts ?? event.start ?? null;
      const completedAt = complete ? (event.ends ?? event.end ?? null) : null;
      const staffArr  = Array.isArray(event.staff) ? event.staff : [];
      const salesStaff = staffArr.find((s) => SALES_REP_IDS.has(String(s.id)));
      const repRow    = salesStaff
        ? await db.queryOne('SELECT id FROM reps WHERE external_id = ?', [String(salesStaff.id)])
        : null;
      const repId     = repRow?.id ?? null;

      const existing = await db.queryOne('SELECT id FROM jobs WHERE external_id = ?', [externalId]);
      await db.run(
        `INSERT INTO jobs
           (external_id, location_id, rep_id, customer_name, service_type,
            vehicle, vehicle_year, vehicle_make, vehicle_model,
            revenue, status, scheduled_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(external_id) DO UPDATE SET
           rep_id        = excluded.rep_id,
           customer_name = excluded.customer_name,
           service_type  = excluded.service_type,
           vehicle       = excluded.vehicle,
           vehicle_year  = excluded.vehicle_year,
           vehicle_make  = excluded.vehicle_make,
           vehicle_model = excluded.vehicle_model,
           revenue       = excluded.revenue,
           status        = excluded.status,
           scheduled_at  = excluded.scheduled_at,
           completed_at  = excluded.completed_at`,
        [externalId, DEFAULT_LOC(), repId, customer, serviceType,
         veh.display, veh.year, veh.make, veh.model,
         revenue, status, scheduledAt, completedAt]
      );
      existing ? summary.updated++ : summary.inserted++;
    } catch (err) {
      recordError(summary, externalId, err.message);
    }
  }

  return summary;
}

// ─── syncInvoices ─────────────────────────────────────────────────────────────

async function syncInvoices() {
  const summary = makeSummary();

  let invoices;
  try {
    const data = await orbisxGet('/invoices');
    invoices = Array.isArray(data) ? data : (data.data ?? data.invoices ?? []);
  } catch (err) {
    recordError(summary, 'request', err.message);
    return summary;
  }

  for (const inv of invoices) {
    const externalId = String(inv.invoice_id ?? inv.id ?? '');
    if (!externalId) { recordError(summary, '?', 'Missing invoice_id'); continue; }

    try {
      const eventExtId = String(inv.reference_event_id ?? '');
      const jobRow     = eventExtId
        ? await db.queryOne('SELECT id FROM jobs WHERE external_id = ?', [eventExtId])
        : null;

      if (!jobRow) {
        recordError(summary, externalId, `No matching job for reference_event_id "${eventExtId}" — run syncEvents first`);
        continue;
      }

      const amount   = parseFloat(inv.total ?? inv.subtotal ?? 0) || 0;
      const issuedAt = inv.date_of_issue ?? inv.issued_at ?? null;
      const status   = mapInvoiceStatus(inv.status);

      const existing = await db.queryOne('SELECT id FROM invoices WHERE external_id = ?', [externalId]);
      await db.run(
        `INSERT INTO invoices (external_id, job_id, location_id, amount, status, issued_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(external_id) DO UPDATE SET
           job_id    = excluded.job_id,
           amount    = excluded.amount,
           status    = excluded.status,
           issued_at = excluded.issued_at`,
        [externalId, jobRow.id, DEFAULT_LOC(), amount, status, issuedAt]
      );
      existing ? summary.updated++ : summary.inserted++;
    } catch (err) {
      recordError(summary, externalId, err.message);
    }
  }

  return summary;
}

// ─── syncAll ─────────────────────────────────────────────────────────────────

async function syncAll() {
  console.log('[orbisxSync] Starting full sync...');

  // OrbisX rejects concurrent requests from the same API key — run sequentially
  const staffResult    = await syncStaff().catch((err) => ({ inserted: 0, updated: 0, errors: [{ error: err.message }] }));
  const eventsResult   = await syncEvents().catch((err) => ({ inserted: 0, updated: 0, errors: [{ error: err.message }] }));
  const invoicesResult = await syncInvoices().catch((err) => ({ inserted: 0, updated: 0, errors: [{ error: err.message }] }));

  const summary = { staff: staffResult, events: eventsResult, invoices: invoicesResult };
  const totals  = ['staff','events','invoices'].map(
    (k) => `${k}: +${summary[k].inserted} ~${summary[k].updated} ✗${summary[k].errors.length}`
  );
  console.log(`[orbisxSync] Done — ${totals.join(' | ')}`);
  return summary;
}

module.exports = { syncAll, syncEvents, syncInvoices, syncStaff };
