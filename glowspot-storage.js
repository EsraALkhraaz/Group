/* GlowSpot — shared data layer (localStorage) used by all 4 apps */
(function (global) {
  'use strict';

  var KEYS = {
    centers: 'glowspot_centers',
    experts: 'glowspot_experts',
    bookings: 'glowspot_bookings',
    customers: 'glowspot_customers',
    packages: 'glowspot_packages',
    reviews: 'glowspot_reviews',
    session: 'glowspot_session',
    seeded: 'glowspot_seeded_v1'
  };

  var DEPARTMENTS = [
    { id: 'hair', name: 'شعر' },
    { id: 'makeup', name: 'مكياج' },
    { id: 'nails', name: 'أظافر' },
    { id: 'henna', name: 'حنة' },
    { id: 'spa', name: 'سبا' },
    { id: 'steam', name: 'حمام بخار' },
    { id: 'beauty', name: 'عناية وجمال' },
    { id: 'cupping', name: 'حجامة' }
  ];

  function deptName(id) {
    var d = DEPARTMENTS.filter(function (x) { return x.id === id; })[0];
    return d ? d.name : id;
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function getAll(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.error('storage read error', key, e);
      return [];
    }
  }

  function saveAll(key, arr) {
    localStorage.setItem(key, JSON.stringify(arr));
  }

  function getById(key, id) {
    return getAll(key).filter(function (x) { return x.id === id; })[0] || null;
  }

  function add(key, obj) {
    if (!obj.id) obj.id = uid(key.replace('glowspot_', ''));
    var arr = getAll(key);
    arr.push(obj);
    saveAll(key, arr);
    return obj;
  }

  function update(key, id, patch) {
    var arr = getAll(key);
    var idx = arr.findIndex(function (x) { return x.id === id; });
    if (idx === -1) return null;
    arr[idx] = Object.assign({}, arr[idx], patch);
    saveAll(key, arr);
    return arr[idx];
  }

  function remove(key, id) {
    var arr = getAll(key).filter(function (x) { return x.id !== id; });
    saveAll(key, arr);
  }

  /* ---------- session ----------
     Each of the 4 apps shares this origin's localStorage, so sessions are
     namespaced per role (glowspot_session_<role>) to avoid one app's login
     overwriting another's when both are open in the same browser. */
  function sessionKey(role) { return KEYS.session + '_' + role; }
  function setSession(session) {
    localStorage.setItem(sessionKey(session.role), JSON.stringify(session));
  }
  function getSession(role) {
    try {
      var raw = localStorage.getItem(sessionKey(role));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearSession(role) {
    localStorage.removeItem(sessionKey(role));
  }

  /* ---------- time helpers ---------- */
  function toMinutes(hhmm) {
    var p = hhmm.split(':');
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }
  function toHHMM(mins) {
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    return (h < 10 ? '0' + h : '' + h) + ':' + (m < 10 ? '0' + m : '' + m);
  }

  /* Generate available slots for an expert on a given date & duration,
     splitting the working window by the actual service duration and
     excluding intervals that overlap an existing (non declined/cancelled) booking. */
  function generateSlots(expert, date, durationMinutes) {
    var dow = new Date(date + 'T00:00:00').getDay(); // 0=Sun..6=Sat
    var wh = (expert.workingHours || {})[dow];
    if (!wh || !wh.start || !wh.end) return [];

    var onLeave = (expert.leaveRequests || []).some(function (lr) {
      return lr.status === 'approved' && date >= lr.from && date <= lr.to;
    });
    if (onLeave) return [];

    var startM = toMinutes(wh.start);
    var endM = toMinutes(wh.end);
    var breakStart = wh.breakStart ? toMinutes(wh.breakStart) : null;
    var breakEnd = wh.breakEnd ? toMinutes(wh.breakEnd) : null;

    var existing = getAll(KEYS.bookings).filter(function (b) {
      return b.expertId === expert.id && b.date === date &&
        ['pending', 'confirmed', 'in_service'].indexOf(b.status) !== -1;
    }).map(function (b) {
      var s = toMinutes(b.time);
      return { start: s, end: s + (b.duration || durationMinutes) };
    });

    function overlaps(s, e) {
      return existing.some(function (iv) { return s < iv.end && e > iv.start; });
    }
    function inBreak(s, e) {
      if (breakStart == null) return false;
      return s < breakEnd && e > breakStart;
    }

    var slots = [];
    var now = new Date();
    var isToday = date === now.toISOString().slice(0, 10);
    var nowM = now.getHours() * 60 + now.getMinutes();

    for (var t = startM; t + durationMinutes <= endM; t += durationMinutes) {
      var s = t, e = t + durationMinutes;
      if (inBreak(s, e)) continue;
      if (overlaps(s, e)) continue;
      if (isToday && s <= nowM) continue;
      slots.push(toHHMM(s));
    }
    return slots;
  }

  function bookingOverlapsExisting(expertId, date, time, duration, ignoreBookingId) {
    var s = toMinutes(time), e = s + duration;
    return getAll(KEYS.bookings).some(function (b) {
      if (b.id === ignoreBookingId) return false;
      if (b.expertId !== expertId || b.date !== date) return false;
      if (['pending', 'confirmed', 'in_service'].indexOf(b.status) === -1) return false;
      var bs = toMinutes(b.time), be = bs + (b.duration || duration);
      return s < be && e > bs;
    });
  }

  /* ---------- seed data ---------- */
  function seed() {
    if (localStorage.getItem(KEYS.seeded)) return;

    var centerId = uid('center');
    var center = {
      id: centerId,
      name: 'GlowSpot - مركز اللمسة الذهبية',
      city: 'عمّان',
      location: 'شارع الرقيم، عمّان',
      about: 'مركز متكامل للعناية والجمال يقدم أفضل خدمات الشعر والمكياج والعناية بالبشرة.',
      verified: true,
      rating: 4.7,
      status: 'approved',
      departments: ['hair', 'makeup', 'nails', 'henna', 'spa', 'beauty'],
      username: 'glowbeauty',
      password: 'center123',
      paymentMethods: {
        hair: 'both', makeup: 'both', nails: 'cash', henna: 'cash', spa: 'both', beauty: 'both'
      },
      homeService: true,
      views: 128
    };

    var expert1Id = uid('expert');
    var expert1 = {
      id: expert1Id,
      centerId: centerId,
      department: 'hair',
      name: 'سارة العلي',
      specialty: 'تصفيف وقص الشعر',
      rating: 4.8,
      available: true,
      phone: '0920000001',
      password: 'expert123',
      servicePrices: { 'قص شعر': 15, 'صبغة شعر': 35, 'تسريحة سهرة': 40 },
      serviceDurations: { 'قص شعر': 45, 'صبغة شعر': 90, 'تسريحة سهرة': 60 },
      workingHours: {
        0: { start: '10:00', end: '18:00', breakStart: '14:00', breakEnd: '14:30' },
        1: { start: '10:00', end: '18:00', breakStart: '14:00', breakEnd: '14:30' },
        2: { start: '10:00', end: '18:00', breakStart: '14:00', breakEnd: '14:30' },
        3: { start: '10:00', end: '18:00', breakStart: '14:00', breakEnd: '14:30' },
        4: { start: '10:00', end: '18:00', breakStart: '14:00', breakEnd: '14:30' },
        6: { start: '12:00', end: '20:00' }
      },
      leaveRequests: [],
      clientNotes: {}
    };

    var expert2Id = uid('expert');
    var expert2 = {
      id: expert2Id,
      centerId: centerId,
      department: 'makeup',
      name: 'لينا حماد',
      specialty: 'مكياج سهرات وأعراس',
      rating: 4.9,
      available: true,
      phone: '0920000002',
      password: 'expert123',
      servicePrices: { 'مكياج سهرة': 30, 'مكياج عروس': 80 },
      serviceDurations: { 'مكياج سهرة': 60, 'مكياج عروس': 120 },
      workingHours: {
        0: { start: '11:00', end: '19:00' },
        1: { start: '11:00', end: '19:00' },
        2: { start: '11:00', end: '19:00' },
        3: { start: '11:00', end: '19:00' },
        4: { start: '11:00', end: '19:00' }
      },
      leaveRequests: [],
      clientNotes: {}
    };

    var pkg = {
      id: uid('package'),
      centerId: centerId,
      name: 'باقة العروس الذهبية',
      items: ['مكياج عروس', 'تسريحة سهرة', 'عناية بالبشرة'],
      price: 140
    };

    var customerId = uid('customer');
    var customer = {
      id: customerId,
      name: 'ريم الزعبي',
      phone: '0790000001',
      password: '123456',
      favorites: [centerId],
      favoriteExperts: [expert1Id]
    };

    saveAll(KEYS.centers, [center]);
    saveAll(KEYS.experts, [expert1, expert2]);
    saveAll(KEYS.packages, [pkg]);
    saveAll(KEYS.customers, [customer]);
    saveAll(KEYS.bookings, []);
    saveAll(KEYS.reviews, []);

    localStorage.setItem(KEYS.seeded, '1');
  }

  seed();

  global.storage = {
    KEYS: KEYS,
    DEPARTMENTS: DEPARTMENTS,
    deptName: deptName,
    uid: uid,
    getAll: getAll,
    saveAll: saveAll,
    getById: getById,
    add: add,
    update: update,
    remove: remove,
    setSession: setSession,
    getSession: getSession,
    clearSession: clearSession,
    toMinutes: toMinutes,
    toHHMM: toHHMM,
    generateSlots: generateSlots,
    bookingOverlapsExisting: bookingOverlapsExisting
  };
})(window);
