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
| **Persistence** | SQLite via built-in `node:sqlite` — profiles, chat, and applications survive a restart | [`backend/store/`](backend/store) |

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
- **Ask Compass chatbot** — LLM-powered answers on deadlines, essays, tests, and aid,
  personalized to the student's profile. Falls back to a built-in guide with no API key.

## Run it locally

You need **two terminals** — the backend API and the frontend dev server.

**1 · Backend** (port 4000)
```bash
cd backend
npm install
cp .env.example .env     # optional — add an API key for live chatbot answers
npm start
```

Set **one** key in `backend/.env` to enable the live chatbot — `ANTHROPIC_API_KEY`
([console.anthropic.com](https://console.anthropic.com)) or `OPENAI_API_KEY`
([platform.openai.com/api-keys](https://platform.openai.com/api-keys)). Claude wins if
both are present.

**2 · Frontend** (port 5173, proxies `/api` → backend)
```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**.

> **No API key?** The chatbot runs in offline mode with a built-in knowledge base, so the
> whole app is fully usable for demos.

## Tests

```bash
cd backend && npm test      # engines, data integrity, and API endpoint tests (Jest)
```

Jest runs against a private in-memory database, so the suites never touch
`backend/data/compass.db`.

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
