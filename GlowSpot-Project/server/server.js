const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const {
  db, uid, dbReady, j,
  centersStmt, expertsStmt, customersStmt, packagesStmt, bookingsStmt, reviewsStmt, settingsStmt, offersStmt,
  centerPublic, expertPublic, customerPublic, bookingPublic, bookingBusyView
} = require('./db');
const { signToken, requireAuth } = require('./auth');
const migrateToNeon = require('./migrate-to-neon');
const push = require('./push');

const ADMIN_PASSWORD = process.env.GLOWSPOT_ADMIN_PASSWORD || 'glowspot2026';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // portfolio/gallery photos are uploaded as base64 data URLs

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

/* Loyalty wallet: 10 points = 1 LYD off a future booking. Earned by
   completing a booking or leaving a review, redeemable at booking time. */
const POINTS_PER_LYD = 10;
async function awardPoints(customerId, points) {
  const cust = await customersStmt.byId.get(customerId);
  if (!cust) return;
  await customersStmt.updateWalletPoints.run((cust.walletPoints || 0) + points, customerId);
}
async function refundPoints(booking) {
  if (!booking.walletPointsRedeemed) return;
  await awardPoints(booking.customerId, booking.walletPointsRedeemed);
}

/* No SMS/email is wired up yet, so a self-service "forgot password" flow
   isn't possible — instead, whoever already manages an account (admin for
   centers/customers, a center for its own experts) can reset it here and
   relay the new password to them directly (phone call, WhatsApp, etc). */
const TEMP_PASSWORD_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // no 0/O/1/l/I
function genTempPassword() {
  let out = '';
  for (let i = 0; i < 8; i++) out += TEMP_PASSWORD_CHARS[crypto.randomInt(TEMP_PASSWORD_CHARS.length)];
  return out;
}

/* Photos arrive as base64 data URLs (no image host is wired up yet) — cap
   both count and size per photo so a bug or bad actor can't balloon the
   free-tier database. Client-side code already resizes/compresses before
   upload, so legitimate photos stay well under this. */
const MAX_PHOTO_CHARS = 500000; // ~350KB image, base64-inflated
function isValidPhoto(p) { return typeof p === 'string' && p.startsWith('data:image/') && p.length <= MAX_PHOTO_CHARS; }
function isValidPhotoList(arr, maxCount) { return Array.isArray(arr) && arr.length <= maxCount && arr.every(isValidPhoto); }

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

/* A cancelled slot is a lost sale unless someone rebooks it fast — so instead
   of just freeing the calendar, tell the expert's repeat/favoriting
   customers it just opened up. "Nearby" here means "already interested in
   this expert" (favorited her or booked her before), since the app has no
   geolocation data to go on. */
async function notifyWaitlistOfOpenSlot(booking) {
  if (!booking.expertId) return;
  const [favRows, priorRows] = await Promise.all([
    customersStmt.byFavoriteExpert.all(booking.expertId),
    bookingsStmt.priorCustomerIdsOfExpert.all(booking.expertId)
  ]);
  const ids = new Set([...favRows.map((c) => c.id), ...priorRows.map((r) => r.customerId)]);
  ids.delete(booking.customerId);
  if (!ids.size) return;

  const todayIso = new Date().toISOString().slice(0, 10);
  const dateLabel = booking.date === todayIso ? 'اليوم' : booking.date.split('-').reverse().slice(0, 2).join('/');
  const url = `/glowspot-customer.html?quickbook=${encodeURIComponent(booking.expertId)}&date=${encodeURIComponent(booking.date)}&time=${encodeURIComponent(booking.time)}&service=${encodeURIComponent(booking.service || '')}`;

  const candidates = [...ids].slice(0, 30);
  for (const cid of candidates) {
    const cust = await customersStmt.byId.get(cid);
    if (cust) push.sendPushToRow(cust, customersStmt, `✨ موعد شاغر الآن مع ${booking.expertName}`, `${dateLabel} — ${booking.time}`, url);
  }
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

/* ================= push notifications ================= */
app.get('/api/push/vapid-public-key', ar(async (req, res) => {
  res.json({ publicKey: push.publicKey, enabled: push.enabled });
}));

app.post('/api/push/subscribe', requireAuth('customer', 'expert'), ar(async (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'invalid_subscription' });
  const stmt = req.auth.role === 'customer' ? customersStmt : expertsStmt;
  const row = await stmt.byId.get(req.auth.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const existing = (row.pushSubscriptions || []).filter((s) => s.endpoint !== subscription.endpoint);
  existing.push(subscription);
  await stmt.updatePushSubscriptions.run(existing, row.id);
  res.json({ ok: true });
}));

