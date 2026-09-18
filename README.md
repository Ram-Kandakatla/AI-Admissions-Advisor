# Compass — AI College Admissions Advisor

An AI-powered assistant that helps high school students build a personalized college
application plan. It recommends universities from a student's GPA, coursework,
extracurriculars, and career interests, and includes a chatbot that answers admissions
and financial-aid questions. The architecture is built to extend toward scholarship and
internship recommendation engines.

Built to the [step-by-step guide](ClaudeAIAdmissionsSteps.md) and the
[web-design standards](ClaudeWebDesign.md) in this repo. The hosting roadmap is
[IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md); each completed phase has its own
write-up — [PHASE-1.md](PHASE-1.md) (Workers/D1 migration),
[PHASE-2.md](PHASE-2.md) (accounts), [PHASE-3.md](PHASE-3.md) (testing & CI),
[PHASE-4.md](PHASE-4.md) (observability), [PHASE-5.md](PHASE-5.md) (routing,
code-splitting, accessibility), [PHASE-6.md](PHASE-6.md) (calendar export, essay
assistant, contacts, sharing), and [PHASE-7.md](PHASE-7.md) (hosting).

## What's inside

| Piece | Stack | Folder |
|-------|-------|--------|
| **Frontend** | React + TypeScript (Vite) | [`frontend/`](frontend) |
| **Backend API** | Hono on the Cloudflare Workers runtime | [`backend/`](backend) |
| **Chatbot** | Claude or OpenAI, with an offline fallback | [`backend/src/services/llmService.ts`](backend/src/services/llmService.ts) |
| **Data** | 42-university + 45-scholarship JSON datasets | [`backend/data/`](backend/data) |
| **Persistence** | Cloudflare D1 — profiles, chat, applications, and notes survive a restart | [`backend/src/store/`](backend/src/store) |

### Features

- **Student profile** — GPA, SAT/ACT, intended majors, extracurriculars/coursework,
  career goals, financial need, and preferred regions.
- **Recommendation engine** — sorts real universities into **reach / target / safety**,
  each with a match score and plain-English reasons (GPA/test proximity, major fit,
  region, and financial fit).
- **Scholarship matcher** — the same reach / target / safety treatment for money, over a
  curated set of national awards. Anything whose GPA floor, major restriction, or need
  requirement you don't meet is filtered out before you see it. Deadlines are shown as the
  month a program *usually* closes, never as a confirmed date, and every card links to the
  sponsor's own page.
- **University explorer** — search, filter, and sort the whole dataset.
- **Notes & saved schools** — star any school and write down what you thought
  ("great CS program", "too expensive", "emailed their admissions officer"). There is exactly
  one note per school, shared by the match cards, the explorer, the comparison grid and the
  tracker, collected on a **Saved** page that prints or exports.
- **Ask Compass chatbot** — LLM-powered answers on deadlines, essays, tests, and aid,
  personalized to the student's profile. Falls back to a built-in guide with no API key.
  A second mode, **Essay brainstorm**, helps find a topic and tighten a draft — it asks
  questions rather than writing prose, and keeps its own conversation thread.
- **Calendar export** — download your tracked deadlines as an `.ics` file for Google
  Calendar, Apple Calendar, or Outlook. Each one arrives as an all-day entry with a
  reminder a week ahead. Dates that are only the usual convention for a decision plan
  import as *tentative*, so the caveat survives leaving the app.
- **Admissions contacts** — record who handles your application at each school and when
  you last spoke to them. A school you haven't contacted in months says so.
- **Share your plan** — hand a parent or counselor a read-only link. No account needed on
  their end, revocable at any time, and it never exposes your chat, your email, or what
  you said about your family's finances.

## Run it locally

Requires **Node 22.5 or newer**. There's an `.nvmrc`, so `nvm use` picks the right one.

```bash
npm run setup            # installs backend + frontend, then creates the local D1 schema
npm run dev              # both servers, one terminal
```

Open **http://localhost:5173**. The frontend proxies `/api` to the backend Worker on
port 8787.

The `setup` step matters on a first run: the backend is a Cloudflare Worker backed by
D1, and `wrangler dev` will happily boot against a database with no tables in it. If
every route returns a 500, you skipped the migration — `npm run db:migrate`.

No Cloudflare account is needed. `wrangler dev` runs a real local D1 (SQLite under
`backend/.wrangler/state`), so the whole stack works offline.

To see the app in its **deployed** shape instead — one origin serving the built
frontend and the API together, the way Cloudflare Pages runs it:

```bash
npm run preview          # wrangler pages dev, port 8788
```

Use it when a bug looks origin- or routing-related; `npm run dev` is better for
everything else, since it has hot reload and this does not.

