# Phase 1 — Express + `node:sqlite` → Hono + D1

What changed, why, and the two things this phase deliberately left for deploy day.

The short version: the backend now runs on the Cloudflare Workers runtime.
Nothing about the API contract changed — every route, status code, and response
body is what it was — but almost every line behind them did, because Express
and `node:sqlite` cannot run in a V8 isolate at all.

## Why this could not be deferred

Workers execute in V8 isolates, not Node.js: no filesystem, no native addons,
no long-lived process to hold a module-level database connection. That rules
out `node:sqlite` (needs a real file) and Express (expects Node's
`http.Server` request/response objects). It is a hard incompatibility, not a
tuning problem — so it had to happen before any more code was written against
the old stack.

## The five structural changes

**1. Express → Hono.** Route shapes barely moved (`res.json(x)` →
`return c.json(x)`). What did move is where the app lives: [`src/app.ts`](backend/src/app.ts)
exports the Hono instance, and [`src/index.ts`](backend/src/index.ts) is a
three-line Worker entry. Phase 7 adds `functions/api/[[route]].ts` importing
the same app — a four-line file, not a second migration.

**2. `node:sqlite` → D1, and the store became a factory.** `db.js` opened one
`DatabaseSync` at import time that every caller shared. A Worker has no module
state that survives between requests; the D1 binding arrives on `c.env` per
request. So [`dataStore.ts`](backend/src/store/dataStore.ts) is now
`createStore(db)`, built once per request by a middleware in `app.ts`.

**3. Everything became async.** D1's `prepare().bind().first()/all()/run()`
return Promises. Every store method and every route handler that calls one is
now `async`. This is the change most likely to hide a bug — a forgotten `await`
returns a Promise that serializes to `{}` in JSON without erroring — which is
the main reason the backend moved to TypeScript at the same time.

**4. Reference data is imported, not read.** `universities.json` and
`scholarships.json` were loaded with `fs.readFileSync` and memoized. There is
no filesystem in a Worker, so [`staticData.ts`](backend/src/store/staticData.ts)
imports them as modules and Wrangler inlines them into the bundle. The engines
now take their data as a parameter with a default and never touch D1, which
also makes them directly testable.

**5. Writes use `RETURNING`.** The old code wrote, then re-read to get the
stored row back. Locally that was two cheap function calls; against D1 it is
two network round trips. `INSERT ... RETURNING *` collapses them into one.

## Security: same decisions, different packages

`helmet`, the `cors` package, and `express-rate-limit` are all Node-specific.
The *decisions* from commit `05b8bf2` carried over unchanged:

| Concern | Express | Now |
|---|---|---|
| Security headers | `helmet()` | `hono/secure-headers` |
| CORS allowlist | `cors({ origin })` | `hono/cors`, same allowlist logic |
| Body cap (100kb) | `express.json({ limit })` | [`middleware/bodyLimit.ts`](backend/src/middleware/bodyLimit.ts) + a byte check in [`http.ts`](backend/src/http.ts) |
| `/api/chat` limit (30/15min) | `express-rate-limit` | [`middleware/rateLimit.ts`](backend/src/middleware/rateLimit.ts), counters in D1 |
| Global limit (300/15min) | `express-rate-limit` | **Not in code — a WAF rule, see below** |

Two things got *better* rather than merely ported:

- **`TRUST_PROXY` is gone.** It existed so `express-rate-limit` could find the
  real client IP behind a proxy, and getting it wrong either collapsed every
  visitor into one bucket (too low) or let a client forge `X-Forwarded-For` to
  escape the limiter (too high). Cloudflare sets `CF-Connecting-IP` itself and
  a client cannot forge it, so that entire class of misconfiguration is gone.
- **`GET /api/health` now probes D1.** It returns `database: "ok"` or
  `"unreachable"` (503), so uptime monitoring can tell "the Worker is up" apart
  from "the Worker is up but the database isn't". That was Phase 4.3; it cost
  one trivial query to do now.

### Left for deploy day: the global rate limit

The chat limiter lives in code because it caps real LLM spend per caller and
must work locally. The global 300/15min limiter does not — as a Cloudflare Rate
Limiting Rule it runs at the edge, in front of the Worker, with no counter to
maintain and no per-request cost.

**Create these in the dashboard at Phase 7** (Security → WAF → Rate limiting rules):

| Rule | Match | Limit | Action |
|---|---|---|---|
| `compass-global` | `http.request.uri.path starts_with "/api/"` | 300 / 15 min per IP | Block |
| `compass-chat-edge` | `http.request.uri.path eq "/api/chat"` | 60 / 15 min per IP | Block |

The second is a backstop, deliberately looser than the in-code 30/15min so the
Worker's own limiter — which returns a helpful message and `Retry-After`, and
which Phase 2 will re-key from IP to user — is what callers normally hit.

**Until then there is no global limit locally.** That is fine on a laptop and
is written down here rather than assumed.

## Tests: Jest → Vitest in the Workers runtime

All seven suites moved. Jest runs in plain Node, which has no D1 binding and no
per-request `env`; faking those would have produced tests that pass against a
mock while the real Worker breaks. `@cloudflare/vitest-pool-workers` runs the
suites inside `workerd` with a real D1 database built from
[`migrations/`](backend/migrations) — the same files `wrangler` deploys, so the
test schema cannot drift from production's.

`supertest` was replaced by `SELF.fetch` from `cloudflare:test`, which
dispatches into the real Worker through the whole middleware stack. See
[`test/helpers.ts`](backend/test/helpers.ts).

One test assertion changed meaning, and it is commented where it lives: the
"global rate limiter is mounted" test became a set of chat-limiter tests, for
the reason above.

`vitest.config.ts` pins `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` to empty
strings. Wrangler loads `.env` into the test environment too, so without that
override a developer holding a real key would quietly bill themselves on every
test run of the chat route.

## Local development

```bash
npm run setup    # install both halves, then apply D1 migrations locally
npm run dev      # wrangler dev on :8787 + Vite on :5173
```

`wrangler dev` runs a real local D1 (SQLite under `backend/.wrangler/state`),
so the whole stack works offline with no Cloudflare account.

Secrets go in `backend/.dev.vars` (gitignored; see `.dev.vars.example`).
Wrangler also still reads `backend/.env`, so an existing one keeps working.

## What did not change

- Every route path, status code, and response body.
- The recommendation, scholarship, and major-insight scoring logic — ported
  line for line, with types added and nothing else.
- The offline chatbot fallback, its keyword table, and its answers.
- The frontend, apart from the Vite proxy target (`:4000` → `:8787`).
- `data/universities.json` and `data/scholarships.json`.

## Known follow-ups

- `backend/data/compass.db` is the old SQLite file. It is untouched, still
  gitignored, and no longer read by anything. Delete it once you're sure you
  don't want the profiles in it; there is no importer.
- `wrangler.toml`'s `database_id` is a placeholder until `wrangler d1 create`
  runs in Phase 7.3. Local dev ignores it.
- The chat limiter keys on IP. Phase 2 should re-key it to the session user,
  which is the point of doing it in code rather than at the edge.
