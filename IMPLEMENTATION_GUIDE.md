# Compass — Implementation & Hosting Roadmap

This is a working roadmap for taking Compass from "runs on my laptop" to a
hardened, hosted product. It's organized in phases, roughly in the order
you'd want to tackle them — but each phase is self-contained, so skip ahead
if one doesn't apply to you yet.

Every phase explains **why** the step matters, not just what to run, because
half of these decisions (SQLite vs. Postgres, sessions vs. JWT, Render vs.
Fly) depend on judgment calls specific to how big this needs to get.

## Current state (snapshot)

Worth reading before the phases below, so the recommendations make sense:

- **Frontend**: React + TypeScript, built with Vite. No router library —
  navigation is state-based in [`App.tsx`](frontend/src/App.tsx). No CSS
  framework; hand-written [`global.css`](frontend/src/styles/global.css).
- **Backend**: Express (CommonJS) in [`server.js`](backend/server.js), one
  file, ~20 REST endpoints. No auth of any kind — any client can read or
  write any student ID.
- **Data**: SQLite via Node's built-in `node:sqlite` driver
  ([`backend/store/db.js`](backend/store/db.js)), a single file at
  `backend/data/compass.db`. Universities and scholarships are static JSON.
- **LLM**: Claude or OpenAI via [`llmService.js`](backend/services/llmService.js),
  with an offline keyword-fallback so the app works with zero API keys.
- **Tests**: Jest, backend only, covering the engines, data integrity, and
  API routes. No frontend tests. No CI — tests only run when someone
  remembers to type `npm test`.
- **Secrets**: `backend/.env` holds `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.
  It's gitignored, but there's no `.env.example` for a new clone to copy.

The two things that matter most for "should I host this today": **there is
no authentication**, and **SQLite is a single file on local disk**, which
most serverless hosts don't let you keep. Phases 1–3 exist to fix exactly
those two things before Phase 8 puts this in front of real users.

---

## Phase 0 — Repo hygiene (do this first, ~15 minutes)

Quick fixes that cost little and prevent future pain.

### 0.1 Add `backend/.env.example`

The README already tells new contributors to run `cp .env.example .env`,
but that file doesn't exist yet — anyone following the README literally hits
an error on the first command. Create it:

```
# Copy to .env and fill in ONE of these to enable the live chatbot.
# Claude wins if both are present. Leave both blank to run offline.
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

PORT=4000
```

### 0.2 Pin Node's version

`node:sqlite` is a relatively new built-in (stable since Node 22.5, and the
API shifted slightly across versions before that). Add an `.nvmrc` and an
`engines` field so "works on my machine" doesn't become "works on my Node
version":

```json
// backend/package.json — add
"engines": { "node": ">=22.5.0" }
```

```
// .nvmrc at repo root
22
```

### 0.3 Add a root-level `package.json` with workspace scripts (optional but convenient)

Right now starting the app means two terminals and two `cd`s. A tiny root
script removes that friction without restructuring anything:

```json
{
  "name": "compass",
  "private": true,
  "scripts": {
    "install:all": "npm install --prefix backend && npm install --prefix frontend",
    "dev:backend": "npm run dev --prefix backend",
    "dev:frontend": "npm run dev --prefix frontend",
    "dev": "concurrently -n backend,frontend -c blue,green \"npm:dev:backend\" \"npm:dev:frontend\""
  },
  "devDependencies": { "concurrently": "^9.0.0" }
}
```

This is purely a developer-experience change — it doesn't touch either app.

---

## Phase 1 — Security hardening before anything is public

Everything here is about the gap between "safe on localhost" and "safe on
the internet."

### 1.1 Lock down CORS

`server.js` currently calls `app.use(cors())` with no options, which
reflects `Access-Control-Allow-Origin` for *any* origin. That's fine while
frontend and backend are both `localhost`, but once this is hosted, any
website in the world can call your API from a user's browser using their
CORS-exempt requests. Restrict it to your real frontend origin:

```js
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173").split(",");
app.use(cors({ origin: allowedOrigins }));
```

Set `CORS_ORIGIN=https://compass.yourdomain.com` in production.

### 1.2 Add security headers with `helmet`

Express sends no hardening headers by default (no `X-Content-Type-Options`,
no `Content-Security-Policy`, etc.). One dependency, one line:

```bash
npm install --prefix backend helmet
```

```js
const helmet = require("helmet");
app.use(helmet());
```

### 1.3 Rate-limit more than just `/api/chat`