app.post('/api/push/unsubscribe', requireAuth('customer', 'expert'), ar(async (req, res) => {
  const { endpoint } = req.body || {};
  const stmt = req.auth.role === 'customer' ? customersStmt : expertsStmt;
  const row = await stmt.byId.get(req.auth.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const remaining = (row.pushSubscriptions || []).filter((s) => s.endpoint !== endpoint);
  await stmt.updatePushSubscriptions.run(remaining, row.id);
  res.json({ ok: true });
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

  if (body.newPassword !== undefined) {
    if (!bcrypt.compareSync(body.currentPassword || '', current.password_hash)) {
      return res.status(401).json({ error: 'wrong_current_password' });
    }
    if (!body.newPassword || String(body.newPassword).length < 4) {
      return res.status(400).json({ error: 'weak_password' });
    }
    await customersStmt.updatePassword.run(bcrypt.hashSync(body.newPassword, 10), current.id);
  }

  const name = body.name !== undefined ? String(body.name).trim() : current.name;
  const phone = body.phone !== undefined ? String(body.phone).trim() : current.phone;
  const address = body.address !== undefined ? String(body.address).trim() : current.address;
  const favorites = body.favorites !== undefined ? body.favorites : current.favorites;
  const favoriteExperts = body.favoriteExperts !== undefined ? body.favoriteExperts : current.favoriteExperts;
  if (phone !== current.phone) {
    const clash = await customersStmt.byPhone.get(phone);
    if (clash && clash.id !== current.id) return res.status(409).json({ error: 'phone_taken' });
  }
  await db.query(
    'UPDATE customers SET name=$1, phone=$2, favorites=$3, "favoriteExperts"=$4, address=$5 WHERE id=$6',
    [name, phone, j(favorites), j(favoriteExperts), address, current.id]
  );
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

  // Center-run service discounts apply automatically whenever one matches —
  // the customer doesn't have to enter a code, and the price shown while
  // booking is exactly what she pays.
  let originalPrice = null;
  if (price != null && body.mode !== 'package') {
    const offer = await offersStmt.activeFor.get(center.id, department, service);
    if (offer) {
      originalPrice = price;
      price = round2(price * (1 - offer.discountPercent / 100));
    }
  }

  // Loyalty wallet redemption: opt-in, capped by her balance and by the
  // booking price (10 points = 1 LYD, spent in whole-LYD blocks so the
  // resulting price is never fractional-point weird).
  let walletPointsRedeemed = 0;
  if (body.useWalletPoints && price != null && price > 0) {
    const cust = await customersStmt.byId.get(req.auth.id);
    const balance = cust ? (cust.walletPoints || 0) : 0;
    const maxRedeemable = Math.min(balance, Math.floor(price) * POINTS_PER_LYD);
    walletPointsRedeemed = maxRedeemable - (maxRedeemable % POINTS_PER_LYD);
    if (walletPointsRedeemed > 0) {
      if (originalPrice == null) originalPrice = price;
      price = round2(price - walletPointsRedeemed / POINTS_PER_LYD);
      await customersStmt.updateWalletPoints.run(balance - walletPointsRedeemed, cust.id);
    }
  }

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
    declineReason: null, alternatives: [],
    originalPrice, walletPointsRedeemed
  };
  await bookingsStmt.insert.run(row);
  res.json(bookingPublic(await bookingsStmt.byId.get(row.id)));

  if (row.expertId) {
    const ex = await getExpert(row.expertId);
    if (ex) push.sendPushToRow(ex, expertsStmt, 'طلب حجز جديد 🔔', `${row.customerName} — ${row.service} في ${row.date}`);
  }
}));

app.post('/api/reviews', requireAuth('customer'), ar(async (req, res) => {
  const { bookingId, expertRating, qualityRating, punctualityRating, treatmentRating, resultRating, comment } = req.body || {};
  const booking = bookingId && await bookingsStmt.byId.get(bookingId);
  if (!booking || booking.customerId !== req.auth.id) return res.status(404).json({ error: 'booking_not_found' });
  if (booking.status !== 'completed') return res.status(400).json({ error: 'booking_not_completed' });
  if ((await reviewsStmt.byBooking.all(bookingId)).length) return res.status(409).json({ error: 'already_reviewed' });

  const criteria = { expertRating, qualityRating, punctualityRating, treatmentRating, resultRating };
  const parsed = {};
  for (const key of Object.keys(criteria)) {
    const n = parseInt(criteria[key], 10);
    if (!(n >= 1 && n <= 5)) return res.status(400).json({ error: 'invalid_rating' });
    parsed[key] = n;
  }
  const overall = Math.round((parsed.expertRating + parsed.qualityRating + parsed.punctualityRating + parsed.treatmentRating + parsed.resultRating) / 5);

  const row = {
    id: uid('r'), bookingId, centerId: booking.centerId, expertId: booking.expertId,
    customerId: req.auth.id, customerName: booking.customerName, rating: overall,
    expertRating: parsed.expertRating, qualityRating: parsed.qualityRating,
    punctualityRating: parsed.punctualityRating, treatmentRating: parsed.treatmentRating, resultRating: parsed.resultRating,
    comment: (comment || '').trim(), createdAt: new Date().toISOString()
  };
  await reviewsStmt.insert.run(row);
  await recomputeCenterRating(booking.centerId);
  await recomputeExpertRating(booking.expertId);
  awardPoints(req.auth.id, 15);
  res.json(row);
}));

