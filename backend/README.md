# Backend — AI College Admissions Advisor API

Express API that powers the advisor: a university dataset, a rule-based
recommendation engine, and a Claude-powered admissions chatbot (with an offline
fallback so it works without an API key).

## Run it

```bash
cd backend
npm install
cp .env.example .env      # optional: add ANTHROPIC_API_KEY for real chatbot answers
npm start                 # http://localhost:4000
```

`npm run dev` restarts on file changes. `npm test` runs the Jest suite.

## Chatbot modes

The provider is chosen by whichever key is in `.env`:

- **`ANTHROPIC_API_KEY`** → Claude (`claude-opus-4-8`). Wins if both keys are set.
- **`OPENAI_API_KEY`** → OpenAI (`gpt-4o`).
- **Neither** → a built-in keyword knowledge base answers common questions
  (FAFSA, deadlines, essays, tests, scholarships, building a list). Great for demos.

Override models with `ANTHROPIC_MODEL` / `OPENAI_MODEL`. Check which mode is active at
`GET /api/health` — it returns `"claude"`, `"openai"`, or `"fallback"`.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Service + LLM status |
| GET | `/api/meta` | Majors / regions / need levels for form dropdowns |
| GET | `/api/universities` | All universities. Filters: `region`, `major`, `maxTuition`, `search` |
| POST | `/api/students` | Create a student profile |
| GET | `/api/students/:id` | Get a profile |
| PUT | `/api/students/:id` | Update a profile |
| GET | `/api/students/:id/recommendations` | Tiered matches (reach/target/safety) |
| POST | `/api/chat` | Ask the chatbot (`{ studentId?, question }`) — rate limited |
| GET | `/api/students/:id/chat` | Conversation history |

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
[`services/recommendationEngine.js`](services/recommendationEngine.js).

Data lives in [`data/universities.json`](data/universities.json) (42 schools). Profiles
and chat history are in memory and reset on restart — the store in
[`store/dataStore.js`](store/dataStore.js) is written to be swapped for a real database later.
