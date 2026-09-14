const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const {
  db, uid,
  centersStmt, expertsStmt, customersStmt, packagesStmt, bookingsStmt, reviewsStmt,
  centerPublic, expertPublic, customerPublic, bookingPublic, bookingBusyView
} = require('./db');
const { signToken, requireAuth } = require('./auth');

const ADMIN_PASSWORD = process.env.GLOWSPOT_ADMIN_PASSWORD || 'glowspot2026';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

/* ================= helpers ================= */
function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function rangesOverlap(aStart, aDur, bStart, bDur) { return aStart < bStart + bDur && bStart < aStart + aDur; }

function hasConflict(expertId, date, startMin, durMin, ignoreBookingId) {
  const rows = bookingsStmt.activeByExpertDate.all(expertId, date);
  return rows.some((b) => {
    if (ignoreBookingId && b.id === ignoreBookingId) return false;
    return rangesOverlap(startMin, durMin, timeToMin(b.time), b.duration || 60);
  });
}

function getExpert(id) { return expertsStmt.byId.get(id); }
function getCenter(id) { return centersStmt.byId.get(id); }

function recomputeCenterRating(centerId) {
  const rows = reviewsStmt.byCenter.all(centerId);
  if (!rows.length) return;
  const avg = rows.reduce((s, r) => s + r.rating, 0) / rows.length;
  centersStmt.updateRating.run(avg, centerId);
}
function recomputeExpertRating(expertId) {
  if (!expertId) return;
  const rows = reviewsStmt.byExpert.all(expertId);
  if (!rows.length) return;
  const avg = rows.reduce((s, r) => s + r.rating, 0) / rows.length;
  expertsStmt.updateRating.run(avg, expertId);
}

/* ================= public reads ================= */
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/centers', (req, res) => {
  res.json(centersStmt.all.all().map(centerPublic));
});
app.get('/api/experts', (req, res) => {
  res.json(expertsStmt.all.all().map(expertPublic));
});
app.get('/api/packages', (req, res) => {
  res.json(packagesStmt.all.all());
});
app.get('/api/reviews', (req, res) => {
  res.json(reviewsStmt.all.all());
});
app.get('/api/bookings/busy', (req, res) => {
  const rows = bookingsStmt.all.all().filter((b) => b.status !== 'cancelled' && b.status !== 'declined');
  res.json(rows.map(bookingBusyView));
});
app.post('/api/centers/:id/view', (req, res) => {
  const c = getCenter(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  centersStmt.incrementViews.run(c.id);
  res.json({ ok: true });
});

/* ================= auth ================= */
app.post('/api/auth/customer/signup', (req, res) => {
  const { name, phone, password } = req.body || {};
  if (!name || !phone || !password) return res.status(400).json({ error: 'missing_fields' });
  if (customersStmt.byPhone.get(phone)) return res.status(409).json({ error: 'phone_taken' });
  const row = {
    id: uid('u'), name: String(name).trim(), phone: String(phone).trim(),
    password_hash: bcrypt.hashSync(password, 10), favorites: '[]', favoriteExperts: '[]'
  };
  customersStmt.insert.run(row);
  const token = signToken({ role: 'customer', id: row.id });
  res.json({ token, customer: customerPublic(row) });
});

app.post('/api/auth/customer/login', (req, res) => {
  const { phone, password } = req.body || {};
  const row = phone && customersStmt.byPhone.get(phone);
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = signToken({ role: 'customer', id: row.id });
  res.json({ token, customer: customerPublic(row) });
});

app.post('/api/auth/center/login', (req, res) => {
  const { username, password } = req.body || {};
  const row = username && centersStmt.byUsername.get(username);
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = signToken({ role: 'center', id: row.id, centerId: row.id });
  res.json({ token, center: centerPublic(row) });
});

app.post('/api/auth/expert/login', (req, res) => {
  const { phone, password } = req.body || {};
  const row = phone && expertsStmt.byPhone.get(phone);
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = signToken({ role: 'expert', id: row.id, centerId: row.centerId });
  res.json({ token, expert: expertPublic(row) });
});

app.post('/api/auth/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'invalid_credentials' });
  const token = signToken({ role: 'admin', id: 'admin' });
  res.json({ token });
});

