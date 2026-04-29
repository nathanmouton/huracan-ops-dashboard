'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const USE_PG = !!process.env.DATABASE_URL;

// ─── PostgreSQL setup ─────────────────────────────────────────────────────────

let pgPool;
if (USE_PG) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
    max: 10,
  });
  pgPool.on('error', (err) => console.error('[pg] idle client error', err.message));
}

// ─── SQLite setup ─────────────────────────────────────────────────────────────

let sqliteDb;
if (!USE_PG) {
  const Database = require('better-sqlite3');
  const path = require('path');
  const DB_PATH = path.join(__dirname, '..', 'data', 'huracan.db');
  sqliteDb = new Database(DB_PATH);
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// Convert ? placeholders to $1, $2, … for PG
function toPg(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

// PG returns COUNT(*) as bigint string; coerce obvious numeric strings to numbers.
function coerce(rows) {
  if (!USE_PG) return rows;
  return rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = (typeof v === 'string' && v !== '' && !isNaN(Number(v))) ? Number(v) : v;
    }
    return out;
  });
}

// ─── public interface ─────────────────────────────────────────────────────────

// Returns an array of rows (always async).
async function query(sql, params = []) {
  if (USE_PG) {
    const res = await pgPool.query(toPg(sql), params);
    return coerce(res.rows);
  }
  return sqliteDb.prepare(sql).all(params);
}

// Returns the first row or null.
async function queryOne(sql, params = []) {
  if (USE_PG) {
    const res = await pgPool.query(toPg(sql), params);
    return coerce(res.rows)[0] ?? null;
  }
  return sqliteDb.prepare(sql).get(params) ?? null;
}

// INSERT / UPDATE / DELETE — returns { lastId } for inserts that need the new id.
// Supports RETURNING id in both dialects: PG returns it naturally; SQLite uses .get().
async function run(sql, params = []) {
  if (USE_PG) {
    const res = await pgPool.query(toPg(sql), params);
    return { lastId: res.rows[0]?.id ?? null };
  }
  if (/\bRETURNING\b/i.test(sql)) {
    const row = sqliteDb.prepare(sql).get(params);
    return { lastId: row?.id ?? null };
  }
  const info = sqliteDb.prepare(sql).run(params);
  return { lastId: info.lastInsertRowid ?? null };
}

