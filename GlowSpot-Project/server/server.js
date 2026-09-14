const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const {
  db, uid, dbReady, j,
  centersStmt, expertsStmt, customersStmt, packagesStmt, bookingsStmt, reviewsStmt, settingsStmt,
  centerPublic, expertPublic, customerPublic, bookingPublic, bookingBusyView
} = require('./db');
const { signToken, requireAuth } = require('./auth');

const ADMIN_PASSWORD = process.env.GLOWSPOT_ADMIN_PASSWORD || 'glowspot2026';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

/* Wraps an async route handler so a rejected promise reaches Express's
   error handling instead of hanging the request (Express 4 doesn't do
   this automatically). */
function ar(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/* ================= helpers ================= */
function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function rangesOverlap(aStart, aDur, bStart, bDur) { return aStart < bStart + bDur && bStart < aStart + aDur; }

async function hasConflict(expertId, date, startMin, durMin) {
  const rows = await bookingsStmt.activeByExpertDate.all(expertId, date);
  return rows.some((b) => rangesOverlap(startMin, durMin, timeToMin(b.time), b.duration || 60));
}

async function getExpert(id) { return expertsStmt.byId.get(id); }
async function getCenter(id) { return centersStmt.byId.get(id); }

async function getCommissionRate() {
  const row = await settingsStmt.get('commissionRate');
  const rate = row ? parseFloat(row.value) : NaN;
  return Number.isFinite(rate) ? rate : 0.10;
}
function round2(n) { return Math.round(n * 100) / 100; }

async function recomputeCenterRating(centerId) {
  const rows = await reviewsStmt.byCenter.all(centerId);
  if (!rows.length) return;
  const avg = rows.reduce((s, r) => s + r.rating, 0) / rows.length;
  await centersStmt.updateRating.run(avg, centerId);
}
async function recomputeExpertRating(expertId) {
  if (!expertId) return;
  const rows = await reviewsStmt.byExpert.all(expertId);
  if (!rows.length) return;
  const avg = rows.reduce((s, r) => s + r.rating, 0) / rows.length;
  await expertsStmt.updateRating.run(avg, expertId);
}

/* ================= public reads ================= */
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/centers', ar(async (req, res) => {
  res.json((await centersStmt.all.all()).map(centerPublic));
}));
app.get('/api/experts', ar(async (req, res) => {
  res.json((await expertsStmt.all.all()).map(expertPublic));
}));
app.get('/api/packages', ar(async (req, res) => {
  res.json(await packagesStmt.all.all());
}));
app.get('/api/reviews', ar(async (req, res) => {
  res.json(await reviewsStmt.all.all());
}));
app.get('/api/bookings/busy', ar(async (req, res) => {
  const rows = (await bookingsStmt.all.all()).filter((b) => b.status !== 'cancelled' && b.status !== 'declined');
  res.json(rows.map(bookingBusyView));
}));
app.post('/api/centers/:id/view', ar(async (req, res) => {
  const c = await getCenter(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  await centersStmt.incrementViews.run(c.id);
  res.json({ ok: true });
}));
app.get('/api/settings', ar(async (req, res) => {
  res.json({ commissionRate: await getCommissionRate() });
}));

/* ================= auth ================= */
app.post('/api/auth/customer/signup', ar(async (req, res) => {
  const { name, phone, password } = req.body || {};
  if (!name || !phone || !password) return res.status(400).json({ error: 'missing_fields' });
  if (await customersStmt.byPhone.get(phone)) return res.status(409).json({ error: 'phone_taken' });
  const row = {
    id: uid('u'), name: String(name).trim(), phone: String(phone).trim(),
    password_hash: bcrypt.hashSync(password, 10), favorites: [], favoriteExperts: []
  };
  await customersStmt.insert.run(row);
  const token = signToken({ role: 'customer', id: row.id });
  res.json({ token, customer: customerPublic(row) });
}));

app.post('/api/auth/customer/login', ar(async (req, res) => {
  const { phone, password } = req.body || {};
  const row = phone && await customersStmt.byPhone.get(phone);
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = signToken({ role: 'customer', id: row.id });
  res.json({ token, customer: customerPublic(row) });
}));

app.post('/api/auth/center/login', ar(async (req, res) => {
  const { username, password } = req.body || {};
  const row = username && await centersStmt.byUsername.get(username);
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = signToken({ role: 'center', id: row.id, centerId: row.id });
  res.json({ token, center: centerPublic(row) });
}));

app.post('/api/auth/expert/login', ar(async (req, res) => {
  const { phone, password } = req.body || {};
  const row = phone && await expertsStmt.byPhone.get(phone);
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = signToken({ role: 'expert', id: row.id, centerId: row.centerId });
  res.json({ token, expert: expertPublic(row) });
}));

app.post('/api/auth/admin/login', ar(async (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'invalid_credentials' });
  const token = signToken({ role: 'admin', id: 'admin' });
  res.json({ token });
}));