/* ================= offers (center-run service discounts) ================= */
app.get('/api/offers', ar(async (req, res) => {
  res.json(await offersStmt.active.all());
}));

app.get('/api/offers/center-mine', requireAuth('center'), ar(async (req, res) => {
  res.json(await offersStmt.byCenter.all(req.auth.centerId));
}));

app.post('/api/offers', requireAuth('center'), ar(async (req, res) => {
  const { department, service, discountPercent, note, expiresAt } = req.body || {};
  const center = await getCenter(req.auth.centerId);
  if (!center) return res.status(404).json({ error: 'not_found' });
  if (!department || !center.departments.includes(department)) return res.status(400).json({ error: 'invalid_department' });
  if (!service || typeof service !== 'string' || !service.trim()) return res.status(400).json({ error: 'invalid_service' });
  const pct = parseInt(discountPercent, 10);
  if (!(pct >= 1 && pct <= 90)) return res.status(400).json({ error: 'invalid_discount' });

  const row = {
    id: uid('off'), centerId: center.id, centerName: center.name,
    department, service: service.trim(), discountPercent: pct,
    note: (note || '').trim() || null, expiresAt: expiresAt || null,
    createdAt: new Date().toISOString()
  };
  await offersStmt.insert.run(row);
  res.json(row);
}));