/* ================= customer ================= */
app.get('/api/customers/me', requireAuth('customer'), (req, res) => {
  const row = customersStmt.byId.get(req.auth.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(customerPublic(row));
});

app.patch('/api/customers/me', requireAuth('customer'), (req, res) => {
  const current = customersStmt.byId.get(req.auth.id);
  if (!current) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  const name = body.name !== undefined ? String(body.name) : current.name;
  const phone = body.phone !== undefined ? String(body.phone) : current.phone;
  const favorites = JSON.stringify(body.favorites !== undefined ? body.favorites : JSON.parse(current.favorites));
  const favoriteExperts = JSON.stringify(body.favoriteExperts !== undefined ? body.favoriteExperts : JSON.parse(current.favoriteExperts));
  db.prepare('UPDATE customers SET name=?, phone=?, favorites=?, favoriteExperts=? WHERE id=?').run(name, phone, favorites, favoriteExperts, current.id);
  res.json(customerPublic(customersStmt.byId.get(current.id)));
});

app.get('/api/bookings/mine', requireAuth('customer'), (req, res) => {
  res.json(bookingsStmt.byCustomer.all(req.auth.id).map(bookingPublic));
});

app.post('/api/bookings', requireAuth('customer'), (req, res) => {
  const body = req.body || {};
  const center = getCenter(body.centerId);
  if (!center) return res.status(404).json({ error: 'center_not_found' });

  let department = body.department || null;
  let service = body.service || null;
  let expertId = null, expertName = null, duration = 60, price = null, status = 'pending';

  if (body.mode === 'package') {
    const pkg = packagesStmt.byId.get(body.pkgId);
    if (!pkg || pkg.centerId !== center.id) return res.status(404).json({ error: 'package_not_found' });
    department = 'package'; service = pkg.name; price = pkg.price; duration = 60; status = 'confirmed';
  } else {
    if (!department || !service || !body.date || !body.time) return res.status(400).json({ error: 'missing_fields' });
    const deptExperts = expertsStmt.byCenter.all(center.id).filter((e) => e.department === department);

    if (body.expertId === 'any') {
      const durGuess = deptExperts.length ? (JSON.parse(deptExperts[0].serviceDurations)[service] || 60) : 60;
      const startMin = timeToMin(body.time);
      const free = deptExperts.find((e) => e.available && !hasConflict(e.id, body.date, startMin, JSON.parse(e.serviceDurations)[service] || durGuess));
      if (!free) return res.status(409).json({ error: 'no_expert_available' });
      expertId = free.id; expertName = free.name;
      duration = JSON.parse(free.serviceDurations)[service] || durGuess;
      const p = JSON.parse(free.servicePrices)[service];
      price = p > 0 ? p : null;
    } else if (body.expertId) {
      const ex = getExpert(body.expertId);
      if (!ex || ex.centerId !== center.id) return res.status(404).json({ error: 'expert_not_found' });
      expertId = ex.id; expertName = ex.name;
      duration = JSON.parse(ex.serviceDurations)[service] || 60;
      const p = JSON.parse(ex.servicePrices)[service];
      price = p > 0 ? p : null;
      const startMin = timeToMin(body.time);
      if (hasConflict(ex.id, body.date, startMin, duration)) return res.status(409).json({ error: 'slot_taken' });
    }
  }

  const customerName = (body.customerName || '').trim();
  const phone = (body.phone || '').trim();
  if (!customerName || !phone) return res.status(400).json({ error: 'missing_customer_info' });

  const row = {
    id: uid('bk'), centerId: center.id, centerName: center.name,
    department, service, expertId, expertName,
    customerId: req.auth.id, customerName, phone,
    date: body.date, time: body.time, duration, price, status,
    serviceLocation: body.serviceLocation || 'center',
    homeAddress: body.serviceLocation === 'home' ? (body.homeAddress || '').trim() : null,
    declineReason: null, alternatives: '[]'
  };
  bookingsStmt.insert.run(row);
  res.json(bookingPublic(bookingsStmt.byId.get(row.id)));
});

app.post('/api/reviews', requireAuth('customer'), (req, res) => {
  const { bookingId, rating, comment } = req.body || {};
  const booking = bookingId && bookingsStmt.byId.get(bookingId);
  if (!booking || booking.customerId !== req.auth.id) return res.status(404).json({ error: 'booking_not_found' });
  if (booking.status !== 'completed') return res.status(400).json({ error: 'booking_not_completed' });
  if (reviewsStmt.byBooking.all(bookingId).length) return res.status(409).json({ error: 'already_reviewed' });
  const n = parseInt(rating, 10);
  if (!(n >= 1 && n <= 5)) return res.status(400).json({ error: 'invalid_rating' });

  const row = {
    id: uid('r'), bookingId, centerId: booking.centerId, expertId: booking.expertId,
    customerId: req.auth.id, customerName: booking.customerName, rating: n,
    comment: (comment || '').trim(), createdAt: new Date().toISOString()
  };
  reviewsStmt.insert.run(row);
  recomputeCenterRating(booking.centerId);
  recomputeExpertRating(booking.expertId);
  res.json(row);
});

/* ================= bookings: shared mutation endpoint ================= */
app.patch('/api/bookings/:id', requireAuth('customer', 'expert', 'center'), (req, res) => {
  const booking = bookingsStmt.byId.get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'not_found' });
  const { status, declineReason, alternatives } = req.body || {};
  const role = req.auth.role;

  const setStatus = (newStatus, extra) => {
    const fields = Object.assign({ status: newStatus }, extra || {});
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE bookings SET ${sets} WHERE id = @id`).run(Object.assign({ id: booking.id }, fields));
    res.json(bookingPublic(bookingsStmt.byId.get(booking.id)));
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
      return setStatus('declined', { declineReason, alternatives: JSON.stringify(alternatives || []) });
    }
    return setStatus(status);
  }

  if (role === 'center') {
    if (booking.centerId !== req.auth.centerId) return res.status(403).json({ error: 'forbidden' });
    if (status !== 'cancelled') return res.status(400).json({ error: 'invalid_transition' });
    return setStatus('cancelled');
  }

  return res.status(403).json({ error: 'forbidden' });
});

/* ================= center (dashboard) ================= */
app.get('/api/centers/me', requireAuth('center'), (req, res) => {
  const row = getCenter(req.auth.centerId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(centerPublic(row));
});

app.get('/api/bookings/center-mine', requireAuth('center'), (req, res) => {
  res.json(bookingsStmt.byCenter.all(req.auth.centerId).map(bookingPublic));
});

app.patch('/api/centers/:id', requireAuth('center'), (req, res) => {
  if (req.params.id !== req.auth.centerId) return res.status(403).json({ error: 'forbidden' });
  const current = getCenter(req.params.id);
  if (!current) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const merged = {
    name: b.name !== undefined ? b.name : current.name,
    city: b.city !== undefined ? b.city : current.city,
    location: b.location !== undefined ? b.location : current.location,
    about: b.about !== undefined ? b.about : current.about,
    departments: JSON.stringify(b.departments !== undefined ? b.departments : JSON.parse(current.departments)),
    paymentMethods: JSON.stringify(b.paymentMethods !== undefined ? b.paymentMethods : JSON.parse(current.paymentMethods)),
    homeService: (b.homeService !== undefined ? !!b.homeService : !!current.homeService) ? 1 : 0
  };
  db.prepare('UPDATE centers SET name=?, city=?, location=?, about=?, departments=?, paymentMethods=?, homeService=? WHERE id=?')
    .run(merged.name, merged.city, merged.location, merged.about, merged.departments, merged.paymentMethods, merged.homeService, current.id);
  res.json(centerPublic(getCenter(current.id)));
});

app.post('/api/experts', requireAuth('center'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.department || !b.phone || !b.password) return res.status(400).json({ error: 'missing_fields' });
  if (expertsStmt.byPhone.get(b.phone)) return res.status(409).json({ error: 'phone_taken' });
  const COLORS = ['#6B1F35', '#C98CA7', '#C9A227', '#8C5B70', '#9B3B49', '#4E1526'];
  const row = {
    id: uid('e'), centerId: req.auth.centerId, department: b.department, name: b.name,
    specialty: b.specialty || 'خدمات عامة', rating: 5.0, available: 1,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    phone: b.phone, password_hash: bcrypt.hashSync(b.password, 10),
    servicePrices: '{}', serviceDurations: '{}', workingHours: '{}', leaveRequests: '[]', clientNotes: '{}'
  };
  expertsStmt.insert.run(row);
  res.json(expertPublic(row));
});

app.delete('/api/experts/:id', requireAuth('center'), (req, res) => {
  const ex = getExpert(req.params.id);
  if (!ex || ex.centerId !== req.auth.centerId) return res.status(404).json({ error: 'not_found' });
  expertsStmt.delete.run(ex.id);
  res.json({ ok: true });
});

app.post('/api/packages', requireAuth('center'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'missing_fields' });
  const row = { id: uid('p'), centerId: req.auth.centerId, name: b.name, items: b.items || '', price: parseFloat(b.price) || 0 };
  packagesStmt.insert.run(row);
  res.json(row);
});

app.delete('/api/packages/:id', requireAuth('center'), (req, res) => {
  const pkg = packagesStmt.byId.get(req.params.id);
  if (!pkg || pkg.centerId !== req.auth.centerId) return res.status(404).json({ error: 'not_found' });
  packagesStmt.delete.run(pkg.id);
  res.json({ ok: true });
});

/* ================= expert (staff) + shared expert profile edits ================= */
app.get('/api/experts/me', requireAuth('expert'), (req, res) => {
  const row = getExpert(req.auth.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(expertPublic(row));
});

app.get('/api/bookings/expert-mine', requireAuth('expert'), (req, res) => {
  res.json(bookingsStmt.byExpert.all(req.auth.id).map(bookingPublic));
});

app.patch('/api/experts/:id', requireAuth('expert', 'center'), (req, res) => {
  const current = getExpert(req.params.id);
  if (!current) return res.status(404).json({ error: 'not_found' });
  const isOwner = req.auth.role === 'expert' && req.auth.id === current.id;
  const isOwningCenter = req.auth.role === 'center' && req.auth.centerId === current.centerId;
  if (!isOwner && !isOwningCenter) return res.status(403).json({ error: 'forbidden' });

  const b = req.body || {};
  const merged = {
    available: (b.available !== undefined ? !!b.available : !!current.available) ? 1 : 0,
    servicePrices: JSON.stringify(b.servicePrices !== undefined ? b.servicePrices : JSON.parse(current.servicePrices)),
    serviceDurations: JSON.stringify(b.serviceDurations !== undefined ? b.serviceDurations : JSON.parse(current.serviceDurations)),
    workingHours: JSON.stringify(b.workingHours !== undefined ? b.workingHours : JSON.parse(current.workingHours)),
    leaveRequests: JSON.stringify(b.leaveRequests !== undefined ? b.leaveRequests : JSON.parse(current.leaveRequests)),
    clientNotes: JSON.stringify(b.clientNotes !== undefined ? b.clientNotes : JSON.parse(current.clientNotes))
  };
  db.prepare('UPDATE experts SET available=?, servicePrices=?, serviceDurations=?, workingHours=?, leaveRequests=?, clientNotes=? WHERE id=?')
    .run(merged.available, merged.servicePrices, merged.serviceDurations, merged.workingHours, merged.leaveRequests, merged.clientNotes, current.id);
  res.json(expertPublic(getExpert(current.id)));
});

/* ================= admin ================= */
app.get('/api/customers', requireAuth('admin'), (req, res) => {
  res.json(customersStmt.all.all().map(customerPublic));
});
app.get('/api/bookings', requireAuth('admin'), (req, res) => {
  res.json(bookingsStmt.all.all().map(bookingPublic));
});

app.post('/api/centers', requireAuth('admin'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.city || !b.username || !b.password) return res.status(400).json({ error: 'missing_fields' });
  if (centersStmt.byUsername.get(b.username)) return res.status(409).json({ error: 'username_taken' });
  const row = {
    id: uid('c'), name: b.name, city: b.city, location: b.location || '', about: b.about || '',
    verified: 0, rating: 5.0, status: 'approved', departments: '[]',
    username: b.username, password_hash: bcrypt.hashSync(b.password, 10),
    paymentMethods: '{}', homeService: 0, views: 0
  };
  centersStmt.insert.run(row);
  res.json(centerPublic(row));
});

app.patch('/api/centers/:id/status', requireAuth('admin'), (req, res) => {
  const { status } = req.body || {};
  if (!['approved', 'pending', 'disabled'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  const c = getCenter(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  centersStmt.updateStatus.run(status, c.id);
  res.json(centerPublic(getCenter(c.id)));
});

app.delete('/api/centers/:id', requireAuth('admin'), (req, res) => {
  const c = getCenter(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  centersStmt.delete.run(c.id);
  res.json({ ok: true });
});

/* ================= static apps ================= */
app.use(express.static(path.join(__dirname, '..', 'apps')));

app.listen(PORT, () => {
  console.log(`GlowSpot server running on http://localhost:${PORT}`);
  console.log(`Apps served from http://localhost:${PORT}/glowspot-customer.html (and dashboard/staff/admin)`);
});
