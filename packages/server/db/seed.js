const { getDb, initSchema } = require('./schema');

// ─── static data ─────────────────────────────────────────────────────────────

const LOCATIONS = [
  { name: 'Huracan Austin',     city: 'Austin',     address: '321 S Congress Ave, Austin, TX 78704',     phone: '512-555-0101' },
  { name: 'Huracan Frisco',     city: 'Frisco',     address: '456 Main St, Frisco, TX 75034',            phone: '214-555-0102' },
  { name: 'Huracan Roanoke',    city: 'Roanoke',    address: '100 Byron Nelson Blvd, Roanoke, TX 76262', phone: '817-555-0103' },
  { name: 'Huracan Houston',    city: 'Houston',    address: '789 Westheimer Rd, Houston, TX 77056',     phone: '713-555-0104' },
  { name: 'Huracan Fort Worth', city: 'Fort Worth', address: '500 W 7th St, Fort Worth, TX 76102',       phone: '817-555-0105' },
];

// location_id is resolved at runtime after locations are inserted (1-indexed by position above)
const REPS = [
  // Austin (loc 1)
  { location_id: 1, name: 'Jordan Tran',    email: 'jordan.tran@huracan.com',    phone: '512-555-1001', role: 'detailer' },
  { location_id: 1, name: 'Aaliyah Moss',   email: 'aaliyah.moss@huracan.com',   phone: '512-555-1002', role: 'detailer' },
  { location_id: 1, name: 'Marcus Webb',    email: 'marcus.webb@huracan.com',    phone: '512-555-1003', role: 'lead'     },
  // Frisco (loc 2)
  { location_id: 2, name: 'Carlos Ibarra',  email: 'carlos.ibarra@huracan.com',  phone: '214-555-2001', role: 'detailer' },
  { location_id: 2, name: 'Priya Nair',     email: 'priya.nair@huracan.com',     phone: '214-555-2002', role: 'detailer' },
  { location_id: 2, name: 'Devon Schultz',  email: 'devon.schultz@huracan.com',  phone: '214-555-2003', role: 'lead'     },
  { location_id: 2, name: 'Simone Dupree',  email: 'simone.dupree@huracan.com',  phone: '214-555-2004', role: 'detailer' },
  // Roanoke (loc 3)
  { location_id: 3, name: 'Kyle Ashworth',  email: 'kyle.ashworth@huracan.com',  phone: '817-555-3001', role: 'lead'     },
  { location_id: 3, name: 'Tina Okafor',    email: 'tina.okafor@huracan.com',    phone: '817-555-3002', role: 'detailer' },
  { location_id: 3, name: 'Ryan Castillo',  email: 'ryan.castillo@huracan.com',  phone: '817-555-3003', role: 'detailer' },
  // Houston (loc 4)
  { location_id: 4, name: 'Camille Fontenot', email: 'camille.fontenot@huracan.com', phone: '713-555-4001', role: 'lead'     },
  { location_id: 4, name: 'Diego Reyes',    email: 'diego.reyes@huracan.com',    phone: '713-555-4002', role: 'detailer' },
  { location_id: 4, name: 'Fatima Osei',    email: 'fatima.osei@huracan.com',    phone: '713-555-4003', role: 'detailer' },
  { location_id: 4, name: 'Ethan Broussard', email: 'ethan.broussard@huracan.com', phone: '713-555-4004', role: 'detailer' },
  // Fort Worth (loc 5)
  { location_id: 5, name: 'Nadia Petrov',   email: 'nadia.petrov@huracan.com',   phone: '817-555-5001', role: 'lead'     },
  { location_id: 5, name: 'Liam Okonkwo',   email: 'liam.okonkwo@huracan.com',   phone: '817-555-5002', role: 'detailer' },
  { location_id: 5, name: 'Sara Whitfield', email: 'sara.whitfield@huracan.com', phone: '817-555-5003', role: 'detailer' },
];