/* ================= customer ================= */
app.get('/api/customers/me', requireAuth('customer'), ar(async (req, res) => {
  const row = await customersStmt.byId.get(req.auth.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(customerPublic(row));
}));

app.patch('/api/customers/me', requireAuth('customer'), ar(async (req, res) => {
  const current = await customersStmt.byId.get(req.auth.id);
  if (!current) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  const name = body.name !== undefined ? String(body.name) : current.name;
  const phone = body.phone !== undefined ? String(body.phone) : current.phone;
  const favorites = body.favorites !== undefined ? body.favorites : current.favorites;
  const favoriteExperts = body.favoriteExperts !== undefined ? body.favoriteExperts : current.favoriteExperts;
  await db.query('UPDATE customers SET name=$1, phone=$2, favorites=$3, "favoriteExperts"=$4 WHERE id=$5', [name, phone, j(favorites), j(favoriteExperts), current.id]);
  res.json(customerPublic(await customersStmt.byId.get(current.id)));
}));

app.get('/api/bookings/mine', requireAuth('customer'), ar(async (req, res) => {
  res.json((await bookingsStmt.byCustomer.all(req.auth.id)).map(bookingPublic));
}));

app.post('/api/bookings', requireAuth('customer'), ar(async (req, res) => {
  const body = req.body || {};
  const center = await getCenter(body.centerId);
  if (!center) return res.status(404).json({ error: 'center_not_found' });

  let department = body.department || null;
  let service = body.service || null;
  let expertId = null, expertName = null, duration = 60, price = null, status = 'pending';

  if (body.mode === 'package') {
    const pkg = await packagesStmt.byId.get(body.pkgId);
    if (!pkg || pkg.centerId !== center.id) return res.status(404).json({ error: 'package_not_found' });
    department = 'package'; service = pkg.name; price = pkg.price; duration = 60; status = 'confirmed';
  } else {
    if (!department || !service || !body.date || !body.time) return res.status(400).json({ error: 'missing_fields' });
    const deptExperts = (await expertsStmt.byCenter.all(center.id)).filter((e) => e.department === department);

    if (body.expertId === 'any') {
      const durGuess = deptExperts.length ? (deptExperts[0].serviceDurations[service] || 60) : 60;
      const startMin = timeToMin(body.time);
      let free = null;
      for (const e of deptExperts) {
        if (!e.available) continue;
        if (body.serviceLocation === 'home' && !e.homeService) continue;
        const dur = e.serviceDurations[service] || durGuess;
        if (!(await hasConflict(e.id, body.date, startMin, dur))) { free = e; break; }
      }
      if (!free) return res.status(409).json({ error: 'no_expert_available' });
      expertId = free.id; expertName = free.name;
      duration = free.serviceDurations[service] || durGuess;
      const p = free.servicePrices[service];
      price = p > 0 ? p : null;
    } else if (body.expertId) {
      const ex = await getExpert(body.expertId);
      if (!ex || ex.centerId !== center.id) return res.status(404).json({ error: 'expert_not_found' });
      if (body.serviceLocation === 'home' && !ex.homeService) return res.status(400).json({ error: 'expert_no_home_service' });
      expertId = ex.id; expertName = ex.name;
      duration = ex.serviceDurations[service] || 60;
      const p = ex.servicePrices[service];
      price = p > 0 ? p : null;
      const startMin = timeToMin(body.time);
      if (await hasConflict(ex.id, body.date, startMin, duration)) return res.status(409).json({ error: 'slot_taken' });
    }
  }

  const customerName = (body.customerName || '').trim();
  const phone = (body.phone || '').trim();
  if (!customerName || !phone) return res.status(400).json({ error: 'missing_customer_info' });

  // Commission is computed and stored at creation time (not derived later
  // from the live rate) so a future rate change never rewrites the numbers
  // on past bookings.
  let commissionAmount = null, netAmount = null;
  if (price != null) {
    const rate = await getCommissionRate();
    commissionAmount = round2(price * rate);
    netAmount = round2(price - commissionAmount);
  }

  const row = {
    id: uid('bk'), centerId: center.id, centerName: center.name,
    department, service, expertId, expertName,
    customerId: req.auth.id, customerName, phone,
    date: body.date, time: body.time, duration, price, commissionAmount, netAmount, status,
    serviceLocation: body.serviceLocation || 'center',
    homeAddress: body.serviceLocation === 'home' ? (body.homeAddress || '').trim() : null,
    declineReason: null, alternatives: []
  };
  await bookingsStmt.insert.run(row);
  res.json(bookingPublic(await bookingsStmt.byId.get(row.id)));
}));

app.post('/api/reviews', requireAuth('customer'), ar(async (req, res) => {
  const { bookingId, rating, comment } = req.body || {};
  const booking = bookingId && await bookingsStmt.byId.get(bookingId);
  if (!booking || booking.customerId !== req.auth.id) return res.status(404).json({ error: 'booking_not_found' });
  if (booking.status !== 'completed') return res.status(400).json({ error: 'booking_not_completed' });
  if ((await reviewsStmt.byBooking.all(bookingId)).length) return res.status(409).json({ error: 'already_reviewed' });
  const n = parseInt(rating, 10);
  if (!(n >= 1 && n <= 5)) return res.status(400).json({ error: 'invalid_rating' });

  const row = {
    id: uid('r'), bookingId, centerId: booking.centerId, expertId: booking.expertId,
    customerId: req.auth.id, customerName: booking.customerName, rating: n,
    comment: (comment || '').trim(), createdAt: new Date().toISOString()
  };
  await reviewsStmt.insert.run(row);
  await recomputeCenterRating(booking.centerId);
  await recomputeExpertRating(booking.expertId);
  res.json(row);
}));

/* ================= bookings: shared mutation endpoint ================= */
app.patch('/api/bookings/:id', requireAuth('customer', 'expert', 'center'), ar(async (req, res) => {
  const booking = await bookingsStmt.byId.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'not_found' });
  const { status, declineReason, alternatives } = req.body || {};
  const role = req.auth.role;

  const setStatus = async (newStatus, extra) => {
    const fields = Object.assign({ status: newStatus }, extra || {});
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
    const values = keys.map((k) => fields[k]);
    values.push(booking.id);
    await db.query(`UPDATE bookings SET ${sets} WHERE id = $${keys.length + 1}`, values);
    res.json(bookingPublic(await bookingsStmt.byId.get(booking.id)));
  };

  if (role === 'customer') {
    if (booking.customerId !== req.auth.id) return res.status(403).json({ error: 'forbidden' });
    if (status !== 'cancelled' || !['pending', 'confirmed'].includes(booking.status)) {
      return res.status(400).json({ error: 'invalid_transition' });
    }
    return setStatus('cancelled');
  }

  if (role === 'expert') {
    if (booking.expertId !== req.auth.id) return res.status(403).json({ error: 'forbidden' });
    const allowed = {
      pending: ['confirmed', 'declined'],
      confirmed: ['in_service', 'cancelled', 'no_show'],
      in_service: ['completed']
    };
    if (!allowed[booking.status] || !allowed[booking.status].includes(status)) {
      return res.status(400).json({ error: 'invalid_transition' });
    }
    if (status === 'declined') {
      if (!declineReason) return res.status(400).json({ error: 'decline_reason_required' });
      return setStatus('declined', { declineReason, alternatives: j(alternatives || []) });
    }
    return setStatus(status);
  }

  if (role === 'center') {
    if (booking.centerId !== req.auth.centerId) return res.status(403).json({ error: 'forbidden' });
    if (status !== 'cancelled') return res.status(400).json({ error: 'invalid_transition' });
    return setStatus('cancelled');
  }

  return res.status(403).json({ error: 'forbidden' });
}));

