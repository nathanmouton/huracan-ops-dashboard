require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const db = require('./schema');

// ─── static data ─────────────────────────────────────────────────────────────

const LOCATIONS = [
  { name: 'Huracan Austin',     city: 'Austin',     address: '321 S Congress Ave, Austin, TX 78704',     phone: '512-555-0101' },
  { name: 'Huracan Frisco',     city: 'Frisco',     address: '456 Main St, Frisco, TX 75034',            phone: '214-555-0102' },
  { name: 'Huracan Roanoke',    city: 'Roanoke',    address: '100 Byron Nelson Blvd, Roanoke, TX 76262', phone: '817-555-0103' },
  { name: 'Huracan Houston',    city: 'Houston',    address: '789 Westheimer Rd, Houston, TX 77056',     phone: '713-555-0104' },
  { name: 'Huracan Fort Worth', city: 'Fort Worth', address: '500 W 7th St, Fort Worth, TX 76102',       phone: '817-555-0105' },
];

const REPS = [
  { location_id: 1, name: 'Jordan Tran',       email: 'jordan.tran@huracan.com',       phone: '512-555-1001', role: 'detailer' },
  { location_id: 1, name: 'Aaliyah Moss',      email: 'aaliyah.moss@huracan.com',      phone: '512-555-1002', role: 'detailer' },
  { location_id: 1, name: 'Marcus Webb',       email: 'marcus.webb@huracan.com',       phone: '512-555-1003', role: 'lead'     },
  { location_id: 2, name: 'Carlos Ibarra',     email: 'carlos.ibarra@huracan.com',     phone: '214-555-2001', role: 'detailer' },
  { location_id: 2, name: 'Priya Nair',        email: 'priya.nair@huracan.com',        phone: '214-555-2002', role: 'detailer' },
  { location_id: 2, name: 'Devon Schultz',     email: 'devon.schultz@huracan.com',     phone: '214-555-2003', role: 'lead'     },
  { location_id: 2, name: 'Simone Dupree',     email: 'simone.dupree@huracan.com',     phone: '214-555-2004', role: 'detailer' },
  { location_id: 3, name: 'Kyle Ashworth',     email: 'kyle.ashworth@huracan.com',     phone: '817-555-3001', role: 'lead'     },
  { location_id: 3, name: 'Tina Okafor',       email: 'tina.okafor@huracan.com',       phone: '817-555-3002', role: 'detailer' },
  { location_id: 3, name: 'Ryan Castillo',     email: 'ryan.castillo@huracan.com',     phone: '817-555-3003', role: 'detailer' },
  { location_id: 4, name: 'Camille Fontenot',  email: 'camille.fontenot@huracan.com',  phone: '713-555-4001', role: 'lead'     },
  { location_id: 4, name: 'Diego Reyes',       email: 'diego.reyes@huracan.com',       phone: '713-555-4002', role: 'detailer' },
  { location_id: 4, name: 'Fatima Osei',       email: 'fatima.osei@huracan.com',       phone: '713-555-4003', role: 'detailer' },
  { location_id: 4, name: 'Ethan Broussard',   email: 'ethan.broussard@huracan.com',   phone: '713-555-4004', role: 'detailer' },
  { location_id: 5, name: 'Nadia Petrov',      email: 'nadia.petrov@huracan.com',      phone: '817-555-5001', role: 'lead'     },
  { location_id: 5, name: 'Liam Okonkwo',      email: 'liam.okonkwo@huracan.com',      phone: '817-555-5002', role: 'detailer' },
  { location_id: 5, name: 'Sara Whitfield',    email: 'sara.whitfield@huracan.com',    phone: '817-555-5003', role: 'detailer' },
];

// Compute an ISO timestamp string for N days ago (negative = future)
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().replace('T', ' ').split('.')[0];
}

const JOB_TEMPLATES = [
  { location_id: 1, rep_key: '1:Jordan',   customer_name: 'Tyler Brooke',     service_type: 'ceramic coating', vehicle_year: '2023', vehicle_make: 'BMW',         vehicle_model: 'M4 Competition', revenue: 1850, status: 'completed',   days_sched: 28, days_done: 27 },
  { location_id: 1, rep_key: '1:Aaliyah',  customer_name: 'Megan Torres',     service_type: 'window tint',     vehicle_year: '2022', vehicle_make: 'Audi',        vehicle_model: 'Q7',             revenue:  550, status: 'completed',   days_sched: 20, days_done: 20 },
  { location_id: 2, rep_key: '2:Carlos',   customer_name: 'Raj Mehta',        service_type: 'PPF full front',  vehicle_year: '2024', vehicle_make: 'Porsche',     vehicle_model: '911 Carrera S',  revenue: 2200, status: 'completed',   days_sched: 22, days_done: 21 },
  { location_id: 2, rep_key: '2:Priya',    customer_name: 'Leila Hoffman',    service_type: 'paint correction',vehicle_year: '2021', vehicle_make: 'Mercedes',    vehicle_model: 'C63 AMG',        revenue: 1400, status: 'completed',   days_sched: 14, days_done: 13 },
  { location_id: 2, rep_key: '2:Devon',    customer_name: 'Sam Nguyen',       service_type: 'PPF full car',    vehicle_year: '2023', vehicle_make: 'Lamborghini', vehicle_model: 'Urus',           revenue: 5800, status: 'in_progress', days_sched:  1, days_done: null },
  { location_id: 3, rep_key: '3:Kyle',     customer_name: 'Chris Dalton',     service_type: 'full detail',     vehicle_year: '2022', vehicle_make: 'Land Rover',  vehicle_model: 'Defender 90',    revenue:  750, status: 'completed',   days_sched: 18, days_done: 18 },
  { location_id: 3, rep_key: '3:Tina',     customer_name: 'Amanda Pierce',    service_type: 'ceramic coating', vehicle_year: '2024', vehicle_make: 'Tesla',       vehicle_model: 'Model S Plaid',  revenue: 1950, status: 'scheduled',   days_sched: -3, days_done: null },
  { location_id: 4, rep_key: '4:Camille',  customer_name: 'Jerome Wallace',   service_type: 'PPF full front',  vehicle_year: '2023', vehicle_make: 'Range Rover', vehicle_model: 'HSE',            revenue: 2400, status: 'completed',   days_sched: 10, days_done:  9 },
  { location_id: 4, rep_key: '4:Diego',    customer_name: 'Priscilla Avery',  service_type: 'window tint',     vehicle_year: '2022', vehicle_make: 'Cadillac',    vehicle_model: 'Escalade',       revenue:  620, status: 'in_progress', days_sched:  0, days_done: null },
  { location_id: 5, rep_key: '5:Nadia',    customer_name: 'Brett Lawson',     service_type: 'paint correction',vehicle_year: '2021', vehicle_make: 'Ferrari',     vehicle_model: 'F8 Tributo',     revenue: 2100, status: 'completed',   days_sched:  7, days_done:  6 },
];