// daysAgo(n) is resolved at insert time via SQLite date()
// rep_key is "<location_id>:<rep name fragment>" resolved at runtime
const JOB_TEMPLATES = [
  // Austin
  { location_id: 1, rep_key: '1:Jordan',   customer_name: 'Tyler Brooke',    customer_phone: '512-444-0001', service_type: 'ceramic coating',   vehicle_year: '2023', vehicle_make: 'BMW',         vehicle_model: 'M4 Competition',  revenue: 1850, status: 'completed',  days_ago_sched: 28, days_ago_done: 27 },
  { location_id: 1, rep_key: '1:Aaliyah',  customer_name: 'Megan Torres',    customer_phone: '512-444-0002', service_type: 'window tint',        vehicle_year: '2022', vehicle_make: 'Audi',        vehicle_model: 'Q7',              revenue:  550, status: 'completed',  days_ago_sched: 20, days_ago_done: 20 },
  // Frisco
  { location_id: 2, rep_key: '2:Carlos',   customer_name: 'Raj Mehta',       customer_phone: '214-444-0003', service_type: 'PPF full front',     vehicle_year: '2024', vehicle_make: 'Porsche',     vehicle_model: '911 Carrera S',   revenue: 2200, status: 'completed',  days_ago_sched: 22, days_ago_done: 21 },
  { location_id: 2, rep_key: '2:Priya',    customer_name: 'Leila Hoffman',   customer_phone: '214-444-0004', service_type: 'paint correction',   vehicle_year: '2021', vehicle_make: 'Mercedes',    vehicle_model: 'C63 AMG',         revenue: 1400, status: 'completed',  days_ago_sched: 14, days_ago_done: 13 },
  { location_id: 2, rep_key: '2:Devon',    customer_name: 'Sam Nguyen',      customer_phone: '214-444-0005', service_type: 'PPF full car',       vehicle_year: '2023', vehicle_make: 'Lamborghini', vehicle_model: 'Urus',            revenue: 5800, status: 'in_progress', days_ago_sched: 1,  days_ago_done: null },
  // Roanoke
  { location_id: 3, rep_key: '3:Kyle',     customer_name: 'Chris Dalton',    customer_phone: '817-444-0006', service_type: 'full detail',        vehicle_year: '2022', vehicle_make: 'Land Rover',  vehicle_model: 'Defender 90',     revenue:  750, status: 'completed',  days_ago_sched: 18, days_ago_done: 18 },
  { location_id: 3, rep_key: '3:Tina',     customer_name: 'Amanda Pierce',   customer_phone: '817-444-0007', service_type: 'ceramic coating',    vehicle_year: '2024', vehicle_make: 'Tesla',       vehicle_model: 'Model S Plaid',   revenue: 1950, status: 'scheduled',  days_ago_sched: -3, days_ago_done: null },
  // Houston
  { location_id: 4, rep_key: '4:Camille',  customer_name: 'Jerome Wallace',  customer_phone: '713-444-0008', service_type: 'PPF full front',     vehicle_year: '2023', vehicle_make: 'Range Rover', vehicle_model: 'HSE',             revenue: 2400, status: 'completed',  days_ago_sched: 10, days_ago_done: 9  },
  { location_id: 4, rep_key: '4:Diego',    customer_name: 'Priscilla Avery', customer_phone: '713-444-0009', service_type: 'window tint',        vehicle_year: '2022', vehicle_make: 'Cadillac',    vehicle_model: 'Escalade',        revenue:  620, status: 'in_progress', days_ago_sched: 0,  days_ago_done: null },
  // Fort Worth
  { location_id: 5, rep_key: '5:Nadia',    customer_name: 'Brett Lawson',    customer_phone: '817-444-0010', service_type: 'paint correction',   vehicle_year: '2021', vehicle_make: 'Ferrari',     vehicle_model: 'F8 Tributo',      revenue: 2100, status: 'completed',  days_ago_sched: 7,  days_ago_done: 6  },
];

// Only created for completed jobs — keyed by job index in JOB_TEMPLATES (0-based)
const INVOICE_JOB_INDICES = [0, 1, 2, 3, 5, 7, 9]; // the completed jobs above