/* ================= center (dashboard) ================= */
app.get('/api/centers/me', requireAuth('center'), ar(async (req, res) => {
  const row = await getCenter(req.auth.centerId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(centerPublic(row));
}));

app.get('/api/bookings/center-mine', requireAuth('center'), ar(async (req, res) => {
  res.json((await bookingsStmt.byCenter.all(req.auth.centerId)).map(bookingPublic));
}));

app.patch('/api/centers/:id', requireAuth('center'), ar(async (req, res) => {
  if (req.params.id !== req.auth.centerId) return res.status(403).json({ error: 'forbidden' });
  const current = await getCenter(req.params.id);
  if (!current) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const merged = {
    name: b.name !== undefined ? b.name : current.name,
    city: b.city !== undefined ? b.city : current.city,
    location: b.location !== undefined ? b.location : current.location,
    about: b.about !== undefined ? b.about : current.about,
    departments: b.departments !== undefined ? b.departments : current.departments,
    paymentMethods: b.paymentMethods !== undefined ? b.paymentMethods : current.paymentMethods
  };
  await db.query(
    'UPDATE centers SET name=$1, city=$2, location=$3, about=$4, departments=$5, "paymentMethods"=$6 WHERE id=$7',
    [merged.name, merged.city, merged.location, merged.about, j(merged.departments), j(merged.paymentMethods), current.id]
  );
  res.json(centerPublic(await getCenter(current.id)));
}));

app.post('/api/experts', requireAuth('center'), ar(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.department || !b.phone || !b.password) return res.status(400).json({ error: 'missing_fields' });
  if (await expertsStmt.byPhone.get(b.phone)) return res.status(409).json({ error: 'phone_taken' });
  const COLORS = ['#6B1F35', '#C98CA7', '#C9A227', '#8C5B70', '#9B3B49', '#4E1526'];
  const row = {
    id: uid('e'), centerId: req.auth.centerId, department: b.department, name: b.name,
    specialty: b.specialty || 'خدمات عامة', rating: 5.0, available: true, homeService: false,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    phone: b.phone, password_hash: bcrypt.hashSync(b.password, 10),
    servicePrices: {}, serviceDurations: {}, workingHours: {}, leaveRequests: [], clientNotes: {}
  };
  await expertsStmt.insert.run(row);
  res.json(expertPublic(row));
}));

