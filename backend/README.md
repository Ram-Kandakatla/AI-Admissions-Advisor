# Backend — Compass API

[Hono](https://hono.dev) on the Cloudflare Workers runtime, with
[D1](https://developers.cloudflare.com/d1/) for storage: a university dataset, a
rule-based recommendation engine, a scholarship matcher, and a Claude-powered
admissions chatbot (with an offline fallback so it works without an API key).

Ported from Express + `node:sqlite` in Phase 1 — see [`../PHASE-1.md`](../PHASE-1.md)
for what changed and why.

## Run it

```bash
npm install
npm run db:migrate:local          # create the local D1 schema — required on first run
cp .dev.vars.example .dev.vars    # optional: add ANTHROPIC_API_KEY for real chatbot answers
npm run dev                       # wrangler dev on http://localhost:8787
```

Or from the repo root, `npm run setup && npm run dev` does both halves at once.

`wrangler dev` runs a real local D1 instance (SQLite under `.wrangler/state`),
so the whole stack works offline with no Cloudflare account. Skipping the
migrate step is the one confusing first run: the Worker boots fine and every
route 500s on a missing table.

| Command | What it does |
|---|---|
| `npm run dev` | Local Worker + local D1 on :8787 |
| `npm test` | Vitest inside the real Workers runtime (`workerd`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate:local` | Apply `migrations/` to the local D1 |
| `npm run db:migrate:remote` | Apply them to the deployed D1 (Phase 7) |

## Layout

```
src/
  index.ts          Worker entry, shared by both wrangler configs
  app.ts            the Hono app: middleware stack + every non-auth route
  routes/auth.ts    signup, login, password reset, 2FA, account deletion
  auth/             password hashing, TOTP, the wrong-code limit
  http.ts           JSON body reader (413 / 400 handling)
  crypto.ts         hex, SHA-256, constant-time compare
  math.ts           round, clamp
  log.ts            structured JSON logging
  types.ts          bindings, domain types, Hono's context types
  models/           validation and normalization — pure, no I/O
  services/         recommendation, scholarship, major-insight engines; LLM and email clients
  store/
    dataStore.ts    createStore(db) — the async D1 factory
    staticData.ts   universities/scholarships, imported not read (no filesystem)
  middleware/       sessions, rate limiting, CSRF guard, body cap, request log
migrations/         D1 schema, applied by wrangler and by the test setup
test/               Vitest suites, run inside workerd against a real D1
```

## Chatbot modes

The provider is chosen by whichever key is set (in `.dev.vars` locally, or
`wrangler secret put` when deployed):

- **`ANTHROPIC_API_KEY`** → Claude (`claude-opus-4-8`). Wins if both are set.
- **`OPENAI_API_KEY`** → OpenAI (`gpt-4o`).
- **Neither** → a built-in keyword knowledge base answers common questions
  (FAFSA, deadlines, essays, tests, scholarships, building a list). Good for demos,
  and what PR previews will run on (Phase 7.4) so previews cost nothing.

Override models with `ANTHROPIC_MODEL` / `OPENAI_MODEL`. Check which mode is
active at `GET /api/health` — it returns `"claude"`, `"openai"`, or `"fallback"`.

A key that is set but malformed is logged once per isolate and then ignored, so
a bad paste degrades to the offline fallback instead of throwing a 401 at the
first student who asks a question.

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/signup` | Start an account — answers "check your inbox" for every address |
| POST | `/api/auth/verify` | Confirm it from the emailed link — claims the caller's guest profile, signs in |
| POST | `/api/auth/login` | Start a session |
| POST | `/api/auth/logout` | Revoke the session |
| GET | `/api/auth/me` | Current user + their student id |
| POST | `/api/auth/forgot` | Email a reset link — the same 202 for every address |
| POST | `/api/auth/reset` | Set a new password from the link (`code` too if 2FA is on); signs in |
| DELETE | `/api/auth/account` | Erase the account (`{ confirm: "DELETE", password? }`) |
| GET | `/api/auth/2fa` | Whether 2FA is on, and recovery codes left |
| POST | `/api/auth/2fa/setup` | Stage a TOTP secret (password, plus a code if 2FA is already on) |
| POST | `/api/auth/2fa/enable` | Confirm with a code; returns recovery codes once |
| POST | `/api/auth/2fa/disable` | Turn 2FA off (password + code) |
| POST | `/api/auth/2fa/recovery-codes` | Replace the recovery codes (password + code) |
| POST | `/api/auth/2fa/verify` | Finish a login that stopped at the second factor |
| GET | `/api/health` | Service + LLM + D1 status |
| GET | `/api/meta` | Majors / regions / need levels for form dropdowns |
| GET | `/api/universities` | All universities. Filters: `region`, `major`, `maxTuition`, `search` |
| GET | `/api/majors` | Every major with a school count |
| GET | `/api/majors/:major` | Deep dive on one major (`?studentId=` to personalize) |
| POST | `/api/students` | Create a student profile |
| GET | `/api/students/:id` | Get a profile |
| PUT | `/api/students/:id` | Update a profile |
| GET | `/api/students/:id/recommendations` | Tiered matches (reach/target/safety) |
| GET | `/api/students/:id/scholarships` | Tiered scholarship matches |
| GET | `/api/students/:id/notes` | Starred schools + notes |
| PUT | `/api/students/:id/notes/:universityId` | Star and/or annotate one school |
| DELETE | `/api/students/:id/notes/:universityId` | Forget a school entirely |
| GET | `/api/application-meta` | Decision plans, statuses, checklist |
| GET | `/api/students/:id/applications` | Tracked applications |
| POST | `/api/students/:id/applications` | Track a university |
| PATCH | `/api/students/:id/applications/:appId` | Update one application |
| DELETE | `/api/students/:id/applications/:appId` | Stop tracking |
| POST | `/api/chat` | Ask the chatbot (`{ studentId?, question, mode? }`) — rate limited, 30/15min per account (per IP for guests) |
| GET | `/api/students/:id/chat` | One thread's history (`?mode=advising\|essay`) |
| GET | `/api/students/:id/share` | The student's share link, if any |
| POST | `/api/students/:id/share` | Create it, or `{ rotate: true }` to replace it |
| DELETE | `/api/students/:id/share` | Revoke it |
| GET | `/api/shared/:token` | The read-only shared plan — no session; the token is the credential |

> **Every `/api/students/:id` route is behind an ownership check** (Phase 2).
> The session cookie names an account; the account owns at most one profile;
> the id in the path must be that profile. `/api/majors/:major?studentId=` and
> `POST /api/chat`'s `studentId` are checked the same way, since they return
> profile-derived output from outside that path prefix.
>
> **No account is required to start.** The first `POST /api/students` from a
> visitor with no session mints an anonymous account and issues the cookie, so
> a guest profile is owned from the moment it exists. Signing up later fills in
> the email and password on that same account row — the profile is never
> reparented.
>
> An id you do not own answers **403**, whether or not it exists, and a caller
> with no session at all answers **401**. Existence is deliberately not
> distinguishable from lack of access.

### Student profile shape

```jsonc
{
  "name": "Ana",
  "gpa": 3.8,              // 0–5.0 (weighted allowed)
  "satScore": 1450,        // optional, 400–1600
  "actScore": null,        // optional, 1–36
  "interestedMajors": ["CS", "Data Science"],
  "extracurriculars": ["Robotics", "Debate"],
  "careerGoals": "Software engineering",
  "financialNeed": "medium",           // high | medium | low
  "preferredRegions": ["West", "Northeast"]
}
```

## How recommendations work

For each school the engine requires an overlap with an intended major, then scores
academic proximity (GPA/SAT), major fit, region preference, and financial fit. Schools
are grouped into **reach / target / safety** by selectivity and GPA distance, each with
a `matchScore` and plain-English `reasons`. See
[`src/services/recommendationEngine.ts`](src/services/recommendationEngine.ts).

**A GPA gap means different things at different admission rates.** `classifyTier` used to
read `acceptanceRate > 40` as a binary, so a school admitting 98% of applicants and one
admitting 41% were treated identically and the whole decision rested on `gpaGap` — which
put Cal State Stanislaus (98.1% admit) in "reach" for a 3.2 student, along with 69 other
schools admitting ≥85%. The thresholds now widen as admission gets easier: a student must
be 0.6 below the typical admit before an open-admission school counts as a reach, and may
sit 0.3 below and still call it a safety. Two invariants hold regardless — under 12% admit
is a reach for everyone, and nothing at or under 40% is ever a safety. The change only ever
moves a school toward "easier", so it cannot newly discourage a student; a test asserts
that across the whole input space.

**The SAT term is scored only when it is independent evidence.** Most schools' `avgGPA`
is interpolated from their `avgSAT` (see below), which makes `gpaGap` and `satGap` the
same measurement — scoring both would earn such a school up to 26 points from one number
where a school with a single signal earns 18. So the SAT term is skipped for
`gpaSource: "estimated-sat"`, and for test-blind schools, which have no SAT at all. A
curated school keeps both, because there the two figures really are separate.

Data lives in [`data/universities.json`](data/universities.json) (757 schools) and
[`data/scholarships.json`](data/scholarships.json) (45 awards). Profiles, chat history,
tracked applications, and school notes live in D1 — see
[`src/store/dataStore.ts`](src/store/dataStore.ts).

`/students/:id/recommendations` returns the **20 strongest per tier**, with `counts`
carrying the true totals so the page can say what it held back. Uncapped, a mid-range
student matched ~550 schools, which rendered 16,500 DOM nodes and turned "Save as PDF"
(`window.print()`) into a 64-page document. Browsing the whole set is what `/explore` is
for.

## Where the university data comes from

715 of the 757 schools are imported from the U.S. Department of Education's
[College Scorecard](https://collegescorecard.ed.gov/data/) (public domain). The other 42
are the original hand-curated set and are preserved exactly — the importer matches them
by IPEDS `UNITID`, never by name.

Re-import after a Scorecard release (roughly annual) with the institution-level CSV:

```
npm run data:import -- --csv ~/Downloads/Most-Recent-Cohorts-Institution.csv
```

It is idempotent — re-running against the same CSV produces a byte-identical file. See
[`scripts/import-scorecard.mjs`](scripts/import-scorecard.mjs) for the selection rules
and field mappings, which carry the reasoning inline. Three things worth knowing:

- **GPA is estimated, and labelled.** No federal dataset publishes average admit GPA —
  only each school's own Common Data Set does, in a PDF that is frequently blank. Every
  imported school carries an estimate and the UI marks it, so an inferred figure never
  reads as a reported one. `gpaSource` says which: `estimated-sat` interpolates from the
  SAT average (RMSE 0.090 against the curated schools), `estimated-profile` fits from
  admission rate and first-year retention (RMSE 0.152; 0.067 out of sample against the
  curated schools' reported figures). The curated 42 keep their real numbers as
  `curated`.
- **`avgSAT` is nullable, and null means test-blind.** 143 schools report no SAT average
  because they do not consider one — the whole UC and CSU systems, and Caltech. That is
  a fact about the school, not a gap in the data, so it is not filled in: `evaluate()`
  skips test fit for them rather than scoring a student against a hurdle that does not
  exist.
- **Retention is in the `estimated-profile` fit for a structural reason, not accuracy.**
  `classifyTier` reads `acceptanceRate` *and* `gpaGap`. With GPA fitted from admission
  rate alone the second derived from the first, so the classifier had one school-side
  signal wearing two hats: every test-blind school in the 60–80% admit band shared a
  0.14-wide GPA range and therefore one tier, where SAT-reporting schools in that band
  spread 1.09 wide across all three. It also floored at 3.18, making `gpaGap <= -0.1`
  unreachable below a 3.28 GPA — a 3.2 student got safeties from 13% of SAT-reporting
  schools and **0%** of test-blind ones, which is every CSU. Adding retention (the
  stronger of the two predictors, R² 0.668 against 0.386) restored the spread to 0.84
  wide and that student to 19%. A least-squares fit is right here where it is wrong for
  `GPA_ANCHORS`: the test-blind schools fall *inside* the 572-school training domain.
- **Majors are coarse.** They are derived from 2-digit CIP degree shares and mapped onto
  the existing 22-major vocabulary, capped at the 8 largest per school. CIP cannot
  separate Physics from Chemistry, so a school with either is credited with both.

`data/compass.db` is the pre-D1 SQLite file. Nothing reads it any more; it is
kept only so the profiles in it aren't destroyed by the migration.
