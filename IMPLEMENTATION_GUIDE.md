# Compass — Implementation & Hosting Roadmap

This is a working roadmap for taking Compass from "runs on my laptop" to a
hardened, hosted product. **Hosting is deliberately the last phase.** You're
standardizing this project — and your other projects — on **Cloudflare Pages
+ Workers**, and you'd rather finish the app locally and do the Cloudflare
setup once, at the end, than deploy early and iterate in production. The
phases below are ordered around that: everything through Phase 6 is work you
can do entirely on your laptop with `wrangler dev` standing in for the real
platform; Phase 7 is the actual deploy.

Every phase explains **why** the step matters, not just what to run, because
several of these decisions (sessions vs. JWT, D1 vs. an external Postgres,
one Pages project vs. a separate Worker) depend on judgment calls specific to
how big this needs to get.

## Current state (snapshot)

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
  API routes. No frontend tests. No CI.
- **Secrets**: `backend/.env` holds `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.

**Already done (commit `05b8bf2`, "Phase 0-1: repo hygiene and security
hardening")**: `backend/.env.example`, root `package.json` with
`concurrently`-driven dev scripts, `.nvmrc` + `engines` pin, and — on the
current Express server — a CORS allowlist, `helmet`, a global rate limiter,
a stricter `/api/chat` limiter, and an explicit `express.json()` body cap.
That work isn't wasted, but note the twist below: none of those npm packages
run on Cloudflare Workers, so Phase 1 re-does the *decisions* (allowlist
origins, header set, rate-limit thresholds) in a Workers-compatible form
rather than starting security thinking from zero.

**Both blockers below are now cleared.** Authentication landed in Phase 2
(accounts, sessions, and an ownership check on every student route), and the
Hono/D1 migration landed in Phase 1. The original framing is kept for the
reasoning: **no authentication** (Phase 2), and — new concern specific to your
target platform — **Express and `node:sqlite` cannot run on Cloudflare
Workers at all.** Workers execute in V8 isolates, not Node.js: no
filesystem, no native addons, no long-lived process to hold a module-level
database connection or an in-memory session store. That's not a performance
tuning question, it's a hard incompatibility — `node:sqlite` needs a real
filesystem and Express expects Node's `http.Server` request/response
objects, neither of which exist in a Worker. Phase 1 exists to fix exactly
that before Phase 7 puts this on Cloudflare.

---

## Phase 1 — Move the backend onto Cloudflare's runtime: Hono + D1

This is the foundational phase. Almost everything downstream (auth,
security headers, tests) gets written directly against the new stack, so do
this before those, not after.

### 1.1 Why this can't wait until deploy day

It's tempting to build out every feature on Express + `node:sqlite` and
"port it to Cloudflare later." Resist that — the port isn't a config change,
it's a rewrite of the data-access layer and the route layer, and the longer
you build on the old stack the more surface area that rewrite has to cover.
Doing it now, while the backend is one ~500-line file, is the cheapest this
migration will ever be.

### 1.2 Swap Express for Hono

[Hono](https://hono.dev) is a small, fast router built for edge runtimes
(Workers, Deno, Bun), with an Express-like middleware API and first-party
Cloudflare support — it's what Cloudflare's own docs use. The route shape
barely changes:

```js
// Before (Express)
app.get("/api/students/:id", (req, res) => {
  const student = store.getStudent(req.params.id);
  if (!student) return res.status(404).json({ error: "Not found" });
  res.json(student);
});