const UPSELL_TEMPLATES = [
  { job_idx: 0, rep_key: '1:Jordan',  service: 'ceramic coating maintenance kit', price: 89  },
  { job_idx: 2, rep_key: '2:Carlos',  service: 'glass coating add-on',            price: 250 },
  { job_idx: 9, rep_key: '5:Nadia',   service: 'engine bay detail',               price: 175 },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function daysAgo(n) {
  // n < 0 means days in the future (for scheduled jobs)
  return `datetime('now', '${-n} days')`;
}

// ─── seed ────────────────────────────────────────────────────────────────────

function seed() {
  const db = getDb();
  initSchema(db);

  // ── locations (skip entirely if any exist) ──────────────────────────────
  const locCount = db.prepare('SELECT COUNT(*) as n FROM locations').get().n;
  if (locCount === 0) {
    const insLoc = db.prepare(
      'INSERT INTO locations (name, city, address, phone) VALUES (@name, @city, @address, @phone)'
    );
    db.transaction(() => { for (const loc of LOCATIONS) insLoc.run(loc); })();
    console.log(`Seeded ${LOCATIONS.length} locations.`);
  } else {
    console.log(`Locations: ${locCount} already present, skipping.`);
  }

  // Build id lookup: location_id is position-based (row 1 = Austin, etc.)
  const locationRows = db.prepare('SELECT id, city FROM locations ORDER BY id').all();

  // ── reps (upsert by email) ──────────────────────────────────────────────
  const repCount = db.prepare('SELECT COUNT(*) as n FROM reps').get().n;
  if (repCount === 0) {
    const insRep = db.prepare(`
      INSERT INTO reps (location_id, name, email, phone, role)
      VALUES (@location_id, @name, @email, @phone, @role)
    `);
    db.transaction(() => { for (const rep of REPS) insRep.run(rep); })();
    console.log(`Seeded ${REPS.length} reps.`);
  } else {
    console.log(`Reps: ${repCount} already present, skipping.`);
  }

  // Build rep lookup: "location_id:name fragment" → id
  const repRows = db.prepare('SELECT id, location_id, name FROM reps').all();
  function repId(key) {
    const [locId, fragment] = key.split(':');
    const rep = repRows.find(
      (r) => r.location_id === parseInt(locId, 10) && r.name.includes(fragment)
    );
    if (!rep) throw new Error(`Rep not found for key "${key}"`);
    return rep.id;
  }

  // ── jobs (skip if any exist) ────────────────────────────────────────────
  const jobCount = db.prepare('SELECT COUNT(*) as n FROM jobs').get().n;
  if (jobCount === 0) {
    const insertedJobIds = [];

    db.transaction(() => {
      for (const t of JOB_TEMPLATES) {
        const schedExpr  = daysAgo(t.days_ago_sched);
        const doneExpr   = t.days_ago_done != null ? daysAgo(t.days_ago_done) : null;

        const result = db.prepare(`
          INSERT INTO jobs (
            location_id, rep_id, customer_name, customer_phone,
            service_type, vehicle_year, vehicle_make, vehicle_model,
            revenue, status, scheduled_at, completed_at
          ) VALUES (
            @location_id, @rep_id, @customer_name, @customer_phone,
            @service_type, @vehicle_year, @vehicle_make, @vehicle_model,
            @revenue, @status,
            ${schedExpr},
            ${doneExpr ?? 'NULL'}
          )
        `).run({
          location_id:    t.location_id,
          rep_id:         repId(t.rep_key),
          customer_name:  t.customer_name,
          customer_phone: t.customer_phone,
          service_type:   t.service_type,
          vehicle_year:   t.vehicle_year,
          vehicle_make:   t.vehicle_make,
          vehicle_model:  t.vehicle_model,
          revenue:        t.revenue,
          status:         t.status,
        });
        insertedJobIds.push(result.lastInsertRowid);
      }
    })();

    console.log(`Seeded ${JOB_TEMPLATES.length} jobs.`);

    // ── invoices (one per completed job) ─────────────────────────────────
    const insInv = db.prepare(`
      INSERT INTO invoices (job_id, location_id, amount, status, issued_at, paid_at)
      VALUES (@job_id, @location_id, @amount, 'paid',
              datetime('now', '-1 days'), datetime('now'))
    `);
    db.transaction(() => {
      for (const idx of INVOICE_JOB_INDICES) {
        const t = JOB_TEMPLATES[idx];
        insInv.run({
          job_id:      insertedJobIds[idx],
          location_id: t.location_id,
          amount:      t.revenue,
        });
      }
    })();
    console.log(`Seeded ${INVOICE_JOB_INDICES.length} invoices.`);

    // ── upsells ───────────────────────────────────────────────────────────
    const insUp = db.prepare(`
      INSERT INTO upsells (job_id, rep_id, location_id, service, price, sold_at, accepted)
      VALUES (@job_id, @rep_id, @location_id, @service, @price, datetime('now'), 1)
    `);
    db.transaction(() => {
      for (const u of UPSELL_TEMPLATES) {
        const t = JOB_TEMPLATES[u.job_idx];
        insUp.run({
          job_id:      insertedJobIds[u.job_idx],
          rep_id:      repId(u.rep_key),
          location_id: t.location_id,
          service:     u.service,
          price:       u.price,
        });
      }
    })();
    console.log(`Seeded ${UPSELL_TEMPLATES.length} upsells.`);

  } else {
    console.log(`Jobs: ${jobCount} already present, skipping invoices and upsells.`);
  }

  db.close();
}

seed();
