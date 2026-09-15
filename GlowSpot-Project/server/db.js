const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const connectionString = process.env.DATABASE_URL;
const isLocal = !connectionString || /localhost|127\.0\.0\.1/.test(connectionString);
const pool = new Pool(
  connectionString
    ? { connectionString, ssl: isLocal ? false : { rejectUnauthorized: false } }
    : undefined // falls back to PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT env vars
);

const db = {
  query: (text, params) => pool.query(text, params)
};

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS centers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT,
      location TEXT,
      about TEXT,
      verified BOOLEAN DEFAULT false,
      rating REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      departments JSONB DEFAULT '[]',
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      "paymentMethods" JSONB DEFAULT '{}',
      views INTEGER DEFAULT 0,
      gallery JSONB DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS experts (
      id TEXT PRIMARY KEY,
      "centerId" TEXT NOT NULL,
      department TEXT,
      name TEXT NOT NULL,
      specialty TEXT,
      rating REAL DEFAULT 0,
      available BOOLEAN DEFAULT true,
      "homeService" BOOLEAN DEFAULT false,
      color TEXT,
      phone TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      "servicePrices" JSONB DEFAULT '{}',
      "serviceDurations" JSONB DEFAULT '{}',
      "workingHours" JSONB DEFAULT '{}',
      "leaveRequests" JSONB DEFAULT '[]',
      "clientNotes" JSONB DEFAULT '{}',
      portfolio JSONB DEFAULT '{}',
      "pushSubscriptions" JSONB DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      favorites JSONB DEFAULT '[]',
      "favoriteExperts" JSONB DEFAULT '[]',
      address TEXT,
      "pushSubscriptions" JSONB DEFAULT '[]',
      "walletPoints" INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS packages (
      id TEXT PRIMARY KEY,
      "centerId" TEXT NOT NULL,
      name TEXT NOT NULL,
      items TEXT,
      price REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      "centerId" TEXT NOT NULL,
      "centerName" TEXT,
      department TEXT,
      service TEXT,
      "expertId" TEXT,
      "expertName" TEXT,
      "customerId" TEXT,
      "customerName" TEXT,
      phone TEXT,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      duration INTEGER DEFAULT 60,
      price REAL,
      "commissionAmount" REAL,
      "netAmount" REAL,
      status TEXT DEFAULT 'pending',
      "serviceLocation" TEXT DEFAULT 'center',
      "homeAddress" TEXT,
      "declineReason" TEXT,
      alternatives JSONB DEFAULT '[]',
      "rebookReminderSentAt" TEXT,
      "originalPrice" REAL,
      "walletPointsRedeemed" INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      "bookingId" TEXT,
      "centerId" TEXT,
      "expertId" TEXT,
      "customerId" TEXT,
      "customerName" TEXT,
      rating INTEGER,
      "expertRating" INTEGER,
      "qualityRating" INTEGER,
      "punctualityRating" INTEGER,
      "treatmentRating" INTEGER,
      "resultRating" INTEGER,
      comment TEXT,
      "createdAt" TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY,
      "centerId" TEXT NOT NULL,
      "centerName" TEXT,
      department TEXT NOT NULL,
      service TEXT NOT NULL,
      "discountPercent" INTEGER NOT NULL,
      note TEXT,
      "expiresAt" TEXT,
      "createdAt" TEXT
    );
  `);

  // Home service moved from a center-wide flag to a per-expert one — each
  // expert now decides individually whether she does home visits, rather
  // than it being an all-or-nothing setting for the whole center. These are
  // idempotent so they're safe to run against an already-seeded database
  // (e.g. the live deploy) as well as a brand new one.
  await pool.query('ALTER TABLE experts ADD COLUMN IF NOT EXISTS "homeService" BOOLEAN DEFAULT false');
  await pool.query('ALTER TABLE centers DROP COLUMN IF EXISTS "homeService"');

  // Commission tracking: added after bookings already existed live, so these
  // columns need an explicit migration too (fresh installs already get them
  // from the CREATE TABLE above — this is a no-op there).
  await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS "commissionAmount" REAL');
  await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS "netAmount" REAL');

  // Default commission rate (10%) — only inserted if not already set, so an
  // admin's later change via PATCH /api/settings is never clobbered by a
  // redeploy.
  await pool.query(`INSERT INTO settings (key, value) VALUES ('commissionRate', '0.10') ON CONFLICT (key) DO NOTHING`);

  // Photo galleries: centers get a flat list, experts get named categories
  // (e.g. "قص" / "صبغة") each holding their own photo list — added after
  // both tables already existed live.
  await pool.query(`ALTER TABLE centers ADD COLUMN IF NOT EXISTS gallery JSONB DEFAULT '[]'`);
  await pool.query(`ALTER TABLE experts ADD COLUMN IF NOT EXISTS portfolio JSONB DEFAULT '{}'`);

  // Saved home address — lets the booking sheet pre-fill the home-service
  // address field instead of the customer retyping it every time.
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS address TEXT`);

  // Email notifications were tried and then dropped in favor of in-app
  // polling notifications (no external service needed) — drop the column
  // from any database that already picked it up.
  await pool.query(`ALTER TABLE customers DROP COLUMN IF EXISTS email`);
  await pool.query(`ALTER TABLE experts DROP COLUMN IF EXISTS email`);

  // Real phone-level push notifications (Web Push) — replaces in-tab-only
  // polling. Each row can hold multiple subscriptions (one per browser/device).
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS "pushSubscriptions" JSONB DEFAULT '[]'`);
  await pool.query(`ALTER TABLE experts ADD COLUMN IF NOT EXISTS "pushSubscriptions" JSONB DEFAULT '[]'`);

  // Detailed reviews: a single overall star was replaced with five separate
  // criteria (expert/quality/punctuality/treatment/result); `rating` is now
  // the derived average, kept so existing center/expert rating math still works.
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS "expertRating" INTEGER`);
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS "qualityRating" INTEGER`);
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS "punctualityRating" INTEGER`);
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS "treatmentRating" INTEGER`);
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS "resultRating" INTEGER`);

  // Rebooking reminders: marks a completed booking once its "time for your
  // next appointment" push has gone out, so the periodic scan never re-sends it.
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS "rebookReminderSentAt" TEXT`);

  // Loyalty wallet + center-run offers: a booking's price can now be reduced
  // by a center's own service discount and/or redeemed wallet points —
  // originalPrice keeps the pre-discount amount for display, and
  // walletPointsRedeemed is refunded automatically if the booking falls through.
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS "walletPoints" INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS "originalPrice" REAL`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS "walletPointsRedeemed" INTEGER DEFAULT 0`);
}

function uid(prefix) {
  return (prefix ? prefix + '_' : '') + crypto.randomBytes(9).toString('hex');
}

/* ---------------- public-shape helpers ----------------
   JSONB columns already come back as parsed JS objects/arrays (pg's default
   type parsers do this), and BOOLEAN columns come back as real booleans —
   no manual JSON.parse or !! coercion needed here, unlike the old SQLite
   version. The only job left is stripping password_hash. */
function centerPublic(row) {
  if (!row) return null;
  const c = Object.assign({}, row);
  delete c.password_hash;
  return c;
}
function expertPublic(row) {
  if (!row) return null;
  const e = Object.assign({}, row);
  delete e.password_hash;
  return e;
}
function customerPublic(row) {
  if (!row) return null;
  const c = Object.assign({}, row);
  delete c.password_hash;
  return c;
}
function bookingPublic(row) {
  return row || null;
}
function bookingBusyView(row) {
  return { expertId: row.expertId, date: row.date, time: row.time, duration: row.duration, status: row.status };
}

async function queryOne(sql, params) {
  const r = await pool.query(sql, params);
  return r.rows[0] || null;
}
async function queryAll(sql, params) {
  const r = await pool.query(sql, params);
  return r.rows;
}

/* node-postgres serializes a plain JS array as a Postgres ARRAY literal
   ("{a,b}"), not JSON — invalid input for a jsonb column. Objects happen to
   come out as JSON text either way, but stringifying explicitly here makes
   every JSONB write unambiguous regardless of value shape. Reads need no
   symmetric JSON.parse: pg's default type parser already does that for
   json/jsonb columns. */
function j(v) { return JSON.stringify(v); }

/* ---------------- generic CRUD (async — every method returns a Promise) ---------------- */
const centersStmt = {
  all: { all: () => queryAll('SELECT * FROM centers') },
  byId: { get: (id) => queryOne('SELECT * FROM centers WHERE id = $1', [id]) },
  byUsername: { get: (username) => queryOne('SELECT * FROM centers WHERE username = $1', [username]) },
  insert: {
    run: (c) => pool.query(
      `INSERT INTO centers (id,name,city,location,about,verified,rating,status,departments,username,password_hash,"paymentMethods",views,gallery)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [c.id, c.name, c.city, c.location, c.about, c.verified, c.rating, c.status, j(c.departments), c.username, c.password_hash, j(c.paymentMethods), c.views, j(c.gallery || [])]
    )
  },
  updateStatus: { run: (status, id) => pool.query('UPDATE centers SET status=$1 WHERE id=$2', [status, id]) },
  updatePassword: { run: (passwordHash, id) => pool.query('UPDATE centers SET password_hash=$1 WHERE id=$2', [passwordHash, id]) },
  delete: { run: (id) => pool.query('DELETE FROM centers WHERE id=$1', [id]) },
  updateRating: { run: (rating, id) => pool.query('UPDATE centers SET rating=$1 WHERE id=$2', [rating, id]) },
  incrementViews: { run: (id) => pool.query('UPDATE centers SET views = views + 1 WHERE id=$1', [id]) }
};