// After (Hono)
app.get("/api/students/:id", async (c) => {
  const student = await store(c.env.DB).getStudent(c.req.param("id"));
  if (!student) return c.json({ error: "Not found" }, 404);
  return c.json(student);
});
```

Treat this as one focused branch, not an incremental route-by-route
migration — a server that's half Express-and-`node:sqlite`, half
Hono-and-D1 is a worse state than either stack alone, and it's easy to end
up there if you get pulled onto a feature mid-port.

### 1.3 Carry the existing security hardening over to Hono

The *decisions* from `05b8bf2` are still correct; only the packages change,
since `helmet`, the `cors` package, and `express-rate-limit` are all
Node-specific and don't run in a Worker:

| Concern | Express (current) | Hono / Cloudflare |
|---|---|---|
| Security headers | `helmet()` | [`hono/secure-headers`](https://hono.dev/docs/middleware/builtin/secure-headers) middleware |
| CORS allowlist | `cors({ origin: allowedOrigins })` | [`hono/cors`](https://hono.dev/docs/middleware/builtin/cors) middleware, same allowlist logic |
| Global rate limit (300/15min) | `express-rate-limit` | Cloudflare's [Rate Limiting Rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) (dashboard, zero code) or the Workers `RateLimit` binding |
| `/api/chat` limit (30/15min) | `express-rate-limit` on one route | Workers `RateLimit` binding scoped to `/api/chat`, or a small D1/KV counter |
| Body size cap | `express.json({ limit: "100kb" })` | Check `content-length` in middleware, or rely on Cloudflare's platform-level request size limits |

The dashboard-level Rate Limiting Rules are worth trying first — they're
literally a WAF rule keyed on path and IP, no code to maintain, and they run
in front of the Worker entirely. Reach for the `RateLimit` binding only if
you need per-user (not per-IP) limits once accounts exist (Phase 2).

### 1.4 Swap `node:sqlite` for D1

[D1](https://developers.cloudflare.com/d1/) is Cloudflare's managed
serverless SQLite — the same SQL dialect `db.js`'s schema already uses, so
the `CREATE TABLE IF NOT EXISTS` block moves to a `schema.sql` file almost
unchanged. What does change:

- **The driver is async.** `node:sqlite`'s `DatabaseSync` is synchronous by
  design (that's why `dataStore.js` never had to become async); D1's
  `prepare().bind().all()/first()/run()` all return Promises. Every function
  in `dataStore.js` needs `await`, and every route handler that calls it
  needs to be async — same "do it as one pass" caution as any sync→async
  migration.
- **No module-level connection.** `db.js` currently opens one `DatabaseSync`
  at module load and every caller shares it. Workers have no module-level
  state that survives across requests — the D1 binding (`env.DB`) is handed
  to you fresh per request. Restructure `dataStore.js` as a factory —
  `function createStore(db) { return { getStudent: (id) => ..., ... } }` —
  instantiated once per request from `c.env.DB` in Hono.
- **Local dev still works offline.** `wrangler dev` runs a local D1 instance
  (SQLite under `.wrangler/state`) automatically — `wrangler d1 create
  compass-db` once, then `wrangler d1 migrations apply compass-db --local`
  against `schema.sql` for every dev run.

`llmService.js` needs less work than the rest, but not *no* work. Its two API
calls are fine — both SDKs are fetch-based and run in a Worker unmodified — and
the offline keyword-fallback has no filesystem or Node dependency either. What
does have to change is the module's shape: it reads `process.env` at import
time and freezes `provider` and both clients into module constants. A Worker
has no `process.env` and gets its bindings per request, so it becomes
`createLlmService(env)` like the store does. *(Corrected during Phase 1 — the
original note here said no changes at all.)*

### 1.5 If you ever outgrow D1

D1 is still SQLite under the hood, so the same ceiling from the old
Postgres discussion applies: single-writer semantics per database. If this
app ever needs concurrent write throughput D1 can't give it, Cloudflare's
own escape hatch is [Hyperdrive](https://developers.cloudflare.com/hyperdrive/)
— a connection pooler that lets a Worker talk to an external Postgres (Neon,
Supabase, etc.) with low latency. That's a "years from now, if ever" concern
at this app's scale; don't reach for it preemptively.

---

## Phase 2 — Accounts & authentication

> **Built. See [PHASE-2.md](PHASE-2.md) for what shipped and why.** The plan
> below is preserved as written; where the build deviated, a note says so
> inline. The one structural deviation is in 2.1.

This is the biggest structural gap, unrelated to the hosting platform:
`GET /api/students/:id` (and every route under it) takes whatever `:id` a
client sends, no ownership check at all. Build this directly on Hono + D1
from Phase 1 rather than bolting it onto Express first.

### 2.1 A `users` table

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Add this to `schema.sql` alongside the existing tables, and apply it as a
D1 migration (`wrangler d1 migrations create add-users`).

*(Changed during Phase 2 — `email` and `password_hash` shipped **nullable**.
This plan assumed accounts-only, but the homepage promises "no account", and
supporting guests the obvious way needs two ownership paths — session→student
for a guest, session→user→student for a member — which is two ways to write
every future check and one way to forget it. A guest instead gets a real users
row with both columns NULL, so `students.user_id` stays the single ownership
column and signing up is one UPDATE on the row that already owns the profile.
A NULL email is unloggable-into by construction, since `WHERE email = ?` is
never true for a NULL.)*

### 2.2 Link students to users

Add `user_id INTEGER REFERENCES users(id)` to the `students` table, `UNIQUE`
on `user_id` so one user has one profile for now — same idea as before,
just in the D1 schema.

### 2.3 Password hashing without native bindings

`bcrypt` (the npm package) is a native Node addon — it will not load in a
Worker at all, since Workers can't run compiled binary code, only
JavaScript/WASM in a sandboxed isolate. Two real options:

- **Web Crypto PBKDF2** (recommended — zero dependencies, and `crypto.subtle`
  is natively available in Workers):

  ```js
  async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, key, 256);
    return { hash: bufToHex(bits), salt: bufToHex(salt) };
  }
  ```

- **`bcryptjs`** (pure JS, no native code) if you want drop-in
  bcrypt-compatible hashes — slower per call than the native version, but
  fine at this app's login volume.

*(Built with PBKDF2, as recommended. Two things this sketch omits that the
build adds: the stored hash carries its own iteration count and salt
(`pbkdf2$SHA-256$100000$…`) so the cost can be changed later without stranding
existing rows, and an unknown email still runs a dummy derivation — otherwise
"no such account" returns in microseconds while "wrong password" takes ~50ms,
and the timing gap enumerates accounts regardless of how generic the error
message is. Note also that 100k iterations exceeds the Workers **free** plan's
10ms CPU cap; see PHASE-2.md.)*

### 2.4 Sessions vs. JWT — still sessions, now backed by D1

The reasoning from before still holds: sessions are revocable server-side
(log out = delete the row), and `httpOnly` cookies keep the token out of
reach of any injected script. Only the storage layer changes — no
`connect-sqlite3` (that's a Node filesystem-backed store), just a plain
`sessions` table in the same D1 database:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
```

