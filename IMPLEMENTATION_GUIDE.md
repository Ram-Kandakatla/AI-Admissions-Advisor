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

*(Not done, and the reason changed. The original one — a rule cannot name check
names that have never reported — has resolved: CI has run green on `main`
several times. The actual blocker is that this repository is **private on a free
plan**, and GitHub gates rulesets and classic branch protection alike behind
Pro; both endpoints answer `403 Upgrade to GitHub Pro or make this repository
public`. So this is a billing or visibility decision, not a sequencing one. The
options and the exact settings are in
[PHASE-3.md](PHASE-3.md#left-for-later).)*

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

> **Built. See [PHASE-5.md](PHASE-5.md) for what shipped and why.** The plan
> below is preserved as written; where the build deviated, a note says so
> inline. §5.5 is the one item deliberately not done.

None of this is platform-specific — Cloudflare Pages just serves whatever
`frontend/dist` contains, same as any static host.

### 5.1 Add a router

`App.tsx` drives navigation with component state, not URLs — no
shareable/bookmarkable links, no back-button support, and it's what'll make
Phase 2's login-gate awkward to bolt on. Introducing `react-router-dom` is a
genuine, deliberate rewrite of the nav logic, not a drive-by edit.

*(Done, and "rewrite" was right: nine navigation callback props across eight
components became `<Link>`s, since an anchor gets cmd-click and a screen reader
announcing "link", neither of which a click handler can fake. Two things this
sketch does not anticipate. `/compare?ids=` and `/majors/:major` put page state
in the URL, because "shareable links" is the stated reason for the router and a
`/majors` that opens on a different major for each visitor is not shareable.
And the router creates one new bug: a bookmarked `/matches` renders before
`/auth/me` answers, so a naive gate tells someone who has a profile to go and
build one — impossible before, when every page arrived via a click.)*

### 5.2 Code-split by route

Once routed, wrap each page in `React.lazy` + `Suspense`. `ChatBot`,
`SchoolCompare`, and `ApplicationTracker` are the heaviest screens —
splitting them keeps the first paint (Home + ProfileForm) fast.

*(Corrected during Phase 5 — those are not the heaviest screens. Measured,
`ChatBot` is the **lightest** page in the app at 3.0 kB (its weight is API
round-trips, not code) and `ApplicationTimeline`, unmentioned here, is the
heaviest at 13.0 kB. Every page is split rather than the named three: leaving a
6 kB page eager to save it one request charges those 6 kB to every visitor who
never opens it. First load went 239 kB → 210 kB, i.e. smaller than before the
router was added. The `Suspense` boundary belongs inside Layout around the
`<Outlet />`, not around `<Routes>`, or the chrome blanks on every
navigation.)*

### 5.3 SEO & social sharing

`index.html` needs `<meta name="description">`, Open Graph tags, and a real
favicon set (there's a `BrandMark.tsx` component to source an icon from).
Matters the moment this has a public URL people might share.

*(Done. The description tag already existed; the icons did not — there was no
`frontend/public/` at all. They are generated by `scripts/build-icons.mjs`
rather than committed by hand, because macOS `qlmanage` renders an SVG at its
intrinsic size into a corner of the requested canvas and fails silently, which
produces a valid but mostly-empty icon. The favicon is **not** sourced from
`BrandMark.tsx` as suggested: that is line art coloured by CSS variables, and a
favicon is fetched as a standalone document with no access to the page's CSS.
Two limits worth knowing — every absolute URL is a placeholder host until §7.5,
and the tags are static, so `/matches` shares the homepage's card. Per-route
`document.title` was added too; fourteen bookmarkable URLs all reading
"Compass" is the problem titles exist to solve.)*

### 5.4 Accessibility audit

Run Lighthouse's accessibility pass and axe DevTools on the five
most-used screens (Home, ProfileForm, Recommendations, Scholarships,
ApplicationTracker) and fix anything under a 95 score. Check by hand,
since automated tools miss them: focus order through the multi-step
`ProfileForm`, and whether the `NoteHint` dismissal logic announces itself
to a screen reader.

*(Done — axe-core over 14 routes in both themes, from violations on four of the
five screens above to zero on all of them. axe rather than Lighthouse, since
Lighthouse's accessibility category is axe-core; the rule coverage is the same.
Most of what it found was in the design tokens, not the markup: four rules faded
an accent with `opacity` after the token had been darkened specifically to clear
4.5:1, and three used `--txf` — the **faint** token, for marks and dividers —
for prose, at 2.21:1. Separately, no page but Home had an `h1`.

Both hand checks came back clean and both led to a real bug beside them.
`ProfileForm`'s focus order is correct — and it is a **single-step** form, not
the multi-step one described here, so there is no step handoff to get wrong; but
two bare `<label>`s labelled nothing, leaving 22 major chips with no group name.
`NoteHint` is right not to announce its dismissal, but the star that dismisses
it flipped its `aria-label` to "Unsave X" as `aria-pressed` became true,
announcing "Unsave Carnegie Mellon, pressed".)*

### 5.5 PWA / offline shell (optional)

Given the chatbot already has an offline fallback mode, a service worker
caching the app shell would let a student reopen Compass with no
connection and still browse saved schools and notes. Nice-to-have, not a
launch blocker.

*(Deliberately not done. A service worker's caching semantics interact with how
Pages serves the app, which is easier to reason about once Phase 7 exists than
before it.)*

---

## Phase 6 — Product roadmap (feature ideas, roughly prioritized)

> **Four of seven built. See [PHASE-6.md](PHASE-6.md) for what shipped and
> why.** The list below is preserved as written; where the build deviated, a
> note says so inline. 6.1 is blocked on a purchase, 6.4 on data that does not
> exist, and 6.6 is not an engineering task.

1. **Deadline reminder emails** — the timeline and tracker already compute
   what's due when. On Cloudflare this maps directly onto a
   [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
   (`[triggers] crons = ["0 13 * * *"]` in `wrangler.toml`, handled by a
   `scheduled()` export) — no separate cron host needed. Needs Phase 2
   first (an email address to send to).

   *(Not built, and the dependency list is longer than "Phase 2". It needs a
   paid email provider — MailChannels' free Workers integration was retired,
   and Cloudflare's own `send_email` binding only sends to addresses verified
   in your own account, not to students — plus a verified sending domain from
   §7.5, and email verification, since signup takes an address on trust today.
   Note also that §6.2 below already delivers the reminder itself, from the
   student's own calendar, needing none of that. See
   [PHASE-6.md](PHASE-6.md#61--deadline-reminder-emails).)*
2. **Calendar export (.ics)** — same dependency (real deadlines), pure
   client-side generation, no new backend needed.

   *(Built, client-side as described. Two things this line does not anticipate.
   It is the **deliverable half of 6.1**: a `VALARM` fires a week ahead from the
   student's own calendar, with no provider and no domain — so the priority
   order here is backwards. And RFC 5545 has four edges worth the 250 lines:
   `DTEND` is exclusive for an all-day event, TEXT escapes four characters
   (backslash first), folding is at 75 **octets** and must not split a
   character, and the file is CRLF throughout. `deadlineIsTypical` maps onto
   `STATUS:TENTATIVE`, which is the format's own word for it.)*
3. **Essay brainstorm assistant** — a second chatbot mode reusing
   `llmService.js`'s existing provider abstraction and offline-fallback
   pattern.

   *(Built, and the abstraction did carry it — but a second prompt is worthless
   without a second **thread**, which this line does not mention. The `messages`
   table had no mode, so both assistants would have appended to one history and
   every essay question would have reached the model wrapped in the student's
   last FAFSA question. Migration `0004` adds it. The prompt itself is mostly
   restraint: a model asked for essay help writes the essay unless told not to,
   and the offline bank holds the same line.)*
4. **Net price estimator** — a rough net-price-after-aid estimate (sticker
   tuition − typical aid by income bracket, clearly labeled as an estimate),
   deepening the recommendation engine's existing "financial fit" logic.

   *(Not built. The aid data does not exist: `universities.json` carries
   `tuition` and nothing else financial — no room and board, no average grant by
   income bracket, no percent-of-need-met — and the whole "financial fit" logic
   is one line, `AFFORDABLE_CEILING`. This is a data-acquisition task wearing an
   engineering task's clothes, and "clearly labeled as an estimate" does not
   rescue a number the app made up: this is the same app that refuses to publish
   an unconfirmed deadline. The honest version is real IPEDS/Scorecard figures
   for the 42 schools, cited per school.)*
5. **Admissions officer / contact tracker** — a small addition to the
   existing per-school note, reusing that infrastructure.

   *(Built exactly that way — columns on `school_notes`, not a new table, which
   costs one contact per school. Two things this line does not anticipate. It
   deliberately stores **no email or phone**: a counselor did not consent to
   being in this database, and a name and job title are already public on the
   school's site. And the addition is not as small as it sounds — `school_notes`
   deletes a row that "holds nothing", so that definition had to learn about
   contacts or a student unstarring a school would silently lose the name of the
   person reading their application.)*
6. **Growing the scholarship dataset** — no free scholarship API exists;
   stays a curation task on `scholarships.json`, not an engineering one.

   *(Not built, on this line's own terms. Still 45 entries.)*
7. **Parent/counselor view** — a read-only shared link to a student's plan.
   Needs Phase 2's accounts first.

   *(Built. The framing to hold onto is that **the URL is the credential** —
   there is no account on the other end, which is the point, and every
   constraint follows from it. Revoking is a DELETE rather than a `revoked_at`
   flag, because the server must never be able to answer "revoked" and "never
   existed" differently; no expiry, because one a student forgets is a dead link
   to their counselor in December. The shared payload is enumerated field by
   field rather than spread — a rule worth stating because reusing `decorate()`
   for applications broke it during the build and shipped the student id until a
   test caught it.)*

---

## Phase 7 — Hosting on Cloudflare Pages + Workers, step by step

> **Code half built; account half is a runbook. See [PHASE-7.md](PHASE-7.md)
> for what shipped, the exact steps to run, and — most importantly — the two
> items below that turned out to be *blocked* rather than pending.** The plan
> below is preserved as written; where the build deviated, a note says so
> inline.

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

*(Built as Option A, with one correction and one caveat. The sketch above puts
the `hono/cloudflare-pages` import in `functions/api/[[route]].ts`, which cannot
resolve in this repo — nothing above `functions/` has a `node_modules`, so tsc
and esbuild fail identically and the first sign of it would have been a red
Cloudflare build. The adapter lives in `backend/src/pages.ts` instead and the
root file is a bare re-export; CI now runs `wrangler pages functions build` so
that class of break is caught on a PR. The caveat: Cloudflare's docs now say
outright to start new projects on **Workers**, not Pages, and Workers Builds has
since gained the git integration and per-PR previews §7.2 picks Pages for. Pages
was kept deliberately; PHASE-7.md records what that costs and how short the
migration would be.)*

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

*(Two corrections. `npm install -D wrangler` is already done — wrangler has been
a backend devDependency since Phase 1. And the build command above is wrong for
this repo: it installs frontend dependencies only, after which the Functions
bundler cannot resolve `hono`, `@anthropic-ai/sdk` or `openai`, which live in
`backend/node_modules`. Use `npm run build:pages`, a root script that installs
both halves — a script rather than a dashboard string so the build command is in
git and reviewable.)*

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

*(Done, and the same reasoning was followed through to the **database**, which
this section stops short of. A preview deployment is unreviewed code; pointing
it at the production D1 puts real profiles one stray migration away from an
unread branch. `[env.preview]` binds `compass-db-preview` instead. Note that
`vars` had to be restated inside that block rather than inherited — Pages
requires an environment overriding any non-inheritable key to specify all of
them, so omitting it would leave previews with no `CORS_ORIGIN` at all. Note
also what is deliberately **not** in the config: `LOG_LEVEL`. Declared fields
become read-only in the dashboard, and Phase 4 made it a var precisely so it
could be raised mid-incident without a redeploy.)*

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

## Still open, in one place

Every deferred, not-built, or blocked item, pulled out of the per-phase
checklists below into one list. Those checklists stay authoritative for their
own phase; this is the cross-cutting view, for answering "what is actually
left?" without reading eight of them.

This started life as a gate to clear *before* Phase 7. It is not that any
more. Phase 7's code half shipped, and five rounds landed after it — a
dead-import audit, legal and trust pages with self-hosted fonts, self-serve
account deletion, password reset, and TOTP two-factor auth. Two items this
list used to carry are done as a result (the `_headers` `Referrer-Policy`,
and password reset), and the email-provider question that was blocking both
password reset and §6.1 has been answered: Resend, over HTTP, because a
Worker has no raw sockets and SMTP libraries therefore do not run at all.

### Deploy day — waiting on the Cloudflare account or a live domain

Nothing here is a code problem. Each item needs an account, a hostname, or a
paid plan that does not exist yet; [PHASE-7.md](PHASE-7.md) is the runbook.

- [ ] **Wrangler login, both D1 databases created, the Pages project connected
      to GitHub**, and migrations applied to each. *(Phase 7.2–7.3)*
- [ ] **Four secrets on Production, not one.** `ANTHROPIC_API_KEY`, plus
      `RESEND_API_KEY`, `EMAIL_FROM` and `APP_ORIGIN` for password reset —
      without the last three, reset degrades to "cannot send" rather than
      falling back, because there is no worse-but-useful way to deliver mail.
      `APP_ORIGIN` is deliberately configuration and never a request header:
      building the reset link from `Host` is host-header poisoning. Preview
      gets none of them on purpose. *(Phase 7.4 + password reset)*
- [ ] **Five placeholder `compass.example.com` URLs.** Three in
      [`frontend/index.html`](frontend/index.html) — the canonical, `og:url`
      and `og:image` — and two in
      [`.well-known/security.txt`](frontend/public/.well-known/security.txt),
      its `Policy` and `Canonical`.
      The security.txt pair matters more than it looks: RFC 9116 only treats
      `Canonical` as valid if the file is genuinely served from that exact
      URL. *(Phase 5.3 + legal round)*
- [ ] **Push `security.txt`'s `Expires` out from the deploy date.** It reads
      `2027-08-31`, set just under a year deliberately — a strict RFC 9116
      validator rejects exactly twelve months. Every scanner treats an expired
      file as stale, so this wants a calendar reminder, not good intentions.
- [ ] **Fill the three operator placeholders** in
      [`frontend/src/legal.ts`](frontend/src/legal.ts) — `OPERATOR_NAME`,
      `GOVERNING_LAW`, `CONTACT_EMAIL`. They render as a highlighted `<mark>`
      so they cannot ship looking finished, and `legal.test.ts` enumerates
      them as exactly this checklist.
- [ ] **Enable "Private vulnerability reporting"** on the repository
      (Settings → Code security and analysis; off by default). Both the
      Security page and `security.txt` point a researcher at it, so until it
      is on, the disclosure path they advertise does not exist.
- [ ] **Post-deploy smoke test**, including the second-device data check.
      *(Phase 7.7)*
- [ ] **Blocked, not pending — the global 300/15min rate limit.** WAF rate
      limiting rules are zone-scoped, so there is nothing to attach one to
      before a custom domain exists, *and* a 15-minute counting period needs a
      **Business** plan (Free and Pro cap it at 1 minute; Free allows one rule
      total). Until then there is no global limit at all — LLM spend is still
      capped by the in-code `/api/chat` limiter. *(Phase 1.3 —
      [PHASE-1.md](PHASE-1.md#left-for-deploy-day-the-global-rate-limit))*
- [ ] **Blocked, not pending — PBKDF2 vs. the plan.** Free caps CPU at 10ms
      per invocation; 100k iterations costs 40–60ms, so signup and login
      **fail outright** there. Settle before the first real signup, by paying
      for Workers Paid or lowering `ITERATIONS` in
      [`backend/src/auth/password.ts`](backend/src/auth/password.ts).
      *(Phase 2.3 —
      [PHASE-2.md](PHASE-2.md#left-for-deploy-day-the-free-plan-cpu-limit))*

### Blocked on spend or a decision outside the codebase

- [ ] **Branch protection on `main`.** CI has reported green for a while, so
      the original reason (no check names to point a rule at) is long gone.
      The real blocker is that the repo is private on a free GitHub plan, and
      rulesets and classic branch protection are both gated behind Pro. Needs
      Pro or a public repo. *(Phase 3.4 —
      [PHASE-3.md](PHASE-3.md#left-for-later))*
- [ ] **Deadline reminder emails (6.1) — partly unblocked.** The provider
      question is settled; Resend is already wired up. What is left is a
      **verified sending domain** (so §7.5 is still upstream of it) and
      **email verification at signup**, since signup takes an address on trust
      today. Worth re-examining the priority too: §6.2's calendar export
      already delivers the reminder, from the student's own device, needing
      neither. *(Phase 6.1 —
      [PHASE-6.md](PHASE-6.md#61--deadline-reminder-emails))*
- [ ] **Net price estimator (6.4).** Blocked on data, not code:
      `universities.json` carries sticker tuition and nothing else financial.
      Needs real IPEDS or College Scorecard aid figures per school before it
      can be built honestly. *(Phase 6.4)*
- [ ] **Sentry error tracking** (`@sentry/cloudflare` + `@sentry/react`).
      Skipped while the app's only user was its author, and the trigger named
      at the time was exactly Phase 7 putting Compass on a public URL — so
      this comes due the moment the deploy items above are done. *(Phase 4.2 —
      [PHASE-4.md](PHASE-4.md#42-sentry-deliberately-not-built))*

### Real open work, not blocked on anything

- [ ] **Email verification at signup.** Password reset shipped without it, and
      it is the remaining half of 6.1 above. The provider is already there.
- [ ] **A real CSP for the document.** `frontend/public/_headers` sends
      `X-Frame-Options: DENY` instead, and now defers the CSP on one
      complication rather than two: the legal round self-hosted both font
      families, so no third-party origin is left for a policy to enumerate.
      What remains is the inline theme script that prevents the dark-mode
      flash — a policy written carelessly there still breaks first paint —
      and an inline script is exactly the case a hash or a nonce covers.
      *(Phase 7 follow-up)*
- [ ] **A `manualChunks` vendor split.** ~182 kB of React/Router is
      re-downloaded by returning visitors on every deploy. A few lines, and a
      different kind of split than §5.2's route-level one. *(Phase 5.2)*
- [ ] **A `webcal://` subscription feed.** A natural extension of §6.2's
      calendar export, reusing most of §6.7's token machinery, that would make
      the calendar live instead of a snapshot. *(Phase 6 follow-up)*
- [ ] **Growing the scholarship dataset (6.6).** Still 45 entries — ongoing
      curation on `scholarships.json`, not an engineering task.
- [ ] **Flaky test:** `App.test.tsx > /majors > falls back to the default for
      a slug nothing matches`. A pre-existing race that passes on most runs,
      which is exactly what has kept it unfixed. *(Phase 6 follow-up)*

### Considered and declined — listed for completeness, not a to-do

- **PWA / offline shell (§5.5).** A service worker's caching interacts with
  how Pages serves the app. Easier to reason about now that Phase 7's hosting
  shape actually exists, but still not obviously worth it.
- **A coverage-threshold gate (§3.2).** A percentage gate rewards covering
  whatever is cheapest to test; the priority order in §3.2 is the policy
  instead, deliberately.
- **A QR code for 2FA enrolment.** A QR encoder is ~350 lines of
  Reed–Solomon, against the project's zero-dependency rule. The `otpauth://`
  link is tappable on a phone and opens the authenticator directly — fewer
  steps than scanning — and the setup key in groups of four covers desktop.
- **Encrypting TOTP secrets at rest.** The key would live in the same
  Cloudflare account as the database, so it would defend only a leaked backup
  while adding a key-loss mode that locks out every enrolled user at once.
  Said plainly on the Security page rather than left implied.

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
- [x] Password reset — built after Phase 6 on Resend, rather than arriving
      with 6.1 as this line predicted. See the post-Phase-6 block below
- [ ] *Not built:* email verification at signup. Same provider, still open —
      and it is what §6.1's reminder emails are now waiting on

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
- [ ] **Blocked, not deferred:** branch protection requiring CI to pass. The
      original reason (no check names to point a rule at) has cleared — CI has
      reported green on `main` several times. The real blocker is that the repo
      is **private on a free plan**, and GitHub gates rulesets and classic
      branch protection behind Pro (`403 Upgrade to GitHub Pro or make this
      repository public`). Needs Pro or a public repo; options and settings in
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
- [x] Frontend error boundary — flagged here as a Phase 5 concern; built there.
      See Phase 5's checklist below.

**Phase 5 — Frontend polish** — **done** apart from §5.5, written up in [PHASE-5.md](PHASE-5.md)
- [x] `react-router-dom` routing — 14 routes, chrome split into `Layout.tsx`,
      `public/_redirects` for the SPA fallback Phase 7 needs. Nine navigation
      callback props became `<Link>`s. `/compare?ids=` and `/majors/:major`
      carry page state in the URL *(§2.7 suggested pulling this into Phase 2;
      deliberately deferred so the auth change stayed reviewable on its own)*
- [x] A gate for the bug the router created: a bookmarked `/matches` rendering
      before `/auth/me` answers used to tell someone with a profile to build one
- [x] Code-splitting — every page but Home and ProfileForm, one `Suspense`
      boundary inside the chrome, fallback invisible for its first 250ms.
      **239 kB → 210 kB**, smaller than before the router was added
- [x] Frontend error boundary — the gap [PHASE-4.md](PHASE-4.md) left open.
      Mounted twice (inside Layout, and outside the router), with a second
      state for the failure code-splitting introduced: a tab open across a
      deploy asking for a chunk hash that no longer exists
- [x] SEO meta tags, Open Graph, favicon set — generated by
      `frontend/scripts/build-icons.mjs`, so the binaries have a source
- [x] Per-route `document.title`
- [x] Accessibility audit — axe-core over 14 routes × 2 themes, zero
      violations. Four contrast failures were one mistake repeated: a token
      darkened to clear AA, then faded back below it with `opacity`
- [x] 155 frontend tests (was 99), 320 total
- [ ] **Deploy-day leftover:** every absolute URL in `index.html` is
      `https://compass.example.com`. Open Graph needs absolute URLs, so these
      cannot be real until §7.5 attaches the domain. **Three** occurrences —
      the canonical, `og:url` and `og:image`. The legal round later added two
      more of the same placeholder, in `.well-known/security.txt`, so the
      deploy-day total is five across two files.
- [ ] **Deliberately not done:** §5.5 PWA / offline shell. A service worker's
      caching interacts with how Pages serves the app; easier after Phase 7.
- [ ] *Not built:* a `manualChunks` vendor split. ~182 kB of React/Router is
      re-downloaded by returning visitors on every deploy. Four lines, but a
      different kind of split than §5.2 asks for.

**Phase 6 — Product roadmap** — **four of seven built**, written up in [PHASE-6.md](PHASE-6.md)
- [x] **Calendar export (.ics)** — `frontend/src/calendar.ts`, one button on the tracker.
      All-day events with a `VALARM` a week ahead, `STATUS:TENTATIVE` for a date that is
      only the plan's convention, rolling applications named rather than given an invented
      date. **This is the deliverable half of 6.1** — the reminder fires from the student's
      own calendar, needing no provider and no domain
- [x] **Essay brainstorm assistant** — a second mode on `/chat` (`?mode=essay`) over the
      same provider abstraction, with its own prompt and its own offline bank. Migration
      `0004` gives it a separate thread, which is what makes it a second assistant rather
      than differently-worded output; the 40-turn cap is per mode
- [x] **Admissions officer / contact tracker** — name, role, and last-contacted on
      `school_notes` (`0005`, `0007`). Past 30 days a card says how long a school has been
      quiet, past 90 it escalates. Deliberately **no email or phone** — a counselor's
      contact details are a third party's personal data
- [x] **Parent/counselor view** — one revocable read-only link per student (`0006`), no
      account on the other end. `GET /shared/:token` is the only unauthenticated read path
      into student data in the API; its payload is enumerated field by field, and chat,
      email, session, student id and `financialNeed` are all withheld
- [x] Settled-status list consolidated into `frontend/src/applicationStatus.ts` — it was
      about to become a fourth copy under a second name
- [x] 465 tests (was 320), backend 165 → 217 and frontend 155 → 248. Three axe violations
      found and fixed, including a pre-existing `--txf`-for-prose contrast failure the
      Phase 5 audit could not see because the element is empty almost always
- [ ] **Partly unblocked:** deadline reminder emails. The provider question is settled —
      Resend went in with password reset after Phase 6 — so what remains is a verified
      sending domain from §7.5 and email verification at signup. Revisit the *priority*
      too: §6.2 already delivers the reminder from the student's own device, needing
      neither. See [PHASE-6.md](PHASE-6.md#61--deadline-reminder-emails)
- [ ] **Not built — needs data, not code:** net price estimator. `universities.json` has
      sticker tuition and nothing else financial. Building it on invented aid figures would
      contradict how this app behaves everywhere else about numbers it cannot source
- [ ] *Not built:* growing the scholarship dataset. Still 45 entries; a curation task, as
      the section itself says
- [ ] *Follow-ups:* a `webcal://` subscription feed (the §6.7 token machinery is most of
      it, and would make the calendar live rather than a snapshot); and one pre-existing
      flaky test in `App.test.tsx` (`/majors` slug fallback). The `public/_headers`
      `Referrer-Policy` for the shared page landed in Phase 7

**After Phase 6 — hardening, account lifecycle, and legal** — five rounds that
are not numbered phases in this guide, landed between Phase 7's code half and its
account half
- [x] **Dead imports caught by the backend checker**, and the four it found cleared
      ([#10](https://github.com/kandakatla-ram/AI-Admissions-Advisor/pull/10))
- [x] **Legal and trust pages** — privacy, terms, and a security page, written from
      the code rather than a template: they name `compass_session`, PBKDF2 100k, and
      the `/api/students/:id` log patterns. Writing the limitations down is what got
      two of them fixed — see the next two items ([#11](https://github.com/kandakatla-ram/AI-Admissions-Advisor/pull/11))
- [x] **A cookie notice that is a notice, not a consent gate.** Compass sets exactly
      one strictly-necessary cookie, so an Accept/Reject pair would offer a choice
      that does not exist. One button, and a test asserting there is exactly one.
      **If analytics are ever added this must become a real gate that blocks the
      script until opt-in** — a deliberate fork, not a prop on the current component
- [x] **Self-hosted fonts** (`frontend/scripts/fetch-fonts.mjs`, `npm run fonts`).
      The Google Fonts `<link>` was the app's only third-party request and handed
      every visitor's IP to Google; it was removed rather than disclosed.
      `legalPages.test.tsx` guards the "no third-party requests" claim by scanning
      `index.html` itself, since one careless `<link>` would falsify a policy page
      with nothing looking broken
- [x] **Self-serve account deletion** — `DELETE /api/auth/account` and a deliberately
      ungated `/account` page, because a guest wiping a shared computer is who it
      matters most for. The delete order is load-bearing and counter-intuitive:
      `students.user_id` is a bare `REFERENCES` with no cascade, so deleting the user
      first fails on a constraint rather than orphaning anything. A member retypes
      their password (**403** on a wrong one, not 401 — 401 would sign them out over
      a typo); a guest has no password to retype. Offers a CSV export first, because
      erasure and portability are different rights ([#12](https://github.com/kandakatla-ram/AI-Admissions-Advisor/pull/12))
- [x] **Password reset over Resend** — a Worker has no raw sockets, so SMTP libraries
      do not run at all, and MailChannels' free Workers relay ended in 2024.
      `/auth/forgot` answers 202 with byte-identical bodies for every case, at equal
      speed via `executionCtx.waitUntil`, so it is not an enumeration oracle over
      teenagers' addresses. Tokens are SHA-256, not PBKDF2 — iterating defends a
      *low-entropy* secret, and there is no dictionary for 256 random bits. A
      successful reset revokes every session ([#13](https://github.com/kandakatla-ram/AI-Admissions-Advisor/pull/13))
- [x] **TOTP two-factor auth**, hand-written in `backend/src/auth/totp.ts` to hold the
      zero-dependency rule, and **verified against all six RFC 6238 Appendix B
      vectors** — a hand-rolled standard tested only against itself agrees with
      itself, not with Google Authenticator. Login stops at an `mfa_challenges` row
      rather than a half-authenticated session, and password reset deliberately does
      **not** bypass 2FA: email is already the reset channel, so bypassing would
      leave the inbox a full takeover path ([#14](https://github.com/kandakatla-ram/AI-Admissions-Advisor/pull/14))
- [x] 666 tests passing, up from 465 at Phase 6 — backend 311, frontend 355
- [ ] *Not built:* email verification at signup. The provider is in place now, so
      this is the one thing still standing between §6.1 and its reminder emails
- [ ] **Deploy-day leftovers these rounds added:** three more Production secrets
      (`RESEND_API_KEY`, `EMAIL_FROM`, `APP_ORIGIN`), the three operator placeholders
      in `frontend/src/legal.ts`, `security.txt`'s `Expires` and `Canonical`, and
      "Private vulnerability reporting" switched on for the repo

**Phase 7 — Cloudflare Pages + Workers hosting** — **code half done**, account
half is a runbook in [PHASE-7.md](PHASE-7.md)
- [x] Architecture chosen — Option A (Pages + Functions), kept deliberately even
      though Cloudflare now recommends Workers for new projects
- [x] `functions/api/[[route]].ts` + `backend/src/pages.ts` — the adapter is not
      where §7.1 puts it, because `hono` cannot resolve from `functions/`
- [x] Root `wrangler.toml` in Pages mode — the deployed config, in git rather
      than in dashboard fields. Duplicates compatibility settings and the DB
      binding from `backend/wrangler.toml`, which vitest still reads
- [x] `[env.preview]` binding a separate `compass-db-preview`, so an unreviewed
      PR preview cannot write to real student data
- [x] `LOG_LEVEL` deliberately **not** declared — declaring it would freeze the
      dashboard field Phase 4 created it for
- [x] `frontend/public/_headers` — closes PHASE-6's deferred `Referrer-Policy`
      item, and closes a gap nobody had noticed: the HTML document had no frame
      protection at all, since `secure-headers` only covers `/api/*`
- [x] Remote migrations moved to root scripts (`db:migrate:remote`,
      `db:migrate:preview`) — the backend's version could only ever have failed,
      resolving against a config with a placeholder database id
- [x] CI builds the Pages Functions bundle, the only step exercising the deploy path
- [x] Verified locally end-to-end with `npm run preview` (`wrangler pages dev`):
      D1 reachable through the Function, deep SPA routes served, headers applied
- [ ] Wrangler login, D1 databases created, Pages project connected to GitHub
- [ ] Migrations applied to both databases
- [ ] Secrets set on Production — `ANTHROPIC_API_KEY`, and since password reset
      landed also `RESEND_API_KEY`, `EMAIL_FROM` and `APP_ORIGIN`; Preview
      deliberately none
- [ ] Custom domain attached — also unblocks the five `compass.example.com`
      placeholders (three in `index.html`, two in `.well-known/security.txt`)
      and the WAF rule below
- [x] Naming convention picked — `compass-web`, `compass-db`, `compass-db-preview`
- [ ] Post-deploy smoke test (incl. second-device data check)
- [ ] **Blocked, not pending:** the global rate limit. WAF rate limiting rules
      are zone-scoped, so there is nothing to attach one to until a custom
      domain exists — and a **15-minute** counting period needs a **Business**
      plan (Free and Pro cap it at 1 minute; Free allows one rule total). Until
      then there is no global limit at all. LLM spend is still capped by the
      in-code `/api/chat` limiter
- [ ] **Blocked, not pending:** PBKDF2 vs. the plan. Free caps CPU at 10ms per
      invocation (confirmed current); 100k iterations costs 40–60ms, so signup
      and login **fail outright** on Free. Settle before the first real signup

**Phase 8 — Post-launch operations**
- [ ] Backup plan beyond D1's Time Travel window confirmed
- [ ] Uptime monitoring on `/api/health`
- [ ] First few weeks of LLM cost usage reviewed against the rate limit
