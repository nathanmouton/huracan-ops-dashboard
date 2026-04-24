const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'huracan.db');

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      city        TEXT NOT NULL,
      address     TEXT,
      phone       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reps (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      email       TEXT,
      phone       TEXT,
      role        TEXT NOT NULL DEFAULT 'detailer',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id      TEXT,
      location_id      INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      rep_id           INTEGER REFERENCES reps(id) ON DELETE SET NULL,
      customer_name    TEXT NOT NULL,
      customer_phone   TEXT,
      service_type     TEXT,
      vehicle          TEXT,
      vehicle_year     TEXT,
      vehicle_make     TEXT,
      vehicle_model    TEXT,
      revenue          REAL,
      status           TEXT NOT NULL DEFAULT 'scheduled'
                         CHECK(status IN ('scheduled','in_progress','completed','cancelled','no_show','incomplete')),
      scheduled_at     TEXT,
      completed_at     TEXT,
      notes            TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT,
      job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      amount      REAL NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','paid','void')),
      issued_at   TEXT,
      paid_at     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id      INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      rating      INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      body        TEXT,
      source      TEXT NOT NULL DEFAULT 'internal'
                    CHECK(source IN ('google','yelp','internal')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id       INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      product_name      TEXT NOT NULL,
      quantity          REAL NOT NULL DEFAULT 0,
      unit              TEXT NOT NULL DEFAULT 'oz',
      reorder_threshold REAL NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS upsells (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT,
      job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      rep_id      INTEGER REFERENCES reps(id) ON DELETE SET NULL,
      location_id INTEGER REFERENCES locations(id) ON DELETE CASCADE,
      service     TEXT NOT NULL,
      price       REAL NOT NULL DEFAULT 0,
      sold_at     TEXT,
      accepted    INTEGER NOT NULL DEFAULT 0 CHECK(accepted IN (0,1)),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rep_weekly_stats (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_name     TEXT NOT NULL,
      week_start   TEXT NOT NULL,
      week_end     TEXT,
      dials        INTEGER NOT NULL DEFAULT 0,
      texts        INTEGER NOT NULL DEFAULT 0,
      closes       INTEGER NOT NULL DEFAULT 0,
      revenue      REAL NOT NULL DEFAULT 0,
      lead_sources TEXT,
      locations    TEXT,
      synced_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(rep_name, week_start)
    );

    CREATE TABLE IF NOT EXISTS rep_closes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_name    TEXT NOT NULL,
      close_date  TEXT NOT NULL,
      revenue     REAL NOT NULL DEFAULT 0,
      lead_source TEXT,
      location    TEXT,
      synced_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rep_daily_activity (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      rep_name      TEXT NOT NULL,
      activity_date TEXT NOT NULL,
      dials         INTEGER NOT NULL DEFAULT 0,
      texts         INTEGER NOT NULL DEFAULT 0,
      synced_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(rep_name, activity_date)
    );
  `);

  runMigrations(db);
}

// Adds columns introduced in Phase 2 to existing databases.
// SQLite forbids ALTER TABLE ADD COLUMN with a UNIQUE constraint, so uniqueness
// is enforced via separate CREATE UNIQUE INDEX IF NOT EXISTS statements.
function runMigrations(db) {
  const columns = [
    "ALTER TABLE reps     ADD COLUMN external_id  TEXT",
    "ALTER TABLE jobs     ADD COLUMN external_id  TEXT",
    "ALTER TABLE jobs     ADD COLUMN service_type TEXT",
    "ALTER TABLE jobs     ADD COLUMN vehicle_year TEXT",
    "ALTER TABLE jobs     ADD COLUMN vehicle_make TEXT",
    "ALTER TABLE jobs     ADD COLUMN vehicle_model TEXT",
    "ALTER TABLE jobs     ADD COLUMN revenue       REAL",
    "ALTER TABLE invoices ADD COLUMN external_id  TEXT",
    "ALTER TABLE invoices ADD COLUMN issued_at    TEXT",
    "ALTER TABLE invoices ADD COLUMN paid_at      TEXT",
    "ALTER TABLE upsells  ADD COLUMN external_id  TEXT",
    "ALTER TABLE upsells  ADD COLUMN location_id  INTEGER REFERENCES locations(id)",
    "ALTER TABLE upsells  ADD COLUMN sold_at      TEXT",
  ];

  for (const sql of columns) {
    try {
      db.exec(sql);
    } catch (err) {
      if (!err.message.includes('duplicate column name')) throw err;
    }
  }

  // Expand jobs status CHECK to include no_show and incomplete if not already done.
  // SQLite doesn't support ALTER TABLE MODIFY — requires table recreation.
  const jobsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'").get();
  if (jobsSchema && !jobsSchema.sql.includes("'no_show'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE jobs_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id      TEXT,
        location_id      INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        rep_id           INTEGER REFERENCES reps(id) ON DELETE SET NULL,
        customer_name    TEXT NOT NULL,
        customer_phone   TEXT,
        service_type     TEXT,
        vehicle          TEXT,
        vehicle_year     TEXT,
        vehicle_make     TEXT,
        vehicle_model    TEXT,
        revenue          REAL,
        status           TEXT NOT NULL DEFAULT 'scheduled'
                           CHECK(status IN ('scheduled','in_progress','completed','cancelled','no_show','incomplete')),
        scheduled_at     TEXT,
        completed_at     TEXT,
        notes            TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO jobs_new SELECT * FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_new RENAME TO jobs;
    `);
    db.pragma('foreign_keys = ON');
  }

  // Plain unique indexes (no WHERE) — required for ON CONFLICT(external_id) upsert syntax.
  // SQLite treats NULLs as distinct in unique indexes so multiple null external_ids are fine.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reps_external_id     ON reps(external_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_external_id     ON jobs(external_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_external_id ON invoices(external_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_upsells_external_id  ON upsells(external_id);
  `);
}

module.exports = { getDb, initSchema };
