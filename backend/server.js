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
//   GET  /api/students/:id/scholarships      Tiered scholarship matches
//   POST /api/chat                           Ask the admissions chatbot
//   GET  /api/students/:id/chat              Fetch conversation history
//   GET  /api/majors                         Every major with a school count
//   GET  /api/majors/:major                  Deep dive on one major (?studentId= to personalize)
//   GET  /api/application-meta               Decision plans, statuses, checklist
//   GET  /api/students/:id/applications      Tracked applications + timeline
//   POST /api/students/:id/applications      Track a university
//   PATCH  /api/students/:id/applications/:appId  Update one application
//   DELETE /api/students/:id/applications/:appId  Stop tracking

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const { validateProfile } = require("./models/studentProfile");
const {
  DECISION_PLANS,
  STATUSES,
  CHECKLIST,
  currentCycleYear,
  validateApplication,
  normalizeChecklist,
  isDateString,
} = require("./models/application");
const store = require("./store/dataStore");
const { recommendUniversities } = require("./services/recommendationEngine");
const { recommendScholarships } = require("./services/scholarshipEngine");
const { majorInsights, majorCatalog } = require("./services/majorInsights");
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

// ---- Majors ----

app.get("/api/majors", (req, res) => {
  res.json({ majors: majorCatalog() });
});

app.get("/api/majors/:major", (req, res) => {
  const { studentId } = req.query;
  const student = studentId ? store.getStudent(String(studentId)) : null;
  if (studentId && !student) {
    return res.status(404).json({ error: "Student not found" });
  }

  const insights = majorInsights(req.params.major, student);
  if (insights.schoolCount === 0) {
    return res.status(404).json({ error: `No universities in this set offer ${req.params.major}.` });
  }
  res.json(insights);
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

// ---- Scholarships ----

app.get("/api/students/:id/scholarships", (req, res) => {
  const student = store.getStudent(req.params.id);
  if (!student) return res.status(404).json({ error: "Student not found" });

  const scholarships = recommendScholarships(student);
  const counts = {
    reach: scholarships.reach.length,
    target: scholarships.target.length,
    safety: scholarships.safety.length,
  };
  res.json({
    studentId: student.id,
    cycleYear: currentCycleYear(),
    counts,
    scholarships,
  });
});

// ---- Applications ----

app.get("/api/application-meta", (req, res) => {
  res.json({
    plans: Object.entries(DECISION_PLANS).map(([key, spec]) => ({
      key,
      label: spec.label,
      binding: spec.binding,
      note: spec.note,
    })),
    statuses: STATUSES,
    checklist: CHECKLIST,
    cycleYear: currentCycleYear(),
  });
});

// Join an application to its university so the client doesn't have to.
// Deliberately no days-until/urgency here: those depend on the *student's*
// local date, and a server in another timezone would mislabel what's due
// today. The client computes that from its own clock.
function decorate(application, universitiesById) {
  const uni = universitiesById.get(application.universityId) || null;
  return {
    ...application,
    university: uni
      ? {
          id: uni.id,
          name: uni.name,
          shortName: uni.shortName,
          city: uni.city,
          state: uni.state,
          acceptanceRate: uni.acceptanceRate,
        }
      : null,
  };
}

function universityIndex() {
  return new Map(store.loadUniversities().map((u) => [u.id, u]));
}

// Undated (rolling) applications sort last — they have no fixed date to
// place on a timeline, not an infinitely distant one.
function byDeadline(a, b) {
  if (!a.deadline && !b.deadline) return 0;
  if (!a.deadline) return 1;
  if (!b.deadline) return -1;
  return a.deadline.localeCompare(b.deadline);
}

function requireStudent(req, res) {
  const student = store.getStudent(req.params.id);
  if (!student) {
    res.status(404).json({ error: "Student not found" });
    return null;
  }
  return student;
}

app.get("/api/students/:id/applications", (req, res) => {
  if (!requireStudent(req, res)) return;
  const index = universityIndex();
  const applications = [...store.getApplications(req.params.id)]
    .sort(byDeadline)
    .map((a) => decorate(a, index));
  res.json({ studentId: req.params.id, cycleYear: currentCycleYear(), applications });
});

app.post("/api/students/:id/applications", (req, res) => {
  if (!requireStudent(req, res)) return;

  const index = universityIndex();
  const { valid, errors, application } = validateApplication(req.body, new Set(index.keys()));
  if (!valid) return res.status(400).json({ errors });

  if (store.hasApplicationFor(req.params.id, application.universityId)) {
    return res.status(409).json({ error: "That university is already on your list." });
  }

  const record = store.createApplication(req.params.id, application);
  res.status(201).json(decorate(record, index));
});

app.patch("/api/students/:id/applications/:appId", (req, res) => {
  if (!requireStudent(req, res)) return;

  const existing = store.findApplication(req.params.id, req.params.appId);
  if (!existing) return res.status(404).json({ error: "Application not found" });

  // Partial update: only the fields actually present in the body change.
  const patch = {};
  const errors = [];
  const body = req.body || {};

  if (body.plan !== undefined) {
    const plan = String(body.plan).toUpperCase();
    if (!DECISION_PLANS[plan]) {
      errors.push(`plan must be one of: ${Object.keys(DECISION_PLANS).join(", ")}`);
    } else {
      patch.plan = plan;
    }
  }

  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) {
      errors.push(`status must be one of: ${STATUSES.join(", ")}`);
    } else {
      patch.status = body.status;
    }
  }

  if (body.deadline !== undefined) {
    if (body.deadline === null || body.deadline === "") {
      patch.deadline = null;
      patch.deadlineIsTypical = false;
    } else if (!isDateString(body.deadline)) {
      errors.push("deadline must be a YYYY-MM-DD date");
    } else {
      patch.deadline = body.deadline;
      // A date the student typed is confirmed by definition.
      patch.deadlineIsTypical = false;
    }
  }

  if (body.checklist !== undefined) {
    patch.checklist = normalizeChecklist({ ...existing.checklist, ...body.checklist });
  }

  if (body.notes !== undefined) {
    patch.notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 1000) : "";
  }

  if (errors.length) return res.status(400).json({ errors });

  const record = store.updateApplication(req.params.id, req.params.appId, patch);
  res.json(decorate(record, universityIndex()));
});

app.delete("/api/students/:id/applications/:appId", (req, res) => {
  if (!requireStudent(req, res)) return;
  const removed = store.deleteApplication(req.params.id, req.params.appId);
  if (!removed) return res.status(404).json({ error: "Application not found" });
  res.status(204).end();
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
    // Only persist history against a profile that exists — chat history is a
    // child of the student row, so there is nothing to hang an unknown id off.
    if (student) {
      store.appendMessage(student.id, "user", question.trim());
      store.appendMessage(student.id, "assistant", answer);
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
