const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DB_PATH = process.env.GLOWSPOT_DB_PATH || path.join(__dirname, 'glowspot.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS centers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT,
  location TEXT,
  about TEXT,
  verified INTEGER DEFAULT 0,
  rating REAL DEFAULT 0,
  status TEXT DEFAULT 'pending',
  departments TEXT DEFAULT '[]',
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  paymentMethods TEXT DEFAULT '{}',
  homeService INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS experts (
  id TEXT PRIMARY KEY,
  centerId TEXT NOT NULL,
  department TEXT,
  name TEXT NOT NULL,
  specialty TEXT,
  rating REAL DEFAULT 0,
  available INTEGER DEFAULT 1,
  color TEXT,
  phone TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  servicePrices TEXT DEFAULT '{}',
  serviceDurations TEXT DEFAULT '{}',
  workingHours TEXT DEFAULT '{}',
  leaveRequests TEXT DEFAULT '[]',
  clientNotes TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  favorites TEXT DEFAULT '[]',
  favoriteExperts TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  centerId TEXT NOT NULL,
  name TEXT NOT NULL,
  items TEXT,
  price REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  centerId TEXT NOT NULL,
  centerName TEXT,
  department TEXT,
  service TEXT,
  expertId TEXT,
  expertName TEXT,
  customerId TEXT,
  customerName TEXT,
  phone TEXT,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  duration INTEGER DEFAULT 60,
  price REAL,
  status TEXT DEFAULT 'pending',
  serviceLocation TEXT DEFAULT 'center',
  homeAddress TEXT,
  declineReason TEXT,
  alternatives TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  bookingId TEXT,
  centerId TEXT,
  expertId TEXT,
  customerId TEXT,
  customerName TEXT,
  rating INTEGER,
  comment TEXT,
  createdAt TEXT
);
`);

function uid(prefix) {
  return (prefix ? prefix + '_' : '') + crypto.randomBytes(9).toString('hex');
}

/* ---------------- JSON column helpers ---------------- */
const CENTER_JSON_COLS = ['departments', 'paymentMethods'];
const EXPERT_JSON_COLS = ['servicePrices', 'serviceDurations', 'workingHours', 'leaveRequests', 'clientNotes'];
const CUSTOMER_JSON_COLS = ['favorites', 'favoriteExperts'];
const BOOKING_JSON_COLS = ['alternatives'];

function parseJsonCols(row, cols) {
  if (!row) return row;
  const out = Object.assign({}, row);
  cols.forEach((c) => {
    try { out[c] = JSON.parse(out[c]); } catch (e) { out[c] = c === 'leaveRequests' || c === 'alternatives' || c === 'departments' || c === 'favorites' || c === 'favoriteExperts' ? [] : {}; }
  });
  return out;
}

function centerPublic(row) {
  if (!row) return null;
  const c = parseJsonCols(row, CENTER_JSON_COLS);
  delete c.password_hash;
  c.verified = !!c.verified;
  c.homeService = !!c.homeService;
  return c;
}
function expertPublic(row) {
  if (!row) return null;
  const e = parseJsonCols(row, EXPERT_JSON_COLS);
  delete e.password_hash;
  e.available = !!e.available;
  return e;
}
function customerPublic(row) {
  if (!row) return null;
  const c = parseJsonCols(row, CUSTOMER_JSON_COLS);
  delete c.password_hash;
  return c;
}
function bookingPublic(row) {
  if (!row) return null;
  return parseJsonCols(row, BOOKING_JSON_COLS);
}
function bookingBusyView(row) {
  return { expertId: row.expertId, date: row.date, time: row.time, duration: row.duration, status: row.status };
}

/* ---------------- generic CRUD ---------------- */
const centersStmt = {
  all: db.prepare('SELECT * FROM centers'),
  byId: db.prepare('SELECT * FROM centers WHERE id = ?'),
  byUsername: db.prepare('SELECT * FROM centers WHERE username = ?'),
  insert: db.prepare(`INSERT INTO centers (id,name,city,location,about,verified,rating,status,departments,username,password_hash,paymentMethods,homeService,views)
    VALUES (@id,@name,@city,@location,@about,@verified,@rating,@status,@departments,@username,@password_hash,@paymentMethods,@homeService,@views)`),
  updateStatus: db.prepare('UPDATE centers SET status = ? WHERE id = ?'),
  delete: db.prepare('DELETE FROM centers WHERE id = ?'),
  updateRating: db.prepare('UPDATE centers SET rating = ? WHERE id = ?'),
  incrementViews: db.prepare('UPDATE centers SET views = views + 1 WHERE id = ?')
};

const expertsStmt = {
  all: db.prepare('SELECT * FROM experts'),
  byId: db.prepare('SELECT * FROM experts WHERE id = ?'),
  byPhone: db.prepare('SELECT * FROM experts WHERE phone = ?'),
  byCenter: db.prepare('SELECT * FROM experts WHERE centerId = ?'),
  insert: db.prepare(`INSERT INTO experts (id,centerId,department,name,specialty,rating,available,color,phone,password_hash,servicePrices,serviceDurations,workingHours,leaveRequests,clientNotes)
    VALUES (@id,@centerId,@department,@name,@specialty,@rating,@available,@color,@phone,@password_hash,@servicePrices,@serviceDurations,@workingHours,@leaveRequests,@clientNotes)`),
  delete: db.prepare('DELETE FROM experts WHERE id = ?'),
  updateRating: db.prepare('UPDATE experts SET rating = ? WHERE id = ?')
};

const customersStmt = {
  all: db.prepare('SELECT * FROM customers'),
  byId: db.prepare('SELECT * FROM customers WHERE id = ?'),
  byPhone: db.prepare('SELECT * FROM customers WHERE phone = ?'),
  insert: db.prepare(`INSERT INTO customers (id,name,phone,password_hash,favorites,favoriteExperts) VALUES (@id,@name,@phone,@password_hash,@favorites,@favoriteExperts)`)
};

const packagesStmt = {
  all: db.prepare('SELECT * FROM packages'),
  byId: db.prepare('SELECT * FROM packages WHERE id = ?'),
  byCenter: db.prepare('SELECT * FROM packages WHERE centerId = ?'),
  insert: db.prepare('INSERT INTO packages (id,centerId,name,items,price) VALUES (@id,@centerId,@name,@items,@price)'),
  delete: db.prepare('DELETE FROM packages WHERE id = ?')
};

const bookingsStmt = {
  all: db.prepare('SELECT * FROM bookings'),
  byId: db.prepare('SELECT * FROM bookings WHERE id = ?'),
  byCustomer: db.prepare('SELECT * FROM bookings WHERE customerId = ?'),
  byExpert: db.prepare('SELECT * FROM bookings WHERE expertId = ?'),
  byCenter: db.prepare('SELECT * FROM bookings WHERE centerId = ?'),
  activeByExpertDate: db.prepare(`SELECT * FROM bookings WHERE expertId = ? AND date = ? AND status NOT IN ('cancelled','declined')`),
  insert: db.prepare(`INSERT INTO bookings (id,centerId,centerName,department,service,expertId,expertName,customerId,customerName,phone,date,time,duration,price,status,serviceLocation,homeAddress,declineReason,alternatives)
    VALUES (@id,@centerId,@centerName,@department,@service,@expertId,@expertName,@customerId,@customerName,@phone,@date,@time,@duration,@price,@status,@serviceLocation,@homeAddress,@declineReason,@alternatives)`)
};

const reviewsStmt = {
  all: db.prepare('SELECT * FROM reviews'),
  byBooking: db.prepare('SELECT * FROM reviews WHERE bookingId = ?'),
  byCenter: db.prepare('SELECT * FROM reviews WHERE centerId = ?'),
  byExpert: db.prepare('SELECT * FROM reviews WHERE expertId = ?'),
  insert: db.prepare('INSERT INTO reviews (id,bookingId,centerId,expertId,customerId,customerName,rating,comment,createdAt) VALUES (@id,@bookingId,@centerId,@expertId,@customerId,@customerName,@rating,@comment,@createdAt)')
};

/* ---------------- seed (mirrors the front-end demo data) ---------------- */
function seed() {
  const centerCount = db.prepare('SELECT COUNT(*) AS n FROM centers').get().n;
  if (centerCount > 0) return;

  const centers = [
    { id: 'c1', name: 'Glow Beauty Center', city: 'بنغازي', location: 'الفويهات', about: 'مركز متكامل للعناية بالشعر والمكياج والأظافر والسبا في أجواء مريحة وخاصة.', verified: 1, rating: 4.8, status: 'approved', departments: JSON.stringify(['hair', 'makeup', 'nails', 'henna', 'spa']), username: 'glowbeauty', password_hash: bcrypt.hashSync('center123', 10), paymentMethods: '{}', homeService: 1, views: 0 },
    { id: 'c2', name: 'Royal Beauty Center', city: 'بنغازي', location: 'بن عاشور', about: 'خبرات معتمدة في الشعر والعناية بالبشرة والحمام المغربي.', verified: 1, rating: 4.6, status: 'approved', departments: JSON.stringify(['hair', 'beauty', 'steam']), username: 'royalbeauty', password_hash: bcrypt.hashSync('center123', 10), paymentMethods: '{}', homeService: 0, views: 0 },
    { id: 'c3', name: 'Luna Spa', city: 'طرابلس', location: 'حي الأندلس', about: 'وجهتك للاسترخاء: سبا وحمام بخار وعناية كاملة بالجسم.', verified: 0, rating: 4.7, status: 'approved', departments: JSON.stringify(['spa', 'steam', 'beauty', 'cupping']), username: 'lunaspa', password_hash: bcrypt.hashSync('center123', 10), paymentMethods: '{}', homeService: 1, views: 0 }
  ];
  const insertCenters = db.transaction((rows) => rows.forEach((r) => centersStmt.insert.run(r)));
  insertCenters(centers);

  const COLORS = ['#6B1F35', '#C98CA7', '#C9A227', '#8C5B70', '#9B3B49', '#4E1526'];
  const expertHash = bcrypt.hashSync('expert123', 10);
  const experts = [
    { id: 'e1', centerId: 'c1', department: 'hair', name: 'سارة', specialty: 'تصفيف وصبغة الشعر', rating: 4.9, available: 1, color: COLORS[0], phone: '0920000001', password_hash: expertHash, servicePrices: '{}', serviceDurations: '{}', workingHours: '{}', leaveRequests: '[]', clientNotes: '{}' },
    { id: 'e2', centerId: 'c1', department: 'makeup', name: 'مايا', specialty: 'مكياج سهرة وعرايس', rating: 4.8, available: 0, color: COLORS[1], phone: '0920000002', password_hash: expertHash, servicePrices: '{}', serviceDurations: '{}', workingHours: '{}', leaveRequests: '[]', clientNotes: '{}' },
    { id: 'e3', centerId: 'c1', department: 'nails', name: 'نورا', specialty: 'جل ونيل آرت', rating: 4.9, available: 1, color: COLORS[2], phone: '0920000003', password_hash: expertHash, servicePrices: '{}', serviceDurations: '{}', workingHours: '{}', leaveRequests: '[]', clientNotes: '{}' },
    { id: 'e7', centerId: 'c1', department: 'henna', name: 'آية', specialty: 'حنة عروس ونقشات عصرية', rating: 4.9, available: 1, color: COLORS[5], phone: '0920000007', password_hash: expertHash, servicePrices: '{}', serviceDurations: '{}', workingHours: '{}', leaveRequests: '[]', clientNotes: '{}' },
    { id: 'e4', centerId: 'c2', department: 'hair', name: 'لينا', specialty: 'قص واستشوار', rating: 4.7, available: 1, color: COLORS[3], phone: '0920000004', password_hash: expertHash, servicePrices: '{}', serviceDurations: '{}', workingHours: '{}', leaveRequests: '[]', clientNotes: '{}' },
    { id: 'e5', centerId: 'c2', department: 'beauty', name: 'هدى', specialty: 'فيشل وعناية بالبشرة', rating: 4.8, available: 0, color: COLORS[4], phone: '0920000005', password_hash: expertHash, servicePrices: '{}', serviceDurations: '{}', workingHours: '{}', leaveRequests: '[]', clientNotes: '{}' },
    { id: 'e6', centerId: 'c3', department: 'spa', name: 'أمل', specialty: 'مساج استرخاء', rating: 4.9, available: 1, color: COLORS[5], phone: '0920000006', password_hash: expertHash, servicePrices: '{}', serviceDurations: '{}', workingHours: '{}', leaveRequests: '[]', clientNotes: '{}' },
    { id: 'e8', centerId: 'c3', department: 'cupping', name: 'سلمى', specialty: 'حجامة علاجية معتمدة', rating: 4.8, available: 1, color: COLORS[0], phone: '0920000008', password_hash: expertHash, servicePrices: '{}', serviceDurations: '{}', workingHours: '{}', leaveRequests: '[]', clientNotes: '{}' }
  ];
  const insertExperts = db.transaction((rows) => rows.forEach((r) => expertsStmt.insert.run(r)));
  insertExperts(experts);

  const packages = [
    { id: 'p1', centerId: 'c1', name: 'باقة العروس', items: 'شعر + مكياج + أظافر', price: 650 },
    { id: 'p2', centerId: 'c1', name: 'يوم الجمال', items: 'شعر + فيشل + مانيكير + باديكير', price: 300 }
  ];
  const insertPackages = db.transaction((rows) => rows.forEach((r) => packagesStmt.insert.run(r)));
  insertPackages(packages);
}
seed();

module.exports = {
  db, uid,
  centersStmt, expertsStmt, customersStmt, packagesStmt, bookingsStmt, reviewsStmt,
  centerPublic, expertPublic, customerPublic, bookingPublic, bookingBusyView
};
