# GlowSpot server (MVP backend)

A real backend for the 4 GlowSpot apps: persistent storage (SQLite), hashed
passwords (bcrypt — never sent to the browser), signed session tokens (JWT),
and server-side validation for every write (ownership checks, booking
conflict detection, price/duration derived from the expert's own profile
rather than trusted from the client).

## Run it

```bash
cd server
npm install
npm start
```

The server prints its URL (default `http://localhost:3000`) and serves the
4 apps directly from `../apps`, so open:

- `http://localhost:3000/glowspot-customer.html`
- `http://localhost:3000/glowspot-dashboard.html`
- `http://localhost:3000/glowspot-staff.html`
- `http://localhost:3000/glowspot-admin.html`

Opening the apps this way (through the server, not as local files) matters:
they call the API with relative paths like `/api/centers`, which only
resolve correctly when the page itself was served from the same origin as
the API.

A SQLite database file (`glowspot.db`) is created next to `server.js` on
first run, seeded with the same demo centers/experts/packages as before —
same demo logins as always (see the top-level README).

## Configuration

Copy `.env.example` to `.env` (or just export the variables) before
deploying anywhere other than your own machine:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `GLOWSPOT_JWT_SECRET` | an insecure built-in default | Signs session tokens — **set a real random value before deploying** |
| `GLOWSPOT_ADMIN_PASSWORD` | `glowspot2026` | Admin login password |
| `GLOWSPOT_DB_PATH` | `./glowspot.db` | Where the SQLite file lives |

## What's actually real here vs. still a prototype

**Real:** persistence survives a browser refresh or a different device;
passwords are hashed and never leave the server; every write is
authorization-checked server-side (a center can only edit its own data, a
customer can only cancel their own booking, etc.); booking slot conflicts
are re-validated on the server, not just in the browser; a service's price
comes from the expert's own stored price, not from whatever the client
happened to send.

**Still not production-grade:** SQLite (fine for an MVP's traffic, would
want Postgres/managed DB before scaling), no rate limiting or email/SMS
verification on signup, no real payment integration, no push notifications,
single-process (no horizontal scaling story yet). See the top-level
README's "غير منفّذ بعد" section for the rest.

## API surface

Public (no auth): `GET /api/centers`, `/api/experts`, `/api/packages`,
`/api/reviews`, `/api/bookings/busy` (non-PII, for slot-conflict UI),
`POST /api/centers/:id/view`.

Auth: `POST /api/auth/{customer/signup, customer/login, center/login,
expert/login, admin/login}`.

Role-scoped (`Authorization: Bearer <token>`): customer
(`/api/customers/me`, `/api/bookings/mine`, `POST /api/bookings`,
`POST /api/reviews`), center (`/api/bookings/center-mine`,
`PATCH /api/centers/:id`, expert/package CRUD), expert
(`/api/bookings/expert-mine`, `PATCH /api/experts/:id`), admin
(`/api/customers`, `/api/bookings`, center creation/approval).

`PATCH /api/bookings/:id` is shared across roles — the server decides which
status transitions each role may make on a given booking.
