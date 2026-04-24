const fetch = require('node-fetch');

// ─── webhook registry ────────────────────────────────────────────────────────

const GAMEPLAN = {
  Austin:      process.env.SLACK_AUSTIN_GAMEPLAN,
  Frisco:      process.env.SLACK_FRISCO_GAMEPLAN,
  Roanoke:     process.env.SLACK_ROANOKE_GAMEPLAN,
  Houston:     process.env.SLACK_HOUSTON_GAMEPLAN,
  'Fort Worth': process.env.SLACK_FORT_WORTH_GAMEPLAN,
};

const HOOKS = {
  confirmations: process.env.SLACK_CONFIRMATIONS,
  checkouts:     process.env.SLACK_CHECKOUTS,
  invoices:      process.env.SLACK_INVOICES,
  upsells:       process.env.SLACK_UPSELLS,
  managers:      process.env.SLACK_MANAGERS,
};

// ─── core poster ─────────────────────────────────────────────────────────────

async function post(url, text) {
  if (!url || url.includes('paste_url_here')) {
    console.warn('[slack] webhook not configured — skipping');
    return;
  }
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`[slack] POST failed ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error('[slack] POST error:', err.message);
  }
}

// ─── format helpers ───────────────────────────────────────────────────────────

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function fmtCurrency(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n ?? 0);
}

function vehicle(job) {
  return [job.vehicle_year, job.vehicle_make, job.vehicle_model].filter(Boolean).join(' ') || '—';
}

// ─── notify functions ─────────────────────────────────────────────────────────

// Posts to the location's #gameplan channel.
// jobs: array of { scheduled_at, rep_name, service_type, vehicle_year, vehicle_make, vehicle_model, customer_name }
async function notifyDailyGameplan(locationName, jobs) {
  const url = GAMEPLAN[locationName];
  if (!jobs.length) return;

  const dateLabel = fmtDate(jobs[0].scheduled_at);
  const bullets = jobs
    .map((j) => `• ${fmtTime(j.scheduled_at)} — ${j.rep_name} | ${j.service_type || '—'} | ${vehicle(j)} | ${j.customer_name}`)
    .join('\n');

  await post(url, `*📋 Gameplan — Huracan ${locationName} | ${dateLabel}*\n\n${bullets}`);
}

// job: { customer_name, service_type, vehicle_year, vehicle_make, vehicle_model, scheduled_at, rep_name, location_name }
async function notifyConfirmation(job) {
  const text = [
    `✅ *Appointment Confirmed*`,
    `Customer: ${job.customer_name}  |  Service: ${job.service_type || '—'}`,
    `Vehicle: ${vehicle(job)}`,
    `📅 ${fmtDate(job.scheduled_at)} at ${fmtTime(job.scheduled_at)}`,
    `Rep: ${job.rep_name} · Huracan ${job.location_name}`,
  ].join('\n');

  await post(HOOKS.confirmations, text);
}

// job: { customer_name, service_type, vehicle_year, vehicle_make, vehicle_model, revenue, rep_name, location_name }
async function notifyCheckout(job) {
  const text = [
    `🏁 *Job Checked Out*`,
    `Customer: ${job.customer_name}  |  Service: ${job.service_type || '—'}`,
    `Vehicle: ${vehicle(job)}`,
    `💰 Revenue: ${fmtCurrency(job.revenue)}`,
    `Rep: ${job.rep_name} · Huracan ${job.location_name}`,
  ].join('\n');

  await post(HOOKS.checkouts, text);
}

// invoice: { amount, status, customer_name, service_type, location_name }
async function notifyInvoice(invoice) {
  const text = [
    `🧾 *Invoice Created*`,
    `Customer: ${invoice.customer_name}  |  Service: ${invoice.service_type || '—'}`,
    `Amount: ${fmtCurrency(invoice.amount)}  |  Status: ${invoice.status}`,
    `Location: Huracan ${invoice.location_name}`,
  ].join('\n');

  await post(HOOKS.invoices, text);
}

// upsell: { service, price, rep_name, location_name }
async function notifyUpsell(upsell) {
  const text = [
    `💰 *Upsell Attempt*`,
    `Item: ${upsell.service}  |  ${fmtCurrency(upsell.price)}`,
    `Rep: ${upsell.rep_name} · Huracan ${upsell.location_name}`,
  ].join('\n');

  await post(HOOKS.upsells, text);
}

// summary: { filename, type, inserted, updated, errors, location_id }
async function notifyManagers(summary) {
  const errNote = summary.errors > 0 ? `  |  ⚠️ Errors: ${summary.errors}` : '';
  const loc     = summary.location_id ? `Location ID ${summary.location_id}` : 'All locations';

  const text = [
    `📊 *Import Complete — ${summary.filename}*`,
    `Type: ${summary.type}  |  Inserted: ${summary.inserted}  |  Updated: ${summary.updated}${errNote}`,
    `Filter: ${loc}`,
  ].join('\n');

  await post(HOOKS.managers, text);
}

module.exports = {
  notifyDailyGameplan,
  notifyConfirmation,
  notifyCheckout,
  notifyInvoice,
  notifyUpsell,
  notifyManagers,
};
