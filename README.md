# Compass — AI College Admissions Advisor

An AI-powered assistant that helps high school students build a personalized college
application plan. It recommends universities from a student's GPA, coursework,
extracurriculars, and career interests, and includes a chatbot that answers admissions
and financial-aid questions. The architecture is built to extend toward scholarship and
internship recommendation engines.

Built to the [step-by-step guide](ClaudeAIAdmissionsSteps.md) and the
[web-design standards](ClaudeWebDesign.md) in this repo.

## What's inside

| Piece | Stack | Folder |
|-------|-------|--------|
| **Frontend** | React + TypeScript (Vite) | [`frontend/`](frontend) |
| **Backend API** | Node.js + Express | [`backend/`](backend) |
| **Chatbot** | Claude or OpenAI, with an offline fallback | [`backend/services/llmService.js`](backend/services/llmService.js) |
| **Data** | 42-university + 45-scholarship JSON datasets | [`backend/data/`](backend/data) |
| **Persistence** | SQLite via built-in `node:sqlite` — profiles, chat, applications, and notes survive a restart | [`backend/store/`](backend/store) |

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

Requires **Node 22.5 or newer** — `node:sqlite` is a built-in that only stabilised in
22.5. There's an `.nvmrc`, so `nvm use` picks the right one.

```bash
npm run install:all      # installs backend + frontend
cp backend/.env.example backend/.env
npm run dev              # both servers, one terminal
```

Open **http://localhost:5173**. The frontend proxies `/api` to the backend on port 4000.

<details>
<summary>Prefer two terminals?</summary>

```bash
npm run dev:backend      # port 4000
npm run dev:frontend     # port 5173
```
</details>

Set **one** key in `backend/.env` to enable the live chatbot — `ANTHROPIC_API_KEY`
([console.anthropic.com](https://console.anthropic.com)) or `OPENAI_API_KEY`
([platform.openai.com/api-keys](https://platform.openai.com/api-keys)). Claude wins if
both are present. A key that's set but malformed is reported at startup and then ignored,
so a bad paste shows up in your terminal rather than as a failed chat message later.

> **No API key?** The chatbot runs in offline mode with a built-in knowledge base, so the
> whole app is fully usable for demos.

### Configuration

Everything is optional; [`backend/.env.example`](backend/.env.example) documents each one.

| Variable | Default | What it does |
|----------|---------|--------------|
| `PORT` | `4000` | API port. Note it applies to the *backend*: if `PORT` is already exported in your shell, `npm run dev` will start the API there instead of 4000, and the frontend proxy (which targets 4000) will fail to connect. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | unset | Enables the live chatbot. |
| `COMPASS_DB` | `backend/data/compass.db` | SQLite path. `:memory:` is honoured. |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated origins allowed to call the API from a browser. |
| `TRUST_PROXY` | `0` | Reverse-proxy hops in front of the app, so rate limiting sees the real client IP. Render and Fly.io are `1`. |

`TRUST_PROXY` is worth setting deliberately when you host this. Too low and every visitor
shares one rate-limit bucket; too high and a client can forge `X-Forwarded-For` to look
like a new IP and step around the limiter.

## Tests

```bash
npm test      # engines, data integrity, API endpoints, and hardening (Jest)
```

Jest runs against a private in-memory database, so the suites never touch
`backend/data/compass.db`.

[`tests/security.test.js`](backend/tests/security.test.js) covers the middleware rather
than any feature — security headers, the CORS allowlist, the request-size cap, that errors
carry no stack traces, and API-key validation. None of that changes app behaviour when it
regresses, which is precisely why it needs its own test.

## Design

A warm, editorial "guidance-counselor" direction: cream paper, deep pine ink, a
clay/terracotta accent with forest-green and ochre supports; Fraunces (display) + Inter
Tight (body). Fully responsive, keyboard-accessible, and `prefers-reduced-motion`-aware.

## Data & persistence

Profiles, chat history, and tracked applications live in a SQLite file at
`backend/data/compass.db`, created on first run and gitignored — it holds real student
data and never belongs in the repo. It uses Node's built-in `node:sqlite`, so there is no
database to install and no new dependency; [`store/dataStore.js`](backend/store/dataStore.js)
kept its original synchronous signatures, so nothing above it changed. Point `COMPASS_DB`
at another path (or `:memory:`) to override.

Universities and scholarships stay as JSON in [`backend/data/`](backend/data) — they're
reference data, not user data, and belong in version control where a diff is reviewable.
Scholarship entries record the *month* a program typically closes plus the sponsor's URL;
they deliberately never assert a date, for the same reason
[`models/application.js`](backend/models/application.js) doesn't.

## Extending it (roadmap)

The store and services are written to be swapped without touching the UI:

- **Accounts** — the schema is keyed by student id already; adding a users table and a
  session cookie is the remaining step.
- **Postgres** — swap the driver in [`backend/store/db.js`](backend/store/db.js). The one
  real cost is that `pg` is async, so every store function and its callers become
  promise-based.
- **More scholarships** — [`backend/data/scholarships.json`](backend/data/scholarships.json)
  is a plain curated file. No free public scholarship API exists (Fastweb and College Board
  don't publish one), so growing this list means curating it or licensing a feed.