app.delete('/api/offers/:id', requireAuth('center'), ar(async (req, res) => {
  const offer = await offersStmt.byId.get(req.params.id);
  if (!offer) return res.status(404).json({ error: 'not_found' });
  if (offer.centerId !== req.auth.centerId) return res.status(403).json({ error: 'forbidden' });
  await offersStmt.delete.run(offer.id);
  res.json({ ok: true });
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
    await setStatus('cancelled');
    refundPoints(booking);
    notifyWaitlistOfOpenSlot(booking);
    return;
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
      await setStatus('declined', { declineReason, alternatives: j(alternatives || []) });
      refundPoints(booking);
      const decCust = await customersStmt.byId.get(booking.customerId);
      if (decCust) push.sendPushToRow(decCust, customersStmt, 'لم يُقبل حجزك ❌', `${booking.service} — ${declineReason}`);
      return;
    }
    await setStatus(status);
    if (status === 'confirmed') {
      const confCust = await customersStmt.byId.get(booking.customerId);
      if (confCust) push.sendPushToRow(confCust, customersStmt, 'تم تأكيد حجزك ✅', `${booking.service} — ${booking.centerName} الساعة ${booking.time}`);
    }
    if (status === 'cancelled') { refundPoints(booking); notifyWaitlistOfOpenSlot(booking); }
    if (status === 'completed') awardPoints(booking.customerId, 10);
    return;
  }

  if (role === 'center') {
    if (booking.centerId !== req.auth.centerId) return res.status(403).json({ error: 'forbidden' });
    if (status !== 'cancelled') return res.status(400).json({ error: 'invalid_transition' });
    await setStatus('cancelled');
    refundPoints(booking);
    notifyWaitlistOfOpenSlot(booking);
    return;
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
  if (b.gallery !== undefined && !isValidPhotoList(b.gallery, 24)) return res.status(400).json({ error: 'invalid_gallery' });
  const merged = {
    name: b.name !== undefined ? b.name : current.name,
    city: b.city !== undefined ? b.city : current.city,
    location: b.location !== undefined ? b.location : current.location,
    about: b.about !== undefined ? b.about : current.about,
    departments: b.departments !== undefined ? b.departments : current.departments,
    paymentMethods: b.paymentMethods !== undefined ? b.paymentMethods : current.paymentMethods,
    gallery: b.gallery !== undefined ? b.gallery : current.gallery
  };
  await db.query(
    'UPDATE centers SET name=$1, city=$2, location=$3, about=$4, departments=$5, "paymentMethods"=$6, gallery=$7 WHERE id=$8',
    [merged.name, merged.city, merged.location, merged.about, j(merged.departments), j(merged.paymentMethods), j(merged.gallery), current.id]
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

app.post('/api/experts/:id/reset-password', requireAuth('center'), ar(async (req, res) => {
  const ex = await getExpert(req.params.id);
  if (!ex || ex.centerId !== req.auth.centerId) return res.status(404).json({ error: 'not_found' });
  const password = genTempPassword();
  await expertsStmt.updatePassword.run(bcrypt.hashSync(password, 10), ex.id);
  res.json({ password });
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
  if (b.portfolio !== undefined) {
    const categories = Object.keys(b.portfolio || {});
    const validShape = b.portfolio && typeof b.portfolio === 'object' && !Array.isArray(b.portfolio) &&
      categories.length <= 10 &&
      categories.every((k) => typeof k === 'string' && k.length > 0 && k.length <= 30 && isValidPhotoList(b.portfolio[k], 12));
    if (!validShape) return res.status(400).json({ error: 'invalid_portfolio' });
  }
  const merged = {
    available: b.available !== undefined ? !!b.available : !!current.available,
    homeService: b.homeService !== undefined ? !!b.homeService : !!current.homeService,
    servicePrices: b.servicePrices !== undefined ? b.servicePrices : current.servicePrices,
    serviceDurations: b.serviceDurations !== undefined ? b.serviceDurations : current.serviceDurations,
    workingHours: b.workingHours !== undefined ? b.workingHours : current.workingHours,
    leaveRequests: b.leaveRequests !== undefined ? b.leaveRequests : current.leaveRequests,
    clientNotes: b.clientNotes !== undefined ? b.clientNotes : current.clientNotes,
    portfolio: b.portfolio !== undefined ? b.portfolio : current.portfolio
  };
  await db.query(
    'UPDATE experts SET available=$1, "homeService"=$2, "servicePrices"=$3, "serviceDurations"=$4, "workingHours"=$5, "leaveRequests"=$6, "clientNotes"=$7, portfolio=$8 WHERE id=$9',
    [merged.available, merged.homeService, j(merged.servicePrices), j(merged.serviceDurations), j(merged.workingHours), j(merged.leaveRequests), j(merged.clientNotes), j(merged.portfolio), current.id]
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

app.post('/api/centers/:id/reset-password', requireAuth('admin'), ar(async (req, res) => {
  const c = await getCenter(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found' });
  const password = genTempPassword();
  await centersStmt.updatePassword.run(bcrypt.hashSync(password, 10), c.id);
  res.json({ password });
}));

app.post('/api/customers/:id/reset-password', requireAuth('admin'), ar(async (req, res) => {
  const cust = await customersStmt.byId.get(req.params.id);
  if (!cust) return res.status(404).json({ error: 'not_found' });
  const password = genTempPassword();
  await customersStmt.updatePassword.run(bcrypt.hashSync(password, 10), cust.id);
  res.json({ password });
}));

/* ================= rebooking reminders ================= */
/* "Time for your next appointment" nudge — a customer who hasn't rebooked
   with the same expert 3-4 weeks after a completed visit gets a push
   suggesting she rebook the same service, instead of the app just waiting
   for her to think of it herself. Runs as a periodic scan rather than a
   per-booking timer since Render's free tier can sleep between requests
   anyway, so anything scheduled precisely could be missed; a scan on every
   wake (plus every few hours while awake) catches up regardless. */
const REBOOK_REMINDER_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function runRebookReminderScan() {
  let due;
  try {
    due = await bookingsStmt.dueForRebookReminder.all();
  } catch (e) {
    console.error('[rebook-reminder] scan failed:', e.message);
    return;
  }
  for (const b of due) {
    const cust = await customersStmt.byId.get(b.customerId);
    if (cust) {
      const url = `/glowspot-customer.html?rebook=${encodeURIComponent(b.expertId)}`;
      push.sendPushToRow(cust, customersStmt, `حان وقت موعدك القادم مع ${b.expertName} 💗`, `آخر خدمة: ${b.service} — هل تريدين حجز نفس الخدمة؟`, url);
    }
    await bookingsStmt.markRebookReminderSent.run(b.id);
  }
}

/* ================= static apps ================= */
app.use(express.static(path.join(__dirname, '..', 'apps')));

/* ================= error handling ================= */
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error' });
});

dbReady
  .then(() => migrateToNeon().catch((err) => console.error('[migrate-to-neon] failed:', err.message)))
  .then(() => {
    app.listen(PORT, () => {
      console.log(`GlowSpot server running on http://localhost:${PORT}`);
      console.log(`Apps served from http://localhost:${PORT}/glowspot-customer.html (and dashboard/staff/admin)`);
    });
    runRebookReminderScan().catch((e) => console.error('[rebook-reminder] initial scan failed:', e.message));
    setInterval(() => {
      runRebookReminderScan().catch((e) => console.error('[rebook-reminder] scan failed:', e.message));
    }, REBOOK_REMINDER_INTERVAL_MS);
  })
  .catch((err) => {
    console.error('Failed to initialize the database:', err);
    process.exit(1);
  });