const expertsStmt = {
  all: { all: () => queryAll('SELECT * FROM experts') },
  byId: { get: (id) => queryOne('SELECT * FROM experts WHERE id = $1', [id]) },
  byPhone: { get: (phone) => queryOne('SELECT * FROM experts WHERE phone = $1', [phone]) },
  byCenter: { all: (centerId) => queryAll('SELECT * FROM experts WHERE "centerId" = $1', [centerId]) },
  insert: {
    run: (e) => pool.query(
      `INSERT INTO experts (id,"centerId",department,name,specialty,rating,available,"homeService",color,phone,password_hash,"servicePrices","serviceDurations","workingHours","leaveRequests","clientNotes",portfolio)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [e.id, e.centerId, e.department, e.name, e.specialty, e.rating, e.available, e.homeService, e.color, e.phone, e.password_hash, j(e.servicePrices), j(e.serviceDurations), j(e.workingHours), j(e.leaveRequests), j(e.clientNotes), j(e.portfolio || {})]
    )
  },
  delete: { run: (id) => pool.query('DELETE FROM experts WHERE id=$1', [id]) },
  updateRating: { run: (rating, id) => pool.query('UPDATE experts SET rating=$1 WHERE id=$2', [rating, id]) },
  updatePassword: { run: (passwordHash, id) => pool.query('UPDATE experts SET password_hash=$1 WHERE id=$2', [passwordHash, id]) },
  updatePushSubscriptions: { run: (subs, id) => pool.query('UPDATE experts SET "pushSubscriptions"=$1 WHERE id=$2', [j(subs), id]) }
};

const customersStmt = {
  all: { all: () => queryAll('SELECT * FROM customers') },
  byId: { get: (id) => queryOne('SELECT * FROM customers WHERE id = $1', [id]) },
  byPhone: { get: (phone) => queryOne('SELECT * FROM customers WHERE phone = $1', [phone]) },
  insert: {
    run: (c) => pool.query(
      'INSERT INTO customers (id,name,phone,password_hash,favorites,"favoriteExperts") VALUES ($1,$2,$3,$4,$5,$6)',
      [c.id, c.name, c.phone, c.password_hash, j(c.favorites), j(c.favoriteExperts)]
    )
  },
  updatePassword: { run: (passwordHash, id) => pool.query('UPDATE customers SET password_hash=$1 WHERE id=$2', [passwordHash, id]) },
  updatePushSubscriptions: { run: (subs, id) => pool.query('UPDATE customers SET "pushSubscriptions"=$1 WHERE id=$2', [j(subs), id]) },
  byFavoriteExpert: { all: (expertId) => queryAll('SELECT * FROM customers WHERE "favoriteExperts" @> $1::jsonb', [j([expertId])]) },
  updateWalletPoints: { run: (points, id) => pool.query('UPDATE customers SET "walletPoints"=$1 WHERE id=$2', [points, id]) }
};

const packagesStmt = {
  all: { all: () => queryAll('SELECT * FROM packages') },
  byId: { get: (id) => queryOne('SELECT * FROM packages WHERE id = $1', [id]) },
  byCenter: { all: (centerId) => queryAll('SELECT * FROM packages WHERE "centerId" = $1', [centerId]) },
  insert: {
    run: (p) => pool.query(
      'INSERT INTO packages (id,"centerId",name,items,price) VALUES ($1,$2,$3,$4,$5)',
      [p.id, p.centerId, p.name, p.items, p.price]
    )
  },
  delete: { run: (id) => pool.query('DELETE FROM packages WHERE id=$1', [id]) }
};

const bookingsStmt = {
  all: { all: () => queryAll('SELECT * FROM bookings') },
  byId: { get: (id) => queryOne('SELECT * FROM bookings WHERE id = $1', [id]) },
  byCustomer: { all: (customerId) => queryAll('SELECT * FROM bookings WHERE "customerId" = $1', [customerId]) },
  byExpert: { all: (expertId) => queryAll('SELECT * FROM bookings WHERE "expertId" = $1', [expertId]) },
  byCenter: { all: (centerId) => queryAll('SELECT * FROM bookings WHERE "centerId" = $1', [centerId]) },
  activeByExpertDate: {
    all: (expertId, date) => queryAll(
      `SELECT * FROM bookings WHERE "expertId" = $1 AND date = $2 AND status NOT IN ('cancelled','declined')`,
      [expertId, date]
    )
  },
  insert: {
    run: (b) => pool.query(
      `INSERT INTO bookings (id,"centerId","centerName",department,service,"expertId","expertName","customerId","customerName",phone,date,time,duration,price,"commissionAmount","netAmount",status,"serviceLocation","homeAddress","declineReason",alternatives,"originalPrice","walletPointsRedeemed")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [b.id, b.centerId, b.centerName, b.department, b.service, b.expertId, b.expertName, b.customerId, b.customerName, b.phone, b.date, b.time, b.duration, b.price, b.commissionAmount, b.netAmount, b.status, b.serviceLocation, b.homeAddress, b.declineReason, j(b.alternatives), b.originalPrice != null ? b.originalPrice : null, b.walletPointsRedeemed || 0]
    )
  },
  /* Repeat customers of an expert — used to build the waitlist notified when
     one of her confirmed slots frees up unexpectedly. */
  priorCustomerIdsOfExpert: {
    all: (expertId) => queryAll(
      `SELECT DISTINCT "customerId" FROM bookings WHERE "expertId" = $1 AND status NOT IN ('pending','cancelled','declined')`,
      [expertId]
    )
  },
  /* Completed appointments 3-4 weeks old with no rebooking reminder sent yet
     and no later booking already made with the same expert. */
  dueForRebookReminder: {
    all: () => queryAll(`
      SELECT * FROM bookings b
      WHERE b.status = 'completed'
        AND b."expertId" IS NOT NULL
        AND b."rebookReminderSentAt" IS NULL
        AND b.date::date <= (CURRENT_DATE - INTERVAL '21 days')
        AND b.date::date >= (CURRENT_DATE - INTERVAL '28 days')
        AND NOT EXISTS (
          SELECT 1 FROM bookings b2
          WHERE b2."customerId" = b."customerId" AND b2."expertId" = b."expertId"
            AND b2.date::date > b.date::date
        )
    `)
  },
  markRebookReminderSent: { run: (id) => pool.query('UPDATE bookings SET "rebookReminderSentAt"=$1 WHERE id=$2', [new Date().toISOString(), id]) }
};

