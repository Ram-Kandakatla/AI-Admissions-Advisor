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
| **Data** | 42-university JSON dataset; profiles & chat in memory | [`backend/data/`](backend/data) |

### Features

- **Student profile** — GPA, SAT/ACT, intended majors, extracurriculars/coursework,
  career goals, financial need, and preferred regions.
- **Recommendation engine** — sorts real universities into **reach / target / safety**,
  each with a match score and plain-English reasons (GPA/test proximity, major fit,
  region, and financial fit).
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
cd backend && npm test      # recommendation engine + API endpoint tests (Jest)
```

## Design

A warm, editorial "guidance-counselor" direction: cream paper, deep pine ink, a
clay/terracotta accent with forest-green and ochre supports; Fraunces (display) + Inter
Tight (body). Fully responsive, keyboard-accessible, and `prefers-reduced-motion`-aware.

## Extending it (roadmap)

The store and services are written to be swapped without touching the UI:

- **Scholarships / internships** — add `data/scholarships.json` and a
  `services/scholarshipEngine.js` mirroring the recommendation engine, then a
  `GET /api/students/:id/scholarships` endpoint.
- **Real database** — replace [`backend/store/dataStore.js`](backend/store/dataStore.js)
  (same function signatures) with Postgres/SQLite.
- **Accounts & persistence** — profiles currently live in memory and reset on restart.
