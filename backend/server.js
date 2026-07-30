// AI College Admissions Advisor — Express API server.
//
// Endpoints:
//   GET  /api/health                         Service + LLM status
//   GET  /api/universities                   List all universities (with filters)
//   GET  /api/meta                           Majors / regions for form dropdowns
//   POST /api/students                       Create a student profile
//   GET  /api/students/:id                   Get a student profile
//   PUT  /api/students/:id                   Update a student profile
//   GET  /api/students/:id/recommendations   Tiered university matches
//   POST /api/chat                           Ask the admissions chatbot
//   GET  /api/students/:id/chat              Fetch conversation history

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const { validateProfile } = require("./models/studentProfile");
const store = require("./store/dataStore");
const { recommendUniversities } = require("./services/recommendationEngine");
const { answerAdmissionsQuestion, provider } = require("./services/llmService");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Derive the list of majors/regions actually present in the dataset.
function buildMeta() {
  const unis = store.loadUniversities();
  const majors = new Set();
  const regions = new Set();
  for (const u of unis) {
    u.majors.forEach((m) => majors.add(m));
    regions.add(u.region);
  }
  return {
    majors: [...majors].sort(),
    regions: [...regions].sort(),
    financialNeed: ["high", "medium", "low"],
  };
}

// ---- Health & meta ----

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", llm: provider, time: new Date().toISOString() });
});

app.get("/api/meta", (req, res) => {
  res.json(buildMeta());
});

// ---- Universities ----

app.get("/api/universities", (req, res) => {
  let unis = store.loadUniversities();
  const { region, major, maxTuition, search } = req.query;

  if (region) unis = unis.filter((u) => u.region === region);
  if (major) unis = unis.filter((u) => u.majors.includes(major));
  if (maxTuition) unis = unis.filter((u) => u.tuition <= Number(maxTuition));
  if (search) {
    const q = String(search).toLowerCase();
    unis = unis.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.shortName.toLowerCase().includes(q) ||
        u.city.toLowerCase().includes(q)
    );
  }
  res.json(unis);
});

// ---- Students ----

app.post("/api/students", (req, res) => {
  const { valid, errors, profile } = validateProfile(req.body);
  if (!valid) return res.status(400).json({ errors });
  const record = store.createStudent(profile);
  res.status(201).json(record);
});

app.get("/api/students/:id", (req, res) => {
  const record = store.getStudent(req.params.id);
  if (!record) return res.status(404).json({ error: "Student not found" });
  res.json(record);
});

app.put("/api/students/:id", (req, res) => {
  const { valid, errors, profile } = validateProfile(req.body);
  if (!valid) return res.status(400).json({ errors });
  const record = store.updateStudent(req.params.id, profile);
  if (!record) return res.status(404).json({ error: "Student not found" });
  res.json(record);
});

app.get("/api/students/:id/recommendations", (req, res) => {
  const student = store.getStudent(req.params.id);
  if (!student) return res.status(404).json({ error: "Student not found" });
  const recommendations = recommendUniversities(student);
  const counts = {
    reach: recommendations.reach.length,
    target: recommendations.target.length,
    safety: recommendations.safety.length,
  };
  res.json({ studentId: student.id, counts, recommendations });
});

// ---- Chat ----

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many questions in a short time — please wait a few minutes and try again." },
});

app.post("/api/chat", chatLimiter, async (req, res) => {
  const { studentId, question } = req.body || {};
  if (typeof question !== "string" || question.trim() === "") {
    return res.status(400).json({ error: "A non-empty question is required." });
  }
  if (question.length > 1000) {
    return res.status(400).json({ error: "Please keep questions under 1000 characters." });
  }

  const student = studentId ? store.getStudent(studentId) : null;
  const history = studentId ? store.getConversation(studentId) : [];

  try {
    const { answer, source } = await answerAdmissionsQuestion(question.trim(), student, history);
    if (studentId) {
      store.appendMessage(studentId, "user", question.trim());
      store.appendMessage(studentId, "assistant", answer);
    }
    res.json({ answer, source });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Something went wrong answering that. Please try again." });
  }
});

app.get("/api/students/:id/chat", (req, res) => {
  const student = store.getStudent(req.params.id);
  if (!student) return res.status(404).json({ error: "Student not found" });
  res.json({ messages: store.getConversation(req.params.id) });
});

// ---- Fallbacks ----

app.use((req, res) => res.status(404).json({ error: "Not found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AI College Advisor API listening on http://localhost:${PORT}`);
    const modes = {
      claude: "Claude API",
      openai: "OpenAI API",
      fallback: "offline fallback (no ANTHROPIC_API_KEY or OPENAI_API_KEY)",
    };
    console.log(`Chatbot mode: ${modes[provider]}`);
  });
}

module.exports = app;
