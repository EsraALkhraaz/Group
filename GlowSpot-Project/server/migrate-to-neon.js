/* One-time data copy from the current DATABASE_URL (Render's free Postgres,
   which expires 30 days after creation) into NEON_DATABASE_URL (a permanent
   free Postgres). Runs automatically on boot when NEON_DATABASE_URL is set,
   and is idempotent: a marker row in the target's settings table makes every
   run after the first a no-op, so it's safe to leave the env var in place
   across restarts/redeploys during the cutover window. */
const { Pool } = require('pg');

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS centers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT, location TEXT, about TEXT,
    verified BOOLEAN DEFAULT false, rating REAL DEFAULT 0, status TEXT DEFAULT 'pending',
    departments JSONB DEFAULT '[]', username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    "paymentMethods" JSONB DEFAULT '{}', views INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS experts (
    id TEXT PRIMARY KEY, "centerId" TEXT NOT NULL, department TEXT, name TEXT NOT NULL,
    specialty TEXT, rating REAL DEFAULT 0, available BOOLEAN DEFAULT true,
    "homeService" BOOLEAN DEFAULT false, color TEXT, phone TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, "servicePrices" JSONB DEFAULT '{}',
    "serviceDurations" JSONB DEFAULT '{}', "workingHours" JSONB DEFAULT '{}',
    "leaveRequests" JSONB DEFAULT '[]', "clientNotes" JSONB DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, favorites JSONB DEFAULT '[]', "favoriteExperts" JSONB DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS packages (
    id TEXT PRIMARY KEY, "centerId" TEXT NOT NULL, name TEXT NOT NULL, items TEXT, price REAL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY, "centerId" TEXT NOT NULL, "centerName" TEXT, department TEXT, service TEXT,
    "expertId" TEXT, "expertName" TEXT, "customerId" TEXT, "customerName" TEXT, phone TEXT,
    date TEXT NOT NULL, time TEXT NOT NULL, duration INTEGER DEFAULT 60, price REAL,
    "commissionAmount" REAL, "netAmount" REAL, status TEXT DEFAULT 'pending',
    "serviceLocation" TEXT DEFAULT 'center', "homeAddress" TEXT, "declineReason" TEXT,
    alternatives JSONB DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY, "bookingId" TEXT, "centerId" TEXT, "expertId" TEXT, "customerId" TEXT,
    "customerName" TEXT, rating INTEGER, comment TEXT, "createdAt" TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT
  );
`;

const JSONB_COLUMNS = {
  centers: ['departments', 'paymentMethods'],
  experts: ['servicePrices', 'serviceDurations', 'workingHours', 'leaveRequests', 'clientNotes'],
  customers: ['favorites', 'favoriteExperts'],
  packages: [],
  bookings: ['alternatives'],
  reviews: [],
  settings: []
};
const PRIMARY_KEY = { centers: 'id', experts: 'id', customers: 'id', packages: 'id', bookings: 'id', reviews: 'id', settings: 'key' };

async function migrateToNeon() {
  const oldUrl = process.env.DATABASE_URL;
  const newUrl = process.env.NEON_DATABASE_URL;
  if (!newUrl || newUrl === oldUrl) return;

  const oldPool = new Pool({ connectionString: oldUrl, ssl: /localhost|127\.0\.0\.1/.test(oldUrl) ? false : { rejectUnauthorized: false } });
  const newPool = new Pool({ connectionString: newUrl, ssl: { rejectUnauthorized: false } });

  try {
    await newPool.query(SCHEMA_SQL);

    const marker = await newPool.query(`SELECT value FROM settings WHERE key = 'migratedFromRender'`);
    if (marker.rows[0]) {
      console.log('[migrate-to-neon] already migrated, skipping');
      return;
    }

    for (const table of Object.keys(JSONB_COLUMNS)) {
      const { rows } = await oldPool.query(`SELECT * FROM ${table}`);
      for (const row of rows) {
        const cols = Object.keys(row);
        const vals = cols.map((c) => (JSONB_COLUMNS[table].includes(c) ? JSON.stringify(row[c]) : row[c]));
        const placeholders = cols.map((_, i) => '$' + (i + 1)).join(',');
        const colList = cols.map((c) => `"${c}"`).join(',');
        const updateSet = cols.filter((c) => c !== PRIMARY_KEY[table]).map((c) => `"${c}"=EXCLUDED."${c}"`).join(',');
        await newPool.query(
          `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT (${PRIMARY_KEY[table]}) DO UPDATE SET ${updateSet}`,
          vals
        );
      }
      console.log(`[migrate-to-neon] ${table}: ${rows.length} rows migrated`);
    }

    await newPool.query(
      `INSERT INTO settings (key, value) VALUES ('migratedFromRender', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [new Date().toISOString()]
    );
    console.log('[migrate-to-neon] done');
  } finally {
    await oldPool.end();
    await newPool.end();
  }
}

module.exports = migrateToNeon;