Generate the session id with `crypto.randomUUID()` (native in Workers), set
it as an `httpOnly`, `Secure`, `SameSite=Lax` cookie via
[`hono/cookie`](https://hono.dev/docs/helpers/cookie), and look it up
against D1 in a small auth middleware. If this app ever needs
lower-latency session reads at higher scale, Workers KV is the natural next
step (fast, eventually-consistent reads) — not needed yet.

### 2.5 Auth routes

```
POST /api/auth/signup   { email, password }  → creates user + session
POST /api/auth/login    { email, password }  → sets session
POST /api/auth/logout                        → destroys session
GET  /api/auth/me                            → current user + their student id
```

### 2.6 Protect the existing routes

```js
async function requireOwner(c, next) {
  const sessionId = getCookie(c, "session");
  const session = sessionId && await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(sessionId).first();
  if (!session) return c.json({ error: "Not signed in" }, 401);
  const student = await store(c.env.DB).getStudentByUserId(session.user_id);
  if (!student || student.id !== c.req.param("id")) return c.json({ error: "Forbidden" }, 403);
  await next();
}
```

Write tests for the 401/403 paths specifically — a route that silently
drops its auth check on a future edit is the single most common regression
in apps like this.

*(Done, and the sketch above needs one addition: `requireOwner` keys on the
`:id` path param, so it does nothing for the two routes that take a student id
elsewhere — `GET /majors/:major?studentId=` and `POST /chat`'s body. Both
return profile-derived output and are checked explicitly. Note also that the
build answers **403 for an unknown id too**, not 404: a 404/403 split tells an
unauthenticated caller which ids are real.)*

### 2.7 Frontend: login/signup screens + session-aware fetch

`api.ts` needs `credentials: "include"` on every `fetch` once sessions
exist, and the app needs a top-level "logged out" state. One thing that
*is* platform-specific: if Phase 7 ends up putting the frontend and API on
different origins (Option B there), the cookie needs `SameSite=None` +
`Secure` and the CORS middleware needs `credentials: true` — if they share
an origin (Option A, the default), `SameSite=Lax` is simpler and safer.
This is the natural point to introduce a router (see 5.1) rather than
bolting more state branches onto `App.tsx`.

---

## Phase 3 — Testing & CI

> **Built. See [PHASE-3.md](PHASE-3.md) for what shipped and why.** The plan
> below is preserved as written; where the build deviated, a note says so
> inline. §3.4 is the one item deliberately not done.

### 3.1 Backend tests need to run in the Workers runtime

Jest runs in plain Node, which has no concept of a D1 binding or the
per-request `env` object Hono routes expect — you can't easily fake those
under Jest without losing confidence that the tests reflect reality.
Cloudflare's official answer is
[`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/):
it runs your test suite inside the real Workers runtime (`workerd`), with
real D1/KV bindings available to every test. Migrating the existing Jest
suite (engines, data integrity, API routes) to Vitest is a real task —
budget time for it, same as any test-runner migration — but it's what
makes the D1-backed `dataStore.js` actually testable with confidence.

### 3.2 Fill the frontend test gap

Frontend has no tests today. Since the backend is moving to Vitest anyway,
use the same tool on the frontend side and share config where it makes
sense:

```bash
npm install -D --prefix frontend vitest @testing-library/react @testing-library/jest-dom jsdom
```

Priority order — test what's most likely to break silently, not everything:
1. `compare.ts`, `dates.ts`, `exportList.ts` — pure functions, cheap to test.
2. `useSchoolNotes.ts` — the shared hook five pages depend on.
3. Component smoke tests for `ProfileForm` and `ApplicationTracker`.

*(Built exactly in this order — 99 tests. `@testing-library/user-event` was added
to the list above, since a form test that dispatches raw change events is not
testing what a student does. Two things this sketch does not anticipate: the
frontend suite needs its **own** Vitest config rather than one extending
`vite.config.ts` (Vitest 4 carries Vite 8, the app builds on Vite 5), and it has
to pin `TZ=America/New_York` — `dates.ts` guards a bug that is invisible in UTC,
which is exactly what a CI runner defaults to. See PHASE-3.md.)*

### 3.3 GitHub Actions CI

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
        with: { node-version: 22, cache: npm, cache-dependency-path: backend/package-lock.json }
      - run: npm ci --prefix backend
      - run: npm run test --prefix backend   # vitest, via the Workers pool

  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: frontend/package-lock.json }
      - run: npm ci --prefix frontend
      - run: npm run test --prefix frontend
      - run: npm run build --prefix frontend
```

Note what's deliberately *not* in here: a deploy step. Cloudflare Pages'
native git integration (Phase 7.2) builds and deploys on every push and
gives every PR its own preview URL for free — simpler than wiring
`wrangler deploy` into Actions. Use Actions purely to gate merges on tests
passing (Phase 3.4); let Cloudflare's own integration handle the deploy.

*(Built close to this, with four additions: `node-version-file: .nvmrc` instead
of a literal `22`, so the Node version has one home; a `typecheck` step on the
backend (the frontend gets one free, since its `build` runs `tsc -b` first);
`concurrency` with `cancel-in-progress`; and `permissions: contents: read`.)*

### 3.4 Branch protection

Once CI is green consistently, turn on "Require status checks to pass" for
`main` in GitHub's branch protection settings — this is what makes a red
check actually block a merge instead of being a suggestion.

*(Deliberately not done. A rule has to name the checks it requires, and until
CI has reported on `main` at least once those names do not exist yet — the rule
would either block every merge or silently require nothing. The exact settings
are in [PHASE-3.md](PHASE-3.md#left-for-later).)*

---

## Phase 4 — Observability

> **Built. See [PHASE-4.md](PHASE-4.md) for what shipped and why.** The plan
> below is preserved as written; where the build deviated, a note says so
> inline. §4.2 is the one item deliberately not done, on this section's own
> advice.

### 4.1 Structured logging

Skip `pino` — its default transports lean on Node's filesystem
(`sonic-boom`), which doesn't exist in a Worker. Plain structured output is
enough and needs zero dependencies:

```js
console.log(JSON.stringify({ level: "info", route: c.req.path, status: 200 }));
```

Cloudflare's dashboard Logs view and `wrangler tail` (real-time local
tailing) both pick up `console.log`/`console.error` output automatically —
no log shipper to configure for basic visibility.

*(Built as `src/log.ts` plus a `requestLog` middleware. Three things this sketch
does not anticipate. The starting point was not zero — it was six hand-rolled
`console.*(JSON.stringify(...))` calls using three different names for "what
happened," so the work was consolidation rather than introduction. The `route`
field is the matched **pattern** (`/api/students/:id`), never `c.req.path`: a
student id in a retained log is a real identifier, and `onError` was already
leaking one on every 500. And the level mapping is `< 500 → info`, `>= 500 →
error` rather than the usual 4xx → warn — a 401 here is just an expired session,
and routine traffic at warn costs warn its meaning.)*

### 4.2 Error tracking

`@sentry/node` won't load in a Worker (same Node-API problem as everything
else here). Use [`@sentry/cloudflare`](https://docs.sentry.io/platforms/javascript/guides/cloudflare/),
Cloudflare's official Sentry SDK for Workers, on the backend; the frontend
keeps plain `@sentry/react` since that runs in the browser, not the Worker.
Skip this until there are actual outside users — it's noise before that.

*(Deliberately not done, on exactly that advice. Every user of this app today is
the person who wrote it, and `wrangler tail` is a better tool for that in real
time with no DSN and no vendor. The trigger to revisit is Phase 7 putting this on
a public URL. See [PHASE-4.md](PHASE-4.md#42-sentry-deliberately-not-built) for
the one non-obvious prerequisite — the frontend's Vitest 3 / Vite 5 pin means any
new frontend dependency needs a Linux `npm ci` check first.)*

### 4.3 A real health check

`GET /api/health` already reports LLM provider status — extend it to run a
trivial `SELECT 1` against D1 (`c.env.DB.prepare("SELECT 1").first()`) so
uptime monitoring (Phase 8) can tell "the Worker is up" apart from "the
Worker is up but D1 is unreachable."

*(Done in Phase 1 — it was one query, and doing it early meant the health route
was never the odd one out. Phase 4 added one thing on top: the request logger
drops health checks to `debug`, since a monitor hitting this every few minutes
forever would otherwise become most of the log by volume.)*

---

## Phase 5 — Frontend polish

None of this is platform-specific — Cloudflare Pages just serves whatever
`frontend/dist` contains, same as any static host.

### 5.1 Add a router

`App.tsx` drives navigation with component state, not URLs — no
shareable/bookmarkable links, no back-button support, and it's what'll make
Phase 2's login-gate awkward to bolt on. Introducing `react-router-dom` is a
genuine, deliberate rewrite of the nav logic, not a drive-by edit.

### 5.2 Code-split by route

Once routed, wrap each page in `React.lazy` + `Suspense`. `ChatBot`,
`SchoolCompare`, and `ApplicationTracker` are the heaviest screens —
splitting them keeps the first paint (Home + ProfileForm) fast.

### 5.3 SEO & social sharing

`index.html` needs `<meta name="description">`, Open Graph tags, and a real
favicon set (there's a `BrandMark.tsx` component to source an icon from).
Matters the moment this has a public URL people might share.

### 5.4 Accessibility audit

Run Lighthouse's accessibility pass and axe DevTools on the five
most-used screens (Home, ProfileForm, Recommendations, Scholarships,
ApplicationTracker) and fix anything under a 95 score. Check by hand,
since automated tools miss them: focus order through the multi-step
`ProfileForm`, and whether the `NoteHint` dismissal logic announces itself
to a screen reader.

### 5.5 PWA / offline shell (optional)

Given the chatbot already has an offline fallback mode, a service worker
caching the app shell would let a student reopen Compass with no
connection and still browse saved schools and notes. Nice-to-have, not a
launch blocker.

---

## Phase 6 — Product roadmap (feature ideas, roughly prioritized)

1. **Deadline reminder emails** — the timeline and tracker already compute
   what's due when. On Cloudflare this maps directly onto a
   [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
   (`[triggers] crons = ["0 13 * * *"]` in `wrangler.toml`, handled by a
   `scheduled()` export) — no separate cron host needed. Needs Phase 2
   first (an email address to send to).
2. **Calendar export (.ics)** — same dependency (real deadlines), pure
   client-side generation, no new backend needed.
3. **Essay brainstorm assistant** — a second chatbot mode reusing
   `llmService.js`'s existing provider abstraction and offline-fallback
   pattern.
4. **Net price estimator** — a rough net-price-after-aid estimate (sticker
   tuition − typical aid by income bracket, clearly labeled as an estimate),
   deepening the recommendation engine's existing "financial fit" logic.
5. **Admissions officer / contact tracker** — a small addition to the
   existing per-school note, reusing that infrastructure.
6. **Growing the scholarship dataset** — no free scholarship API exists;
   stays a curation task on `scholarships.json`, not an engineering one.
7. **Parent/counselor view** — a read-only shared link to a student's plan.
   Needs Phase 2's accounts first.

---

## Phase 7 — Hosting on Cloudflare Pages + Workers, step by step

Everything above should be done — or done enough to demo — before this
phase. This is the one-time (well, once-per-project) Cloudflare setup.

### 7.1 Pick an architecture

**Option A — One Cloudflare Pages project with Functions (recommended
default).** The frontend build (`frontend/dist`) and the API
(`functions/api/[[route]].ts`, wrapping the Hono app via Hono's
[`hono/cloudflare-pages`](https://hono.dev/docs/getting-started/cloudflare-pages)
adapter) live in one Pages project. Same origin, **zero CORS to configure**,
one dashboard entry, D1/KV bound directly to the project. This is the
smallest, simplest shape for an app this size:

```ts
// functions/api/[[route]].ts
import { Hono } from "hono";
import { handle } from "hono/cloudflare-pages";

const app = new Hono().basePath("/api");
app.get("/health", (c) => c.json({ ok: true }));
// ...the rest of the routes from Phase 1/2

export const onRequest = handle(app);
```

**Option B — a separate Worker for the API, Pages for the frontend only.**
Worth it if you want the API to be an independently deployable service —
relevant since you're standardizing multiple projects on this account and
might eventually share an API or reuse patterns across them — or you need a
Worker-only feature Pages Functions doesn't expose. Otherwise this
reintroduces cross-origin requests, and Phase 1.3's CORS allowlist becomes
load-bearing instead of skippable.

**Start with Option A.** It matches the app as it exists today (one small
API, one frontend) and defers Option B's complexity until there's an actual
reason for it — e.g. a second frontend project wanting to call the same API.

### 7.2 Set up Wrangler and the Cloudflare project

```bash
npm install -D wrangler
wrangler login
```

Connect the GitHub repo to a new Pages project via the Cloudflare
dashboard (Workers & Pages → Create → Pages → Connect to Git) rather than
deploying from the CLI by hand — the git integration gives you automatic
deploys on push to `main` **and** a preview URL for every PR, at no extra
cost, which is a meaningfully better default than anything Render/Fly
offered here.

- **Build command**: `npm install --prefix frontend && npm run build --prefix frontend`
- **Build output directory**: `frontend/dist`
- **Root directory**: repo root (so the `functions/` directory at the root is picked up alongside the frontend build)

### 7.3 Create the D1 database

```bash
wrangler d1 create compass-db
wrangler d1 migrations apply compass-db --remote
```

Bind it to the Pages project — either in the dashboard (Settings →
Functions → D1 database bindings) or in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "compass-db"
database_id = "..."   # from `wrangler d1 create`'s output
```

### 7.4 Secrets

```bash
wrangler pages secret put ANTHROPIC_API_KEY --project-name=compass
```

Cloudflare Pages supports distinct environment variables for **Production**
vs. **Preview** — a nice fit for this app specifically: leave the LLM key
unset on Preview so every PR preview runs in the existing offline-fallback
mode, and only spend real API money on Production traffic.

### 7.5 Custom domain

If the domain's DNS already lives on Cloudflare — likely, if you're
standardizing hosting here — attaching a custom domain to a Pages project
is a dashboard toggle with automatic SSL, no CNAME juggling. If DNS is
elsewhere, add the CNAME the dashboard shows you.

### 7.6 Multi-project account hygiene

Since other projects are landing on this same Cloudflare account, pick a
naming convention now rather than after the fifth project shows up in the
dashboard — e.g. `<project>-web` for the Pages project name and
`<project>-db` for its D1 database (`compass-web`, `compass-db`).

### 7.7 Smoke-test before calling it done

Sign up a test account, complete a profile, confirm recommendations
render, send one chat message (confirms the LLM key or offline fallback
works). Then — the real analog of "restart and check data survived" from a
traditional host — load the app from a **second browser or device** and
confirm the same data shows up. Workers have no persistent memory between
requests by design, so this specifically validates that state genuinely
lives in D1 and nothing accidentally depends on in-memory state left over
from local `wrangler dev` testing.

---

## Phase 8 — Post-launch operations

- **Backups**: D1 has built-in point-in-time recovery ("Time Travel") for a
  rolling window with no setup — check the current retention window on
  Cloudflare's docs since it's changed before. For extra insurance beyond
  that window, a periodic `wrangler d1 export --remote` pushed to an R2
  bucket (or even a private git repo, at this size) is cheap.
- **Uptime monitoring**: a free tier of UptimeRobot or Better Uptime hitting
  `/api/health` every few minutes, alerting you — not the students — when
  it fails.
- **Cost**: Pages hosting is free for static assets; Workers, D1, and KV all
  have free tiers that likely cover this app's traffic entirely, with
  usage-based pricing beyond that — meaningfully cheaper than a traditional
  host's flat monthly minimum. The main variable cost stays LLM usage; the
  chat rate limit from Phase 1.3 caps worst-case spend per user the same way
  it did on Express.
- **Scaling trigger**: Workers scale automatically — there's no "add another
  instance" capacity planning the way there was on Render/Fly. The one real
  ceiling left is D1's single-writer-per-database model under heavy
  concurrent writes; if that ever bites, Cloudflare's answer is sharding
  across multiple D1 databases or moving hot state into Durable Objects, not
  provisioning more servers.

---

## Suggested order

You've chosen to build this out fully and host once, at the end, rather
than deploy early and iterate in production — the opposite of the usual
"ship something rough, then polish" advice. Given that:

**Phase 1 (Hono + D1 migration) → Phase 2 (auth) → Phase 3 (CI) → Phase 4
(observability) → Phase 5 (frontend polish) → Phase 6 (roadmap items, as
time allows) → Phase 7 (deploy to Cloudflare) → Phase 8 (ops).**

Do Phase 1 early and don't skip it in favor of features — every phase after
it is written directly against Hono + D1, so building more on Express +
`node:sqlite` first just means re-doing that work later on a bigger
surface area.

One honest trade-off worth naming: Phase 7.7's smoke test will be the
*first* time you find out whether the Hono/D1 code actually behaves
correctly against Cloudflare's real edge network rather than `wrangler
dev`'s local emulation, which is very close but not perfectly identical
(timing, cold starts, and regional D1 replication behave slightly
differently in production). Leave a little slack at the end for that —
it's the one class of bug this order defers instead of catching early.

---

## Progress checklist

Checked against the actual repo, not just intent — update this as phases
land rather than trusting memory.

**Phase 0 hygiene / Express-side security (commit `05b8bf2`)**
- [x] `backend/.env.example` *(superseded by `backend/.dev.vars.example` in Phase 1)*
- [x] `.nvmrc` + `engines` pin in `backend/package.json`
- [x] Root `package.json` with `concurrently`-driven dev scripts
- [x] CORS allowlist (`cors({ origin: allowedOrigins })`)
- [x] `helmet()` security headers
- [x] Global rate limiter (300/15min) + stricter `/api/chat` limiter (30/15min)
- [x] Explicit `express.json({ limit: "100kb" })` body cap
- [x] Carried forward to the Hono/Cloudflare equivalents — see Phase 1 below

**Phase 1 — Hono + D1 migration** — **done**, written up in [PHASE-1.md](PHASE-1.md)
- [x] Express routes ported to Hono (`backend/src/app.ts`, all 20 endpoints, contract unchanged)
- [x] Security hardening re-applied (`hono/secure-headers`, `hono/cors`, D1-backed `/api/chat` limiter)
- [x] `node:sqlite` schema moved to `backend/migrations/`, applied via D1 migrations
- [x] `dataStore.js` → `createStore(db)`, an async factory over `env.DB`
- [x] `wrangler.toml` / local D1 dev loop working (`wrangler dev` on :8787)
- [x] Backend converted to TypeScript (chosen because a sync→async rewrite of every
      data-access call is exactly where a missing `await` hides)
- [x] Test suite migrated to Vitest + `@cloudflare/vitest-pool-workers` — pulled forward
      from Phase 3.1, since leaving 7 suites red through the riskiest rewrite in the
      project was the worse trade. 99 tests passing.
- [x] `/api/health` extended to probe D1 — pulled forward from Phase 4.3, one query.
- [ ] **Deploy-day leftover:** the global 300/15min limit is a WAF rule, not code.
      The exact rules to create are in [PHASE-1.md](PHASE-1.md#left-for-deploy-day-the-global-rate-limit).

**Phase 2 — Accounts & authentication** — **done**, written up in [PHASE-2.md](PHASE-2.md)
- [x] `users` table — with `email`/`password_hash` nullable, so a guest is a real
      account rather than a second kind of owner (see PHASE-2.md for why that
      choice is what keeps `requireOwner` to one code path)
- [x] `students.user_id` link, `UNIQUE`, applied as migration `0003_auth.sql`
- [x] Password hashing — Web Crypto PBKDF2, self-describing hash format,
      constant-time compare, plus a dummy hash on unknown emails so login
      timing is not an account-enumeration oracle
- [x] `sessions` table + `httpOnly` / `SameSite=Lax` cookie, rotated on login
      and signup, revoked server-side on logout
- [x] `/api/auth/*` routes (signup claims the caller's guest profile in place)
- [x] `requireOwner` on every `/students/:id` route — **and** on the two routes
      that take a student id off that path (`/majors/:major?studentId=`,
      `POST /chat`), which §2.6's sketch does not cover
- [x] Frontend login/signup + `credentials: "include"`; profile now survives a
      page refresh, and editing updates rather than duplicating
- [x] Chat rate limiter re-keyed from IP to account — the follow-up PHASE-1.md
      left open. Guests still key on IP, deliberately.
- [x] 143 tests passing (was 111), incl. per-route 401 *and* 403 coverage
- [ ] **Deploy-day leftover:** PBKDF2 at 100k iterations costs ~40-60ms CPU,
      over the Workers **free** plan's 10ms limit. Fine on Workers Paid; on free,
      lower `ITERATIONS` in `backend/src/auth/password.ts`. See
      [PHASE-2.md](PHASE-2.md#left-for-deploy-day-the-free-plan-cpu-limit).
- [ ] *Not built:* password reset / email verification — both need an email
      provider, which arrives with Phase 6.1

**Phase 3 — Testing & CI** — **done** apart from §3.4, written up in [PHASE-3.md](PHASE-3.md)
- [x] Backend tests migrated to Vitest + `@cloudflare/vitest-pool-workers` *(done in Phase 1)*
- [x] Frontend test suite — Vitest + Testing Library + jsdom, 99 tests in 6 suites,
      in the guide's priority order: `exportList` (22), `useSchoolNotes` (17),
      `dates` (16), `ProfileForm` (16), `ApplicationTracker` (21), `compare` (7)
- [x] Its own `frontend/vitest.config.ts` rather than a root config shared with the
      backend — the two suites need genuinely different runtimes (jsdom vs. workerd)
- [x] Frontend pinned to **Vitest 3**, not 4: Vitest 4's bundled Vite 8 declares
      `esbuild` as an optional peer, and npm writes its per-platform packages into
      the lockfile unmarked, so `npm ci` hard-fails on Linux with `EBADPLATFORM`.
      Vitest 3 shares the app's Vite 5 — one Vite, one esbuild, a portable lock.
      Found by CI, not locally; `npm ci --dry-run --os=linux --cpu=x64` reproduces it.
- [x] Suite pinned to `TZ=America/New_York` — `dates.ts` guards a UTC-parsing bug
      that a UTC runner cannot observe, and UTC is the CI default
- [x] GitHub Actions CI (`.github/workflows/ci.yml`) — both suites, both typechecks,
      and the frontend build, on every PR and every push to `main`. No deploy step.
- [x] Root `npm test` / `npm run typecheck` now cover both halves of the repo
- [ ] **Deliberately not done:** branch protection requiring CI to pass. It is a
      repo setting, and the rule cannot name check names that have never reported —
      turn it on after CI's first green run on `main`. Settings in
      [PHASE-3.md](PHASE-3.md#left-for-later).
- [ ] *Not built:* coverage thresholds. A percentage gate rewards covering whatever
      is cheapest; the priority order above is the policy instead.

**Phase 4 — Observability** — **done** apart from §4.2, written up in [PHASE-4.md](PHASE-4.md)
- [x] Structured logging — `src/log.ts` is now the only file in `src/` that touches
      `console`, replacing six hand-rolled JSON lines that used three different
      names for "what happened"
- [x] One line per request (`middleware/requestLog.ts`), registered first so it can
      see and time everything below it — including the 413s `bodyLimit` returns
- [x] `route` is the matched **pattern**, never the raw path. This also closed a
      pre-existing leak: `onError` was logging `c.req.path`, so every 500 on a
      `/students/:id` route already wrote a student id into the log
- [x] `LOG_LEVEL` var (`debug|info|warn|error|silent`, default `info`) — a var and
      not a secret, so it can be turned up in the dashboard mid-incident without a
      redeploy; the suite runs at `silent`
- [x] 22 new tests, 165 total (was 143). The load-bearing ones assert what is *not*
      in a log line — student id, email, password, session cookie — against the raw
      text, so a leak in a nested field or a stack trace cannot slip past
- [x] `/api/health` extended to check D1 (`SELECT 1`) *(done in Phase 1)*; Phase 4
      drops health checks to `debug` so Phase 8's monitor cannot flood the log
- [ ] **Deliberately not done:** `@sentry/cloudflare` + `@sentry/react`. This
      section's own advice is to wait for outside users, and there are none yet —
      `wrangler tail` is the better tool until Phase 7 makes the app public.
- [ ] *Not built:* a frontend error boundary. A component throw still blanks the
      page. It is a real gap and a **Phase 5** one — it needs a designed error
      state, not a bare `<div>`.

**Phase 5 — Frontend polish**
- [ ] `react-router-dom` routing *(§2.7 suggested pulling this into Phase 2;
      deliberately not done, so the auth change stayed reviewable on its own.
      Auth is two more `View` states in `App.tsx` until this lands.)*
- [ ] Code-splitting (`React.lazy` + `Suspense`) on heavy pages
- [ ] SEO meta tags, Open Graph, favicon set
- [ ] Accessibility audit (Lighthouse/axe, 95+ on core screens)
- [ ] PWA / offline shell *(optional)*

**Phase 6 — Product roadmap** *(pick off as time allows, none started)*
- [ ] Deadline reminder emails (Cron Trigger)
- [ ] Calendar export (.ics)
- [ ] Essay brainstorm assistant
- [ ] Net price estimator
- [ ] Admissions officer / contact tracker
- [ ] Growing the scholarship dataset
- [ ] Parent/counselor view

**Phase 7 — Cloudflare Pages + Workers hosting**
- [ ] Architecture chosen (Option A: Pages + Functions, recommended)
- [ ] Wrangler installed, Cloudflare Pages project connected to GitHub
- [ ] D1 database created and bound
- [ ] Secrets set (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`) per environment
- [ ] Custom domain attached
- [ ] Naming convention picked for multi-project account
- [ ] Post-deploy smoke test (incl. second-device data check)

**Phase 8 — Post-launch operations**
- [ ] Backup plan beyond D1's Time Travel window confirmed
- [ ] Uptime monitoring on `/api/health`
- [ ] First few weeks of LLM cost usage reviewed against the rate limit