// Wraps a block of queries in a DB transaction.
// The callback receives a `tx` object with the same query/queryOne/run interface.
// In PG, all tx.* calls use the same dedicated client connection.
// In SQLite, we run sequentially (no explicit SQLite transaction wrapper needed
// since local dev is single-writer; the WAL journal provides crash safety).
async function transaction(fn) {
  if (USE_PG) {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const tx = {
        query:    async (sql, p = []) => coerce((await client.query(toPg(sql), p)).rows),
        queryOne: async (sql, p = []) => (coerce((await client.query(toPg(sql), p)).rows))[0] ?? null,
        run:      async (sql, p = []) => {
          const res = await client.query(toPg(sql), p);
          return { lastId: res.rows[0]?.id ?? null };
        },
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else {
    const tx = {
      query:    async (sql, p = []) => sqliteDb.prepare(sql).all(p),
      queryOne: async (sql, p = []) => sqliteDb.prepare(sql).get(p) ?? null,
      run:      async (sql, p = []) => {
        const info = sqliteDb.prepare(sql).run(p);
        return { lastId: info.lastInsertRowid ?? null };
      },
    };
    return fn(tx);
  }
}

// ─── schema DDL ───────────────────────────────────────────────────────────────

// PG schema — uses SERIAL, CURRENT_TIMESTAMP, inline UNIQUE constraints.
// All tables created with IF NOT EXISTS so initSchema is safe to call on every startup.
const PG_DDL = `
  CREATE TABLE IF NOT EXISTS locations (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    city       TEXT NOT NULL,
    address    TEXT,
    phone      TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reps (
    id          SERIAL PRIMARY KEY,
    external_id TEXT UNIQUE,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    email       TEXT,
    phone       TEXT,
    role        TEXT NOT NULL DEFAULT 'detailer',
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id            SERIAL PRIMARY KEY,
    external_id   TEXT UNIQUE,
    location_id   INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    rep_id        INTEGER REFERENCES reps(id) ON DELETE SET NULL,
    customer_name TEXT NOT NULL,
    customer_phone TEXT,
    service_type  TEXT,
    vehicle       TEXT,
    vehicle_year  TEXT,
    vehicle_make  TEXT,
    vehicle_model TEXT,
    revenue       REAL,
    status        TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK(status IN ('scheduled','in_progress','completed','cancelled','no_show','incomplete')),
    scheduled_at  TEXT,
    completed_at  TEXT,
    notes         TEXT,
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id          SERIAL PRIMARY KEY,
    external_id TEXT UNIQUE,
    job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    amount      REAL NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','paid','void')),
    issued_at   TEXT,
    paid_at     TEXT,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id          SERIAL PRIMARY KEY,
    job_id      INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    rating      INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    body        TEXT,
    source      TEXT NOT NULL DEFAULT 'internal'
                  CHECK(source IN ('google','yelp','internal')),
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS inventory (
    id                SERIAL PRIMARY KEY,
    location_id       INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    product_name      TEXT NOT NULL,
    quantity          REAL NOT NULL DEFAULT 0,
    unit              TEXT NOT NULL DEFAULT 'oz',
    reorder_threshold REAL NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS upsells (
    id          SERIAL PRIMARY KEY,
    external_id TEXT UNIQUE,
    job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    rep_id      INTEGER REFERENCES reps(id) ON DELETE SET NULL,
    location_id INTEGER REFERENCES locations(id) ON DELETE CASCADE,
    service     TEXT NOT NULL,
    price       REAL NOT NULL DEFAULT 0,
    sold_at     TEXT,
    accepted    INTEGER NOT NULL DEFAULT 0 CHECK(accepted IN (0,1)),
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rep_weekly_stats (
    id           SERIAL PRIMARY KEY,
    rep_name     TEXT NOT NULL,
    week_start   TEXT NOT NULL,
    week_end     TEXT,
    dials        INTEGER NOT NULL DEFAULT 0,
    texts        INTEGER NOT NULL DEFAULT 0,
    closes       INTEGER NOT NULL DEFAULT 0,
    revenue      REAL NOT NULL DEFAULT 0,
    lead_sources TEXT,
    locations    TEXT,
    synced_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(rep_name, week_start)
  );

  CREATE TABLE IF NOT EXISTS rep_closes (
    id          SERIAL PRIMARY KEY,
    rep_name    TEXT NOT NULL,
    close_date  TEXT NOT NULL,
    revenue     REAL NOT NULL DEFAULT 0,
    lead_source TEXT,
    location    TEXT,
    synced_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rep_daily_activity (
    id            SERIAL PRIMARY KEY,
    rep_name      TEXT NOT NULL,
    activity_date TEXT NOT NULL,
    dials         INTEGER NOT NULL DEFAULT 0,
    texts         INTEGER NOT NULL DEFAULT 0,
    synced_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(rep_name, activity_date)
  );
`;

async function initSchema() {
  if (USE_PG) {
    await pgPool.query(PG_DDL);
    console.log('[db] PostgreSQL schema ready');
  } else {
    sqliteDb.exec(`
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

    // Add columns introduced after initial schema (safe no-ops on fresh DBs).
    const addColumns = [
      "ALTER TABLE reps     ADD COLUMN external_id   TEXT",
      "ALTER TABLE jobs     ADD COLUMN external_id   TEXT",
      "ALTER TABLE jobs     ADD COLUMN service_type  TEXT",
      "ALTER TABLE jobs     ADD COLUMN vehicle_year  TEXT",
      "ALTER TABLE jobs     ADD COLUMN vehicle_make  TEXT",
      "ALTER TABLE jobs     ADD COLUMN vehicle_model TEXT",
      "ALTER TABLE jobs     ADD COLUMN revenue       REAL",
      "ALTER TABLE invoices ADD COLUMN external_id   TEXT",
      "ALTER TABLE invoices ADD COLUMN issued_at     TEXT",
      "ALTER TABLE invoices ADD COLUMN paid_at       TEXT",
      "ALTER TABLE upsells  ADD COLUMN external_id   TEXT",
      "ALTER TABLE upsells  ADD COLUMN location_id   INTEGER REFERENCES locations(id)",
      "ALTER TABLE upsells  ADD COLUMN sold_at       TEXT",
    ];
    for (const sql of addColumns) {
      try { sqliteDb.exec(sql); } catch (e) {
        if (!e.message.includes('duplicate column name')) throw e;
      }
    }

    // Expand jobs.status CHECK to include no_show / incomplete.
    const jobsSchema = sqliteDb.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'"
    ).get();
    if (jobsSchema && !jobsSchema.sql.includes("'no_show'")) {
      sqliteDb.pragma('foreign_keys = OFF');
      sqliteDb.exec(`
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
      sqliteDb.pragma('foreign_keys = ON');
    }

    sqliteDb.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reps_external_id     ON reps(external_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_external_id     ON jobs(external_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_external_id ON invoices(external_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_upsells_external_id  ON upsells(external_id);
    `);

    console.log('[db] SQLite schema ready');
  }
}

module.exports = { query, queryOne, run, transaction, initSchema };