const settingsStmt = {
  get: (key) => queryOne('SELECT * FROM settings WHERE key = $1', [key]),
  set: (key, value) => pool.query(
    'INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value]
  )
};

const reviewsStmt = {
  all: { all: () => queryAll('SELECT * FROM reviews') },
  byBooking: { all: (bookingId) => queryAll('SELECT * FROM reviews WHERE "bookingId" = $1', [bookingId]) },
  byCenter: { all: (centerId) => queryAll('SELECT * FROM reviews WHERE "centerId" = $1', [centerId]) },
  byExpert: { all: (expertId) => queryAll('SELECT * FROM reviews WHERE "expertId" = $1', [expertId]) },
  insert: {
    run: (r) => pool.query(
      `INSERT INTO reviews (id,"bookingId","centerId","expertId","customerId","customerName",rating,"expertRating","qualityRating","punctualityRating","treatmentRating","resultRating",comment,"createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [r.id, r.bookingId, r.centerId, r.expertId, r.customerId, r.customerName, r.rating, r.expertRating, r.qualityRating, r.punctualityRating, r.treatmentRating, r.resultRating, r.comment, r.createdAt]
    )
  }
};

const offersStmt = {
  byId: { get: (id) => queryOne('SELECT * FROM offers WHERE id = $1', [id]) },
  byCenter: { all: (centerId) => queryAll('SELECT * FROM offers WHERE "centerId" = $1 ORDER BY "createdAt" DESC', [centerId]) },
  /* Customer-facing list: only offers that haven't expired. */
  active: { all: () => queryAll(`SELECT * FROM offers WHERE "expiresAt" IS NULL OR "expiresAt"::date >= CURRENT_DATE ORDER BY "createdAt" DESC`) },
  /* The one offer (if any) that currently applies to a given center+department+service, used to price a booking. */
  activeFor: {
    get: (centerId, department, service) => queryOne(
      `SELECT * FROM offers WHERE "centerId" = $1 AND department = $2 AND service = $3
       AND ("expiresAt" IS NULL OR "expiresAt"::date >= CURRENT_DATE)
       ORDER BY "createdAt" DESC LIMIT 1`,
      [centerId, department, service]
    )
  },
  insert: {
    run: (o) => pool.query(
      `INSERT INTO offers (id,"centerId","centerName",department,service,"discountPercent",note,"expiresAt","createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [o.id, o.centerId, o.centerName, o.department, o.service, o.discountPercent, o.note, o.expiresAt, o.createdAt]
    )
  },
  delete: { run: (id) => pool.query('DELETE FROM offers WHERE id=$1', [id]) }
};

/* ---------------- seed (mirrors the front-end demo data) ---------------- */
async function seed() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM centers');
  if (rows[0].n > 0) return;

  const centers = [
    { id: 'c1', name: 'Glow Beauty Center', city: 'بنغازي', location: 'الفويهات', about: 'مركز متكامل للعناية بالشعر والمكياج والأظافر والسبا في أجواء مريحة وخاصة.', verified: true, rating: 4.8, status: 'approved', departments: ['hair', 'makeup', 'nails', 'henna', 'spa'], username: 'glowbeauty', password_hash: bcrypt.hashSync('center123', 10), paymentMethods: {}, views: 0 },
    { id: 'c2', name: 'Royal Beauty Center', city: 'بنغازي', location: 'بن عاشور', about: 'خبرات معتمدة في الشعر والعناية بالبشرة والحمام المغربي.', verified: true, rating: 4.6, status: 'approved', departments: ['hair', 'beauty', 'steam'], username: 'royalbeauty', password_hash: bcrypt.hashSync('center123', 10), paymentMethods: {}, views: 0 },
    { id: 'c3', name: 'Luna Spa', city: 'طرابلس', location: 'حي الأندلس', about: 'وجهتك للاسترخاء: سبا وحمام بخار وعناية كاملة بالجسم.', verified: false, rating: 4.7, status: 'approved', departments: ['spa', 'steam', 'beauty', 'cupping'], username: 'lunaspa', password_hash: bcrypt.hashSync('center123', 10), paymentMethods: {}, views: 0 }
  ];
  for (const c of centers) await centersStmt.insert.run(c);

  const COLORS = ['#6B1F35', '#C98CA7', '#C9A227', '#8C5B70', '#9B3B49', '#4E1526'];
  const expertHash = bcrypt.hashSync('expert123', 10);
  const experts = [
    { id: 'e1', centerId: 'c1', department: 'hair', name: 'سارة', specialty: 'تصفيف وصبغة الشعر', rating: 4.9, available: true, homeService: true, color: COLORS[0], phone: '0920000001', password_hash: expertHash, servicePrices: {}, serviceDurations: {}, workingHours: {}, leaveRequests: [], clientNotes: {} },
    { id: 'e2', centerId: 'c1', department: 'makeup', name: 'مايا', specialty: 'مكياج سهرة وعرايس', rating: 4.8, available: false, homeService: false, color: COLORS[1], phone: '0920000002', password_hash: expertHash, servicePrices: {}, serviceDurations: {}, workingHours: {}, leaveRequests: [], clientNotes: {} },
    { id: 'e3', centerId: 'c1', department: 'nails', name: 'نورا', specialty: 'جل ونيل آرت', rating: 4.9, available: true, homeService: false, color: COLORS[2], phone: '0920000003', password_hash: expertHash, servicePrices: {}, serviceDurations: {}, workingHours: {}, leaveRequests: [], clientNotes: {} },
    { id: 'e7', centerId: 'c1', department: 'henna', name: 'آية', specialty: 'حنة عروس ونقشات عصرية', rating: 4.9, available: true, homeService: true, color: COLORS[5], phone: '0920000007', password_hash: expertHash, servicePrices: {}, serviceDurations: {}, workingHours: {}, leaveRequests: [], clientNotes: {} },
    { id: 'e4', centerId: 'c2', department: 'hair', name: 'لينا', specialty: 'قص واستشوار', rating: 4.7, available: true, homeService: false, color: COLORS[3], phone: '0920000004', password_hash: expertHash, servicePrices: {}, serviceDurations: {}, workingHours: {}, leaveRequests: [], clientNotes: {} },
    { id: 'e5', centerId: 'c2', department: 'beauty', name: 'هدى', specialty: 'فيشل وعناية بالبشرة', rating: 4.8, available: false, homeService: false, color: COLORS[4], phone: '0920000005', password_hash: expertHash, servicePrices: {}, serviceDurations: {}, workingHours: {}, leaveRequests: [], clientNotes: {} },
    { id: 'e6', centerId: 'c3', department: 'spa', name: 'أمل', specialty: 'مساج استرخاء', rating: 4.9, available: true, homeService: true, color: COLORS[5], phone: '0920000006', password_hash: expertHash, servicePrices: {}, serviceDurations: {}, workingHours: {}, leaveRequests: [], clientNotes: {} },
    { id: 'e8', centerId: 'c3', department: 'cupping', name: 'سلمى', specialty: 'حجامة علاجية معتمدة', rating: 4.8, available: true, homeService: false, color: COLORS[0], phone: '0920000008', password_hash: expertHash, servicePrices: {}, serviceDurations: {}, workingHours: {}, leaveRequests: [], clientNotes: {} }
  ];
  for (const e of experts) await expertsStmt.insert.run(e);

  const packages = [
    { id: 'p1', centerId: 'c1', name: 'باقة العروس', items: 'شعر + مكياج + أظافر', price: 650 },
    { id: 'p2', centerId: 'c1', name: 'يوم الجمال', items: 'شعر + فيشل + مانيكير + باديكير', price: 300 }
  ];
  for (const p of packages) await packagesStmt.insert.run(p);
}

const dbReady = initSchema().then(seed);

module.exports = {
  db, uid, dbReady, j,
  centersStmt, expertsStmt, customersStmt, packagesStmt, bookingsStmt, reviewsStmt, settingsStmt, offersStmt,
  centerPublic, expertPublic, customerPublic, bookingPublic, bookingBusyView
};