There's already a `chatLimiter` guarding the LLM endpoint (the expensive,
abusable one). Everything else — including the write endpoints
(`POST/PUT/DELETE`) — has no limit at all, so a script can hammer
`/api/students` or spam applications/notes with no friction. Add a lighter,
global limiter in front of everything, and keep the stricter one on `/chat`:

```js
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300, // generous — this catches abuse, not normal use
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);
```

### 1.4 Cap request body size

`express.json()` defaults to a 100kb limit, which is already reasonable, but
make it explicit so a future change to the default doesn't silently loosen
it:

```js
app.use(express.json({ limit: "100kb" }));
```

### 1.5 Don't leak stack traces

The error handler in `server.js` already avoids sending `err.stack` to the
client — keep that discipline as you add routes. Log the full error
server-side (`console.error(err)`), send only `{ error: "..." }` to the
client.

### 1.6 Validate the `.env` on boot

If `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is present but malformed (e.g.
someone pastes a truncated key), the app should fail loudly at startup, not
mysteriously 500 on the first chat message. A short check in
`llmService.js`'s init path, logging a clear warning, is enough — this
doesn't need a full config-validation library like `envalid` at this size.

---

## Phase 2 — Accounts & authentication

This is the biggest structural gap. Right now `GET /api/students/:id` (and
every route under it — notes, applications, chat) takes whatever `:id` a
client sends, no ownership check at all. Locally that's fine: one browser,
one student. Hosted, it means any visitor can read or delete any other
student's profile, notes, and application list just by guessing or
incrementing an ID.

The good news, per the README's own notes: **the schema is already keyed by
student ID**, so this is additive, not a rewrite.

### 2.1 Add a `users` table

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Add this to the schema block in [`db.js`](backend/store/db.js) the same way
the existing tables are defined there.

### 2.2 Link students to users

Add `user_id INTEGER REFERENCES users(id)` to the `students` table (or
wherever the student profile row lives in `dataStore.js`). One user can have
one profile for now — a `UNIQUE` constraint on `user_id` enforces that
without any application-level checking.

### 2.3 Password handling

Use `bcrypt` (or `argon2`, slightly stronger but one more native
dependency) — never store or compare raw passwords:

```bash
npm install --prefix backend bcrypt
```

```js
const bcrypt = require("bcrypt");
const hash = await bcrypt.hash(password, 12);
const ok = await bcrypt.compare(password, hash);
```

### 2.4 Sessions vs. JWT — use sessions

For a single-server app like this (no separate API gateway, no mobile
client planned), **cookie-based sessions beat JWTs**: they can be revoked
server-side instantly (log out = delete the session row), they don't need
a refresh-token dance, and the browser handles storage safely via
`httpOnly` cookies instead of you managing `localStorage` (which is
readable by any injected script — a real risk if a dependency is ever
compromised).

```bash
npm install --prefix backend express-session connect-sqlite3
```

```js
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);

