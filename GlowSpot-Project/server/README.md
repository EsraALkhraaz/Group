# GlowSpot server (MVP backend)

A real backend for the 4 GlowSpot apps: persistent storage (PostgreSQL),
hashed passwords (bcrypt — never sent to the browser), signed session
tokens (JWT), and server-side validation for every write (ownership
checks, booking conflict detection, price/duration derived from the
expert's own profile rather than trusted from the client).

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

Needs a Postgres database to run — see the two options below. On first run
it creates its tables and seeds the same demo centers/experts/packages as
before, with the same demo logins as always (see the top-level README).

**Local dev:** point `DATABASE_URL` at any Postgres you have, e.g.:
```bash
createuser glowspot -P   # set password glowspot_dev when prompted
createdb glowspot -O glowspot
DATABASE_URL="postgres://glowspot:glowspot_dev@localhost:5432/glowspot" npm start
```

## Configuration

Copy `.env.example` to `.env` (or just export the variables) before
deploying anywhere other than your own machine:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | — (required) | Postgres connection string |
| `GLOWSPOT_JWT_SECRET` | an insecure built-in default | Signs session tokens — **set a real random value before deploying** |
| `GLOWSPOT_ADMIN_PASSWORD` | `glowspot2026` | Admin login password |

SSL is auto-enabled for any `DATABASE_URL` that isn't `localhost`/`127.0.0.1`
(with `rejectUnauthorized: false`, the usual setting for managed Postgres
providers like Render whose certs aren't in Node's default trust store).

## What's actually real here vs. still a prototype

**Real:** persistence survives a browser refresh or a different device;
passwords are hashed and never leave the server; every write is
authorization-checked server-side (a center can only edit its own data, a
customer can only cancel their own booking, etc.); booking slot conflicts
are re-validated on the server, not just in the browser; a service's price
comes from the expert's own stored price, not from whatever the client
happened to send.

**Still not production-grade:** no rate limiting or email/SMS verification
on signup, no real payment integration, no push notifications, single web
process (no horizontal scaling story yet — the database itself scales fine).
See the top-level README's "غير منفّذ بعد" section for the rest.

## Deploying to Render (free tier)

`render.yaml` in this folder is a ready-made [Render Blueprint](https://render.com/docs/blueprint-spec)
for a free Node web service. The live deployment's `DATABASE_URL` points at
a [Neon](https://neon.tech) Postgres database instead of Render's own managed
Postgres — Neon's free tier has no 30-day expiry, unlike Render's. (Render's
free Postgres offering is still fine for a short testing window; `db.js`
works against either — the only difference is where `DATABASE_URL` points.)
`GLOWSPOT_JWT_SECRET` is auto-generated on deploy. You still need to set
`GLOWSPOT_ADMIN_PASSWORD` yourself in the Render dashboard after the first
deploy (it's marked `sync: false` so it's never committed to git).

The free Render *web service* spins down after 15 minutes idle and takes up
to a minute to wake back up on the next request; a GitHub Actions workflow
(`.github/workflows/glowspot-keepalive.yml`) pings it every 10 minutes to
keep it warm, and the shared API client (`apps/glowspot-api.js`) retries
through any cold start that slips past that instead of failing the request.

`server/migrate-to-neon.js` is the one-time script used to move data from
Render's Postgres to Neon without losing anything that had already been
created live (it copies from `DATABASE_URL` to `NEON_DATABASE_URL` when the
latter is set, and is idempotent — safe to leave wired into `server.js`'s
boot sequence indefinitely).

Cheapest way to change the demo credentials for a real test (e.g. new admin
password, or center/expert passwords) once it's live: use the apps
themselves — the admin panel creates centers with their own password, and
each center sets its experts' initial passwords — rather than editing the
seed data.

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