const INVOICE_JOB_INDICES = [0, 1, 2, 3, 5, 7, 9];

const UPSELL_TEMPLATES = [
  { job_idx: 0, rep_key: '1:Jordan', service: 'ceramic coating maintenance kit', price:  89 },
  { job_idx: 2, rep_key: '2:Carlos', service: 'glass coating add-on',            price: 250 },
  { job_idx: 9, rep_key: '5:Nadia',  service: 'engine bay detail',               price: 175 },
];

// ─── seed ────────────────────────────────────────────────────────────────────

async function seed() {
  await db.initSchema();

  // ── locations ──────────────────────────────────────────────────────────────
  const locCount = (await db.queryOne('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM locations')).n;
  if (locCount === 0) {
    for (const loc of LOCATIONS) {
      await db.run(
        'INSERT INTO locations (name, city, address, phone) VALUES (?, ?, ?, ?)',
        [loc.name, loc.city, loc.address, loc.phone]
      );
    }
    console.log(`Seeded ${LOCATIONS.length} locations.`);
  } else {
    console.log(`Locations: ${locCount} already present, skipping.`);
  }

  const locationRows = await db.query('SELECT id, city FROM locations ORDER BY id');

  // ── reps ───────────────────────────────────────────────────────────────────
  const repCount = (await db.queryOne('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM reps')).n;
  if (repCount === 0) {
    for (const rep of REPS) {
      await db.run(
        'INSERT INTO reps (location_id, name, email, phone, role) VALUES (?, ?, ?, ?, ?)',
        [rep.location_id, rep.name, rep.email, rep.phone, rep.role]
      );
    }
    console.log(`Seeded ${REPS.length} reps.`);
  } else {
    console.log(`Reps: ${repCount} already present, skipping.`);
  }

  const repRows = await db.query('SELECT id, location_id, name FROM reps');
  function repId(key) {
    const [locId, fragment] = key.split(':');
    const rep = repRows.find(
      (r) => r.location_id === parseInt(locId, 10) && r.name.includes(fragment)
    );
    if (!rep) throw new Error(`Rep not found for key "${key}"`);
    return rep.id;
  }

  // ── jobs ───────────────────────────────────────────────────────────────────
  const jobCount = (await db.queryOne('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM jobs')).n;
  if (jobCount === 0) {
    const insertedJobIds = [];

    for (const t of JOB_TEMPLATES) {
      const schedAt = daysAgo(t.days_sched);
      const doneAt  = t.days_done != null ? daysAgo(t.days_done) : null;
      const { lastId } = await db.run(
        `INSERT INTO jobs
           (location_id, rep_id, customer_name, service_type,
            vehicle_year, vehicle_make, vehicle_model,
            revenue, status, scheduled_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        [t.location_id, repId(t.rep_key), t.customer_name, t.service_type,
         t.vehicle_year, t.vehicle_make, t.vehicle_model,
         t.revenue, t.status, schedAt, doneAt]
      );
      insertedJobIds.push(lastId);
    }
    console.log(`Seeded ${JOB_TEMPLATES.length} jobs.`);

    // ── invoices ─────────────────────────────────────────────────────────────
    const yesterday = daysAgo(1);
    const now       = new Date().toISOString().replace('T', ' ').split('.')[0];
    for (const idx of INVOICE_JOB_INDICES) {
      const t = JOB_TEMPLATES[idx];
      await db.run(
        `INSERT INTO invoices (job_id, location_id, amount, status, issued_at, paid_at)
         VALUES (?, ?, ?, 'paid', ?, ?)`,
        [insertedJobIds[idx], t.location_id, t.revenue, yesterday, now]
      );
    }
    console.log(`Seeded ${INVOICE_JOB_INDICES.length} invoices.`);

    // ── upsells ───────────────────────────────────────────────────────────────
    for (const u of UPSELL_TEMPLATES) {
      const t = JOB_TEMPLATES[u.job_idx];
      await db.run(
        `INSERT INTO upsells (job_id, rep_id, location_id, service, price, sold_at, accepted)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [insertedJobIds[u.job_idx], repId(u.rep_key), t.location_id, u.service, u.price, now]
      );
    }
    console.log(`Seeded ${UPSELL_TEMPLATES.length} upsells.`);
  } else {
    console.log(`Jobs: ${jobCount} already present, skipping invoices and upsells.`);
  }

  console.log('Seed complete.');
  process.exit(0);
}

seed().catch((err) => { console.error('Seed failed:', err); process.exit(1); });