app.delete('/api/experts/:id', requireAuth('center'), ar(async (req, res) => {
  const ex = await getExpert(req.params.id);
  if (!ex || ex.centerId !== req.auth.centerId) return res.status(404).json({ error: 'not_found' });
  await expertsStmt.delete.run(ex.id);
  res.json({ ok: true });
}));

app.post('/api/packages', requireAuth('center'), ar(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'missing_fields' });
  const row = { id: uid('p'), centerId: req.auth.centerId, name: b.name, items: b.items || '', price: parseFloat(b.price) || 0 };
  await packagesStmt.insert.run(row);
  res.json(row);
}));

app.delete('/api/packages/:id', requireAuth('center'), ar(async (req, res) => {
  const pkg = await packagesStmt.byId.get(req.params.id);
  if (!pkg || pkg.centerId !== req.auth.centerId) return res.status(404).json({ error: 'not_found' });
  await packagesStmt.delete.run(pkg.id);
  res.json({ ok: true });
}));

/* ================= expert (staff) + shared expert profile edits ================= */
app.get('/api/experts/me', requireAuth('expert'), ar(async (req, res) => {
  const row = await getExpert(req.auth.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(expertPublic(row));
}));

app.get('/api/bookings/expert-mine', requireAuth('expert'), ar(async (req, res) => {
  res.json((await bookingsStmt.byExpert.all(req.auth.id)).map(bookingPublic));
}));

app.patch('/api/experts/:id', requireAuth('expert', 'center'), ar(async (req, res) => {
  const current = await getExpert(req.params.id);
  if (!current) return res.status(404).json({ error: 'not_found' });
  const isOwner = req.auth.role === 'expert' && req.auth.id === current.id;
  const isOwningCenter = req.auth.role === 'center' && req.auth.centerId === current.centerId;
  if (!isOwner && !isOwningCenter) return res.status(403).json({ error: 'forbidden' });

  const b = req.body || {};
  const merged = {
    available: b.available !== undefined ? !!b.available : !!current.available,
    homeService: b.homeService !== undefined ? !!b.homeService : !!current.homeService,
    servicePrices: b.servicePrices !== undefined ? b.servicePrices : current.servicePrices,
    serviceDurations: b.serviceDurations !== undefined ? b.serviceDurations : current.serviceDurations,
    workingHours: b.workingHours !== undefined ? b.workingHours : current.workingHours,
    leaveRequests: b.leaveRequests !== undefined ? b.leaveRequests : current.leaveRequests,
    clientNotes: b.clientNotes !== undefined ? b.clientNotes : current.clientNotes
  };
  await db.query(
    'UPDATE experts SET available=$1, "homeService"=$2, "servicePrices"=$3, "serviceDurations"=$4, "workingHours"=$5, "leaveRequests"=$6, "clientNotes"=$7 WHERE id=$8',
    [merged.available, merged.homeService, j(merged.servicePrices), j(merged.serviceDurations), j(merged.workingHours), j(merged.leaveRequests), j(merged.clientNotes), current.id]
  );
  res.json(expertPublic(await getExpert(current.id)));
}));

/* ================= admin ================= */
app.get('/api/customers', requireAuth('admin'), ar(async (req, res) => {
  res.json((await customersStmt.all.all()).map(customerPublic));
}));
app.get('/api/bookings', requireAuth('admin'), ar(async (req, res) => {
  res.json((await bookingsStmt.all.all()).map(bookingPublic));
}));

app.patch('/api/settings', requireAuth('admin'), ar(async (req, res) => {
  const { commissionRate } = req.body || {};
  const rate = parseFloat(commissionRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 0.9) return res.status(400).json({ error: 'invalid_rate' });
  await settingsStmt.set('commissionRate', String(rate));
  res.json({ commissionRate: rate });
}));

app.post('/api/centers', requireAuth('admin'), ar(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.city || !b.username || !b.password) return res.status(400).json({ error: 'missing_fields' });
  if (await centersStmt.byUsername.get(b.username)) return res.status(409).json({ error: 'username_taken' });
  const row = {
    id: uid('c'), name: b.name, city: b.city, location: b.location || '', about: b.about || '',
    verified: false, rating: 5.0, status: 'approved', departments: [],
    username: b.username, password_hash: bcrypt.hashSync(b.password, 10),
    paymentMethods: {}, views: 0
  };
  await centersStmt.insert.run(row);
  res.json(centerPublic(row));
}));

app.patch('/api/centers/:id/status', requireAuth('admin'), ar(async (req, res) => {
  const { status } = req.body || {};
  if (!['approved', 'pending', 'disabled'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  const c = await getCenter(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  await centersStmt.updateStatus.run(status, c.id);
  res.json(centerPublic(await getCenter(c.id)));
}));

app.delete('/api/centers/:id', requireAuth('admin'), ar(async (req, res) => {
  const c = await getCenter(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  await centersStmt.delete.run(c.id);
  res.json({ ok: true });
}));

/* ================= static apps ================= */
app.use(express.static(path.join(__dirname, '..', 'apps')));

/* ================= error handling ================= */
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error' });
});

dbReady
  .then(() => {
    app.listen(PORT, () => {
      console.log(`GlowSpot server running on http://localhost:${PORT}`);
      console.log(`Apps served from http://localhost:${PORT}/glowspot-customer.html (and dashboard/staff/admin)`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize the database:', err);
    process.exit(1);
  });
