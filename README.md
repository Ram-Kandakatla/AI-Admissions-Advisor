# Compass — AI College Admissions Advisor

An AI-powered assistant that helps high school students build a personalized college
application plan. It recommends universities from a student's GPA, coursework,
extracurriculars, and career interests, and includes a chatbot that answers admissions
and financial-aid questions. The architecture is built to extend toward scholarship and
internship recommendation engines.

Built to the [step-by-step guide](ClaudeAIAdmissionsSteps.md) and the
[web-design standards](ClaudeWebDesign.md) in this repo. The hosting roadmap is
[IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md); the Workers/D1 migration that
Phase 1 performed is written up in [PHASE-1.md](PHASE-1.md).

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

`PORT`, `COMPASS_DB`, and `TRUST_PROXY` are gone. The first two were Node concepts with
no Worker equivalent. `TRUST_PROXY` existed so the rate limiter could find the real
client IP behind a proxy — Cloudflare sets `CF-Connecting-IP` itself and a client cannot
forge it, so that whole class of misconfiguration disappeared with the platform change.

## Tests

```bash
npm test      # engines, data integrity, API endpoints, and hardening
```

99 tests across 7 suites, run by Vitest **inside the real Workers runtime**
(`@cloudflare/vitest-pool-workers`), against a real D1 database built from the same
`migrations/` files that get deployed. Plain Node has no D1 binding and no per-request
`env`, so a mock would have meant tests that pass while the real Worker breaks.

The suites share one test database and never touch `backend/.wrangler/state` or the old
`backend/data/compass.db`.

[`test/security.test.ts`](backend/test/security.test.ts) covers the middleware rather
than any feature — security headers, the CORS allowlist, the request-size cap, the chat
rate limiter, that errors carry no stack traces, and API-key validation. None of that
changes app behaviour when it regresses, which is precisely why it needs its own test.

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

- **Accounts** — the schema is keyed by student id already; adding a users table and a
  session cookie is the remaining step.
- **Beyond D1** — D1 is SQLite, so it is single-writer per database. If write throughput
  ever outgrows it, [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) lets a
  Worker talk to an external Postgres. That is a "years from now, if ever" concern at this
  scale — and the store is already async, so it would no longer be the rewrite it once was.
- **More scholarships** — [`backend/data/scholarships.json`](backend/data/scholarships.json)
  is a plain curated file. No free public scholarship API exists (Fastweb and College Board
  don't publish one), so growing this list means curating it or licensing a feed.