app.use(session({
  store: new SQLiteStore({ db: "sessions.db", dir: "./data" }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production", // requires HTTPS
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));
```

Generate `SESSION_SECRET` once with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
and store it in `.env` — never hardcode it.

### 2.5 Auth routes

```
POST /api/auth/signup   { email, password }  → creates user + empty session
POST /api/auth/login    { email, password }  → sets session
POST /api/auth/logout                        → destroys session
GET  /api/auth/me                            → current user + their student id
```

### 2.6 Protect the existing routes

Add one middleware, then apply it to every `/api/students/:id/*` route:

```js
function requireOwner(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not signed in" });
  const student = store.getStudentByUserId(req.session.userId);
  if (!student || student.id !== req.params.id) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}
```

This is a bigger diff than it looks — every route handler currently takes
`req.params.id` on faith. Budget real time for this phase and write tests
for the 401/403 paths specifically (a route that silently drops its auth
check on a future edit is the single most common regression in apps like
this).

### 2.7 Frontend: login/signup screens + session-aware fetch

`api.ts` currently sends no credentials. Once sessions are in place, every
`fetch` needs `credentials: "include"`, and the app needs a top-level
"logged out" state that shows a login form instead of the profile/dashboard
flow. This is the natural point to introduce a router (see 6.1) rather than
bolting more state branches onto `App.tsx`.

---

## Phase 3 — Data layer for production

### 3.1 SQLite is fine — for one instance

Keep `node:sqlite`. It's not a toy: it handles this app's write volume
(one student typing notes) without breaking a sweat, and the project's own
memory notes record that Postgres was deliberately rejected because it
forces every store function and caller to become async for no real benefit
at this scale. **Don't move to Postgres just because it "sounds more
production."** Move to it only when one of these becomes true:

- You need more than one backend instance (SQLite's file lock means only
  one process can write at a time — fine for low traffic, a ceiling past
  it).
- You're deploying somewhere with an ephemeral filesystem (see Phase 8 —
  this is the actual forcing function, more often than traffic is).

### 3.2 If you do move to Postgres

The swap point is exactly where the README says: `backend/store/db.js`.
Because `dataStore.js` was deliberately kept synchronous-looking on top of
it, the real cost isn't the driver swap, it's that `pg` is async — every
function in `dataStore.js` and every route in `server.js` that calls it
needs `await`. Do this as one focused pass, not incrementally (a half-sync,
half-async store is a bug factory). Use `node-postgres` (`pg`) directly, or
`Drizzle ORM` if you want migrations and types — for a schema this small,
plain `pg` with hand-written SQL is genuinely less code.

### 3.3 Back up the SQLite file regardless

Wherever this ends up hosted, `compass.db` is the only copy of every
student's data. At minimum:

```bash
# cron or a scheduled task on the host, daily
sqlite3 backend/data/compass.db ".backup /backups/compass-$(date +%F).db"
```

Keep 7–30 days of rotation. If you host on a platform with snapshot backups
of attached volumes (Fly.io, Render disks — see Phase 8), that can replace
this, but confirm it actually includes the data volume, not just the
container image.

### 3.4 Migrations

There's no migration tool today — `db.js` runs `CREATE TABLE IF NOT EXISTS`
statements directly, and the README mentions a one-time manual backfill for
the notes/tracker merge. That's fine at this size, but write every future
schema change as an explicit, idempotent `ALTER TABLE ... IF NOT EXISTS`-style
block in `db.js`, in the order it should run, so a fresh clone and a
three-month-old production database converge to the same schema. If this
grows past a handful of such changes, `node-pg-migrate` (once on Postgres)
or a raw numbered-`.sql`-files approach is worth adopting — don't reach for
a heavy ORM's migration DSL for a database this size.

---

## Phase 4 — Testing & CI

### 4.1 Fill the frontend test gap

Backend has real Jest coverage (engines, data integrity, API routes).
Frontend has none. Add:

```bash
npm install -D --prefix frontend vitest @testing-library/react @testing-library/jest-dom jsdom
```

Priority order — test the parts most likely to break silently, not
everything:
1. `compare.ts`, `dates.ts`, `exportList.ts` — pure functions, cheap to test, easy to regress.
2. `useSchoolNotes.ts` — the shared hook five pages depend on; a bug here is a five-page bug.
3. Component smoke tests (renders, key interactions) for `ProfileForm` and `ApplicationTracker` — the two most stateful screens.

### 4.2 GitHub Actions CI

Nothing currently runs tests automatically — they only run if someone
remembers `npm test`. Add `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: backend/package-lock.json
      - run: npm ci --prefix backend
      - run: npm test --prefix backend

  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci --prefix frontend
      - run: npm run build --prefix frontend
```

The frontend job builds rather than tests (until 4.1 lands) — a broken
`tsc -b` or Vite build is still worth catching before merge.

### 4.3 Branch protection

Once CI is green consistently, turn on "Require status checks to pass"
for `main` in GitHub's branch protection settings. This is the step that
actually makes CI matter — without it, a red check is just a suggestion.

---

## Phase 5 — Observability

Right now, errors go to `console.error` and vanish once the process
restarts. Fine for local dev, not enough once real users hit real bugs
you won't be watching a terminal for.

### 5.1 Structured logging

Swap bare `console.log`/`console.error` for `pino` — cheap, fast, and
gives you JSON logs any hosting platform's log viewer can filter on:

```bash
npm install --prefix backend pino pino-http
```

```js
const pino = require("pino")();
const pinoHttp = require("pino-http")({ logger: pino });
app.use(pinoHttp);
```

### 5.2 Error tracking

Add [Sentry](https://sentry.io) (free tier is enough for this) to both
sides so you find out about a production crash before a user emails you
about it:

```bash
npm install --prefix backend @sentry/node
npm install --prefix frontend @sentry/react
```

Initialize with `SENTRY_DSN` from `.env`, and wrap the Express error
handler / add a React error boundary respectively. Skip this until you
actually have outside users — it's noise before that.

### 5.3 A real health check

`GET /api/health` already exists and reports LLM provider status — extend
it to also confirm the DB is reachable (`SELECT 1`), so a hosting
platform's health-check/auto-restart logic can actually detect a stuck
database connection, not just "the process is alive."

---

## Phase 6 — Frontend polish

### 6.1 Add a router

`App.tsx` currently drives navigation with component state rather than
URLs. That means no shareable/bookmarkable links (e.g. straight to
Scholarships), no back-button support, and it's the thing that'll make
Phase 2's login-gate awkward to bolt on. Introducing `react-router-dom` is
a genuine, non-trivial rewrite of the nav logic — worth doing deliberately,
not as a drive-by edit alongside something else.

### 6.2 Code-split by route

Once routed, wrap each page in `React.lazy` + `Suspense`. `ChatBot`,
`SchoolCompare`, and `ApplicationTracker` are the heaviest screens —
splitting them keeps the first paint (Home + ProfileForm) fast.

### 6.3 SEO & social sharing

`index.html` needs `<meta name="description">`, Open Graph tags
(`og:title`, `og:description`, `og:image`), and a real favicon set (the
project has a `BrandMark.tsx` component to source an icon from). Matters
the moment this has a public URL people might share.

### 6.4 Accessibility audit

The README already claims keyboard-accessible and `prefers-reduced-motion`
-aware — good foundation. Before hosting, run Lighthouse's accessibility
pass and axe DevTools on the five most-used screens (Home, ProfileForm,
Recommendations, Scholarships, ApplicationTracker) and fix anything under
a 95 score. Two things worth checking by hand, since automated tools miss
them: focus order through the multi-step `ProfileForm`, and whether the
`NoteHint` dismissal logic announces itself to a screen reader.

### 6.5 PWA / offline shell (optional)

Given the chatbot already has an offline fallback mode, a service worker
that caches the app shell would let a student reopen Compass with no
connection and still browse their saved schools and notes. Lower priority
— nice-to-have, not a blocker for launch.

---

## Phase 7 — Product roadmap (feature ideas, roughly prioritized)

These extend what's already documented in the README's own short roadmap
section (accounts, Postgres, more scholarships) — Phases 2–3 above cover
those two. Additional ideas, ordered by rough value-to-effort:

1. **Deadline reminder emails** — the timeline and tracker already compute
   what's due when; a daily cron job emailing "3 essays due this week"
   is a thin layer on data that already exists. Needs Phase 2 (an email
   address to send to) first.
2. **Calendar export (.ics)** — same dependency (real deadlines), turns
   the timeline into something a student's phone calendar can remind them
   about natively. Pure client-side generation, no new backend needed.
3. **Essay brainstorm assistant** — a second chatbot mode, scoped to "help
   me brainstorm a Common App essay from my activities/interests," reusing
   `llmService.js`'s existing provider abstraction and offline-fallback
   pattern.
4. **Net price estimator** — the recommendation engine already reasons
   about "financial fit"; a simple net-price-after-aid estimate (sticker
   tuition − typical aid by income bracket, clearly labeled as a rough
   estimate) would deepen that without needing new data sources.
5. **Admissions officer / contact tracker** — a small addition to the
   per-school note (already one row per student+university) — track who
   the student has emailed and when, reusing the existing notes
   infrastructure rather than a new feature area.
6. **Growing the scholarship dataset** — per the README, no free
   scholarship API exists; this stays a curation task (manually adding to
   `scholarships.json`) or a paid data license, not an engineering one.
7. **Parent/counselor view** — a read-only shared link to a student's
   plan. Needs Phase 2's accounts first (something to scope the share to).

---

## Phase 8 — Hosting, step by step

### 8.1 Pick an architecture

Three real options, ordered by how much they fight the current codebase:

**Option A — One host, one process (recommended to start).** Express
serves the built frontend as static files *and* the API, from the same
process, same domain, no CORS to configure at all. This is the smallest
change from what exists today — add one block to `server.js`:

```js
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "../frontend/dist")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "../frontend/dist/index.html"));
  });
}
```
(Place this *after* all `/api/*` routes so it only catches non-API paths.)

**Option B — Split: static frontend on Vercel/Netlify, API on a Node
host.** Better caching/CDN for the frontend, but reintroduces cross-origin
requests (Phase 1.1's CORS allowlist becomes load-bearing, not optional),
and needs `VITE_API_URL` wired through `api.ts` at build time.

**Option C — Fully serverless (Vercel/Netlify functions for the API too).**
Don't do this without finishing Phase 3.2 first. Serverless functions have
no persistent local disk — the SQLite file would reset on every cold
start. This path only makes sense once the data layer is Postgres (e.g.
Neon or Supabase, both have serverless-friendly free tiers).

**Recommendation: start with Option A on a platform that gives you a
persistent disk** — Render or Fly.io, both below. It matches the app as it
exists today (SQLite, single process) and defers the CORS/serverless
complexity until there's an actual reason for it.

### 8.2 Deploying Option A on Render

Render's free/starter tier includes persistent disks, which is the one
non-negotiable requirement here.

1. Push this repo to GitHub if it isn't already.
2. In the Render dashboard: **New → Web Service**, connect the repo.
3. **Build command**:
   ```
   npm install --prefix backend && npm install --prefix frontend && npm run build --prefix frontend
   ```
4. **Start command**: `npm start --prefix backend`
5. **Environment**: add `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`),
   `NODE_ENV=production`, `SESSION_SECRET` (from Phase 2.4), `CORS_ORIGIN`
   (your Render URL, once known).
6. **Disk**: add a persistent disk, mount path `/opt/render/project/src/backend/data`
   (adjust to match wherever `COMPASS_DB` resolves), size 1GB is
   overkill for a SQLite file but it's Render's minimum.
7. Deploy. Render gives you a `https://compass-xxxx.onrender.com` URL with
   HTTPS already handled — nothing to configure there.

### 8.3 Deploying Option A on Fly.io (more control, still simple)

Fly is a better fit if you want the app to live closer to a specific
region or you're comfortable with a Dockerfile.

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY backend ./backend
COPY frontend ./frontend
RUN npm install --prefix backend --omit=dev \
 && npm install --prefix frontend \
 && npm run build --prefix frontend
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "backend/server.js"]
```

```bash
fly launch          # generates fly.toml, asks region/name
fly volumes create compass_data --size 1   # persistent disk for SQLite
```

In `fly.toml`, mount the volume and point `COMPASS_DB` at it:
```toml
[mounts]
  source = "compass_data"
  destination = "/data"
```
```bash
fly secrets set ANTHROPIC_API_KEY=... SESSION_SECRET=... COMPASS_DB=/data/compass.db
fly deploy
```

### 8.4 Domain & HTTPS

Both Render and Fly provision free HTTPS via Let's Encrypt automatically
once you point a custom domain at them (a `CNAME`/`A` record from your
registrar to the value each platform shows you). No manual certificate
handling needed either way — this used to be the hard part of hosting and
now isn't.

### 8.5 Environment variables in production

Full checklist for whichever host you pick:
- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` — leave both unset to run in
  offline-fallback mode if you're not ready to pay for LLM usage yet.
- `NODE_ENV=production`
- `SESSION_SECRET` — generated once, never in git (see 2.4).
- `CORS_ORIGIN` — only needed for Option B/C.
- `COMPASS_DB` — path to the persistent volume's SQLite file.
- `PORT` — most platforms inject this themselves; `server.js` already
  reads `process.env.PORT` with a fallback.

### 8.6 Smoke-test before calling it done

After the first deploy: sign up a test account (once Phase 2 exists),
complete a profile, confirm recommendations render, send one chat message
(confirms the LLM key or fallback works), restart the service from the
host's dashboard, and confirm the data survived the restart. That last
step is the one that actually validates the persistent-disk setup — an
app that "works" but loses data on every deploy is worse than one that
was never hosted.

---

## Phase 9 — Post-launch operations

- **Backups**: automate 3.3's `.backup` command on a schedule (Render/Fly
  both support scheduled jobs; a simple cron on the same box also works
  since traffic is low). Store backups somewhere other than the same
  disk — S3, Backblaze B2, or even a private git repo for something this
  small.
- **Uptime monitoring**: a free tier of UptimeRobot or Better Uptime
  hitting `/api/health` every few minutes, alerting you (not the students)
  when it fails.
- **Cost**: Render/Fly's smallest paid tier (needed for persistent disks
  on Render; Fly's free allowance may cover a hobby volume) runs roughly
  $5–10/month. LLM costs scale with chat usage — the `chatLimiter`
  (30 requests/15min/IP) caps worst-case spend per user; watch actual
  Anthropic/OpenAI usage dashboards for the first few weeks to calibrate
  that ceiling.
- **Scaling trigger**: the real signal to revisit Phase 3.2 (Postgres) is
  concurrent write contention — SQLite serializes writes, so if you ever
  run more than one backend instance (for redundancy or load), that's the
  point it stops being optional.

---

## Suggested order if you're doing this solo

Phase 0 → Phase 1 → Phase 2 (auth) → Phase 8.2 or 8.3 (get *something*
hosted, even before every polish item) → Phase 4 (CI, so the next change
doesn't regress silently) → Phase 5 → Phase 6 → Phase 7, picked off as
time allows. Getting a real, if rough, deployment live early (right after
auth is safe) beats polishing everything locally first — it surfaces
hosting-specific problems (Phase 8.6's data-survives-restart check being
the classic one) while they're still cheap to fix.