<details>
<summary>Prefer two terminals?</summary>

```bash
npm run dev:backend      # wrangler dev, port 8787
npm run dev:frontend     # vite, port 5173
```
</details>

Set **one** key in `backend/.dev.vars` to enable the live chatbot — `ANTHROPIC_API_KEY`
([console.anthropic.com](https://console.anthropic.com)) or `OPENAI_API_KEY`
([platform.openai.com/api-keys](https://platform.openai.com/api-keys)). Claude wins if
both are present. A key that's set but malformed is logged and then ignored, so a bad
paste shows up in your terminal rather than as a failed chat message later.

> **No API key?** The chatbot runs in offline mode with a built-in knowledge base, so the
> whole app is fully usable for demos.

### Configuration

Secrets go in `backend/.dev.vars` (gitignored; see
[`backend/.dev.vars.example`](backend/.dev.vars.example)). Non-secret settings live in
[`backend/wrangler.toml`](backend/wrangler.toml). Everything is optional.

| Variable | Where | Default | What it does |
|----------|-------|---------|--------------|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | `.dev.vars` | unset | Enables the live chatbot. |
| `ANTHROPIC_MODEL` / `OPENAI_MODEL` | `.dev.vars` | per-provider default | Override the model. |
| `CORS_ORIGIN` | `wrangler.toml` | `http://localhost:5173` | Comma-separated origins allowed to call the API from a browser. |
| `LOG_LEVEL` | `wrangler.toml` | `info` | `debug`, `info`, `warn`, `error` or `silent`. A var rather than a secret so it can be turned up mid-incident without a redeploy. |

`PORT`, `COMPASS_DB`, and `TRUST_PROXY` are gone. The first two were Node concepts with
no Worker equivalent. `TRUST_PROXY` existed so the rate limiter could find the real
client IP behind a proxy — Cloudflare sets `CF-Connecting-IP` itself and a client cannot
forge it, so that whole class of misconfiguration disappeared with the platform change.

## Tests

```bash
npm test                 # both suites
npm run test:backend     # engines, data integrity, API endpoints, hardening
npm run test:frontend    # exports, dates, the shared notes store, two screens
```

**264 tests.** Two suites, two runtimes, deliberately not shared:

**Backend — 165 tests, 10 suites, inside the real Workers runtime.** Vitest via
`@cloudflare/vitest-pool-workers`, against a real D1 database built from the same
`migrations/` files that get deployed. Plain Node has no D1 binding and no per-request
`env`, so a mock would have meant tests that pass while the real Worker breaks. The
suites share one test database and never touch `backend/.wrangler/state` or the old
`backend/data/compass.db`.

[`test/security.test.ts`](backend/test/security.test.ts) covers the middleware rather
than any feature — security headers, the CORS allowlist, the request-size cap, the chat
rate limiter, that errors carry no stack traces, and API-key validation. None of that
changes app behaviour when it regresses, which is precisely why it needs its own test.

[`test/logging.test.ts`](backend/test/logging.test.ts) is the same idea applied to the
log: its load-bearing assertions are about what a log line does *not* contain — no
student id, no email, no password, no session cookie — checked against the raw text, so
a leak inside a nested field or a stack trace cannot slip past.

**Frontend — 99 tests, 6 suites, in jsdom.** Vitest + Testing Library, covering the
pure functions that quietly produce wrong output rather than crashing
([`exportList.ts`](frontend/src/exportList.ts), [`dates.ts`](frontend/src/dates.ts),
[`compare.ts`](frontend/src/compare.ts)), the notes store five pages share
([`useSchoolNotes.ts`](frontend/src/useSchoolNotes.ts)), and the two screens where a
wrong answer costs a student real work — [`ProfileForm`](frontend/src/components/ProfileForm.tsx)
and [`ApplicationTracker`](frontend/src/components/ApplicationTracker.tsx).

The frontend suite runs pinned to `America/New_York`. That is not a preference:
`dates.ts` exists because `new Date("2026-01-15")` parses as UTC midnight and renders as
Jan 14 anywhere west of Greenwich, and a suite running in UTC — which is what a CI runner
gives you by default — cannot observe that bug at all.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs both suites, both
typechecks, and the frontend build on every pull request and every push to `main`.

It also builds the Pages Functions bundle — the one step that exercises the deploy path.
`functions/` has no `node_modules` above it, so a package imported from there resolves
fine in an editor and then fails in Cloudflare's build; this catches that on the pull
request instead.

It deliberately does **not** deploy. Cloudflare Pages' git integration builds and deploys
on push and gives every PR its own preview URL, which is less to maintain than wiring
`wrangler deploy` into Actions and keeping an API token in repository secrets. Actions
says whether the code is safe to merge; Cloudflare ships it.

## Deploying

One Cloudflare Pages project serves both halves on one origin: the built frontend from
`frontend/dist`, and the API from `functions/api/[[route]].ts`, which re-exports the same
Hono app the local Worker runs. Same origin, so there is no CORS to configure and one
thing to deploy.

The deployed configuration is the root [`wrangler.toml`](wrangler.toml) — in git rather
than in dashboard fields, so it is reviewable. `backend/wrangler.toml` is the local-only
one; the two duplicate a few keys by necessity and both say so.

Preview deployments bind a **separate** database, so an unreviewed pull request cannot
write to real profiles, and get no LLM key, so they run the offline fallback and cost
nothing.

The account setup — sign-in, creating the databases, connecting the repo, secrets, the
domain — is a step-by-step runbook in [PHASE-7.md](PHASE-7.md). Both databases now exist
and carry every migration; what is left there starts at connecting the repo to Pages.

One item remains **blocked rather than pending**: the global rate limit needs both a
custom domain and a paid plan. The other, PBKDF2's cost against the free plan's 10ms CPU
limit, was settled by lowering `ITERATIONS` to 25,000 — see
[`backend/src/auth/password.ts`](backend/src/auth/password.ts), which also explains why
a later change to that number has to keep the login upgrade path alongside it.

## Observability

The API writes one structured JSON line per request, plus a line for anything that
fails. `console` output is picked up automatically by `wrangler tail` locally and by
Workers Logs once deployed, so there is no log shipper to configure.

```
{"level":"info","msg":"request","method":"GET","route":"/api/students/:id","status":200,"ms":4}
```

`route` is the matched **pattern**, never the concrete path. A student id identifies a
real teenager and logs are retained; the pattern carries the whole operational signal —
which endpoint, how often, what status, how slow — and none of the identifier. Health
checks log at `debug` so Phase 8's uptime monitor cannot flood the log, and 4xx stays at
`info` because a 401 here is an expired session rather than a fault.

[`GET /api/health`](backend/src/app.ts) probes D1 with a `SELECT 1` and answers 503 when
it fails, so monitoring can tell "the Worker is down" apart from "the Worker is up but
D1 is unreachable." Details and the reasoning are in [PHASE-4.md](PHASE-4.md).

## Design

A warm, editorial "guidance-counselor" direction: cream paper, deep pine ink, a
clay/terracotta accent with forest-green and ochre supports; Fraunces (display) + Inter
Tight (body). Fully responsive, keyboard-accessible, and `prefers-reduced-motion`-aware.

## Data & persistence

Profiles, chat history, tracked applications, and school notes live in Cloudflare D1.
The schema is in [`backend/migrations/`](backend/migrations) and applied with
`npm run db:migrate`. Locally that is a SQLite file under `backend/.wrangler/state`,
gitignored — it holds real student data and never belongs in the repo — and in
production it is the managed D1 database, same SQL either way.

[`store/dataStore.ts`](backend/src/store/dataStore.ts) is a `createStore(db)` factory
built once per request, because a Worker has no module-level state that survives between
requests to hold a connection in.

Universities and scholarships stay as JSON in [`backend/data/`](backend/data) — they're
reference data, not user data, and belong in version control where a diff is reviewable.
Scholarship entries record the *month* a program typically closes plus the sponsor's URL;
they deliberately never assert a date, for the same reason
[`models/application.ts`](backend/src/models/application.ts) doesn't.

## Extending it (roadmap)

The store and services are written to be swapped without touching the UI:

- **Accounts** — built in Phase 2. A guest gets a real (email-less) account row so a
  profile is owned from the first write, and signing up fills in that same row rather than
  reparenting anything. See [PHASE-2.md](PHASE-2.md).
- **Beyond D1** — D1 is SQLite, so it is single-writer per database. If write throughput
  ever outgrows it, [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) lets a
  Worker talk to an external Postgres. That is a "years from now, if ever" concern at this
  scale — and the store is already async, so it would no longer be the rewrite it once was.
- **More scholarships** — [`backend/data/scholarships.json`](backend/data/scholarships.json)
  is a plain curated file. No free public scholarship API exists (Fastweb and College Board
  don't publish one), so growing this list means curating it or licensing a feed.
- **Aid figures** — the dataset carries sticker tuition and nothing else financial, which
  is why there is no net-price estimator. Adding average grant by income bracket and
  percent-of-need-met (IPEDS or the College Scorecard, cited per school) would unlock one.
  See [PHASE-6.md](PHASE-6.md#64--net-price-estimator).
