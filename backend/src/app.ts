// Compass API — Hono on the Cloudflare Workers runtime.
//
// Endpoints (unchanged from the Express build):
//   GET  /api/health                         Service + LLM + D1 status
//   GET  /api/universities                   List all universities (with filters)
//   GET  /api/meta                           Majors / regions for form dropdowns
//   POST /api/students                       Create a student profile
//   GET  /api/students/:id                   Get a student profile
//   PUT  /api/students/:id                   Update a student profile
//   GET  /api/students/:id/recommendations   Tiered university matches
//   GET  /api/students/:id/scholarships      Tiered scholarship matches
//   GET  /api/students/:id/notes             Starred schools + notes
//   PUT  /api/students/:id/notes/:uniId      Star and/or annotate one school
//   DELETE /api/students/:id/notes/:uniId    Forget a school entirely
//   POST /api/chat                           Ask the admissions chatbot
//   GET  /api/students/:id/chat              Fetch conversation history
//   GET  /api/majors                         Every major with a school count
//   GET  /api/majors/:major                  Deep dive on one major (?studentId=)
//   GET  /api/application-meta               Decision plans, statuses, checklist
//   GET  /api/students/:id/applications      Tracked applications + timeline
//   POST /api/students/:id/applications      Track a university
//   PATCH  /api/students/:id/applications/:appId  Update one application
//   DELETE /api/students/:id/applications/:appId  Stop tracking
//
// The app is exported as a factory-free Hono instance so both entry points can
// use it: src/index.ts (a standalone Worker, what `wrangler dev` runs today)
// and, in Phase 7, functions/api/[[route]].ts via hono/cloudflare-pages. That
// is the whole reason routing lives here instead of in the entry file.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import { createMiddleware } from "hono/factory";

import { validateProfile } from "./models/studentProfile.js";
import {
  CHECKLIST,
  DECISION_PLANS,
  STATUSES,
  currentCycleYear,
  isDateString,
  normalizeChecklist,
  validateApplication,
} from "./models/application.js";
import { createStore } from "./store/dataStore.js";
import { loadUniversities, universityIndex } from "./store/staticData.js";
import { recommendUniversities } from "./services/recommendationEngine.js";
import { recommendScholarships } from "./services/scholarshipEngine.js";
import { majorCatalog, majorInsights } from "./services/majorInsights.js";
import { createLlmService } from "./services/llmService.js";
import { bodyLimit } from "./middleware/bodyLimit.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { readJson } from "./http.js";
import type {
  ApplicationInput,
  ApplicationRecord,
  AppEnv,
  Checklist,
  SchoolNoteRecord,
  StudentRecord,
  University,
} from "./types.js";

const app = new Hono<AppEnv>().basePath("/api");

// ---- Security middleware ----
//
// The decisions here are the ones from the Express build; only the packages
// changed, since helmet, the cors package, and express-rate-limit are all
// Node-specific and cannot load in a Worker.

// Hono sends no hardening headers on its own, same as Express. This is the
// hono/secure-headers equivalent of helmet()'s set. (There is no X-Powered-By
// to strip — Hono never sends one.)
app.use(
  "*",
  secureHeaders({
    // The default is "same-origin", which tells the browser to drop this
    // response whenever the page reading it lives on another origin. Right for
    // a server that also serves the HTML, wrong the moment the frontend is
    // deployed separately (Phase 7 Option B). The CORS allowlist below is what
    // actually decides who may read this API; CORP would only duplicate it and
    // silently break a split deployment.
    crossOriginResourcePolicy: "cross-origin",
    // No CSP: hono/secure-headers sets none by default, and this origin serves
    // JSON only — there is no document for a policy to constrain. (helmet did
    // send one; dropping it here is deliberate, not an oversight.)
    xFrameOptions: "DENY",
  })
);

// Bare `cors()` reflects any Origin, so once this is public every site on the
// internet can call the API from a visitor's browser. Allowlist instead.
// Requests with no Origin at all (curl, health checks, server-to-server) are
// unaffected — the header is a browser mechanism, not a firewall.
app.use("*", async (c, next) => {
  const allowed = (c.env.CORS_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    // Phase 2 turns this on for session cookies. Stated now so the reason it
    // is currently off is a decision on record rather than an omission.
    credentials: false,
  })(c, next);
});

// 100kb, the same cap express.json() enforced.
app.use("*", bodyLimit());

// ---- Per-request wiring ----
//
// The store and the chatbot both need `env`, which only exists per request.
// Building them once here rather than in each handler keeps every route from
// repeating the same two lines.
app.use("*", async (c, next) => {
  c.set("store", createStore(c.env.DB));
  c.set("llm", createLlmService(c.env));
  await next();
});

// Derive the list of majors/regions actually present in the dataset.
function buildMeta() {
  const unis = loadUniversities();
  const majors = new Set<string>();
  const regions = new Set<string>();
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

app.get("/health", async (c) => {
  // Phase 4.3 wants uptime monitoring to distinguish "the Worker is up" from
  // "the Worker is up but D1 is unreachable" — the two look identical from
  // outside without this probe, and only one of them is an outage worth paging
  // for. Doing it here rather than waiting for Phase 4 costs one trivial query.
  let database = "ok";
  try {
    await c.env.DB.prepare("SELECT 1").first();
  } catch {
    database = "unreachable";
  }
  return c.json(
    {
      status: database === "ok" ? "ok" : "degraded",
      llm: c.get("llm").provider,
      database,
      time: new Date().toISOString(),
    },
    database === "ok" ? 200 : 503
  );
});

app.get("/meta", (c) => c.json(buildMeta()));

// ---- Universities ----

app.get("/universities", (c) => {
  let unis = loadUniversities();
  const { region, major, maxTuition, search } = c.req.query();

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
  return c.json(unis);
});

// ---- Majors ----

app.get("/majors", (c) => c.json({ majors: majorCatalog() }));

app.get("/majors/:major", async (c) => {
  const studentId = c.req.query("studentId");
  const student = studentId ? await c.get("store").getStudent(studentId) : null;
  if (studentId && !student) {
    return c.json({ error: "Student not found" }, 404);
  }

  const major = c.req.param("major");
  const insights = majorInsights(major, student);
  if (insights.schoolCount === 0) {
    return c.json({ error: `No universities in this set offer ${major}.` }, 404);
  }
  return c.json(insights);
});

// ---- Students ----

app.post("/students", async (c) => {
  const { valid, errors, profile } = validateProfile(await readJson(c));
  if (!valid) return c.json({ errors }, 400);
  const record = await c.get("store").createStudent(profile);
  return c.json(record, 201);
});

app.get("/students/:id", async (c) => {
  const record = await c.get("store").getStudent(c.req.param("id"));
  if (!record) return c.json({ error: "Student not found" }, 404);
  return c.json(record);
});

app.put("/students/:id", async (c) => {
  const { valid, errors, profile } = validateProfile(await readJson(c));
  if (!valid) return c.json({ errors }, 400);
  const record = await c.get("store").updateStudent(c.req.param("id"), profile);
  if (!record) return c.json({ error: "Student not found" }, 404);
  return c.json(record);
});

app.get("/students/:id/recommendations", async (c) => {
  const student = await c.get("store").getStudent(c.req.param("id"));
  if (!student) return c.json({ error: "Student not found" }, 404);
  const recommendations = recommendUniversities(student);
  const counts = {
    reach: recommendations.reach.length,
    target: recommendations.target.length,
    safety: recommendations.safety.length,
  };
  return c.json({ studentId: student.id, counts, recommendations });
});

// ---- Scholarships ----

app.get("/students/:id/scholarships", async (c) => {
  const student = await c.get("store").getStudent(c.req.param("id"));
  if (!student) return c.json({ error: "Student not found" }, 404);

  const scholarships = recommendScholarships(student);
  const counts = {
    reach: scholarships.reach.length,
    target: scholarships.target.length,
    safety: scholarships.safety.length,
  };
  return c.json({
    studentId: student.id,
    cycleYear: currentCycleYear(),
    counts,
    scholarships,
  });
});

// ---- Applications ----

app.get("/application-meta", (c) =>
  c.json({
    plans: Object.entries(DECISION_PLANS).map(([key, spec]) => ({
      key,
      label: spec.label,
      binding: spec.binding,
      note: spec.note,
    })),
    statuses: STATUSES,
    checklist: CHECKLIST,
    cycleYear: currentCycleYear(),
  })
);

// Join an application to its university so the client doesn't have to.
// Deliberately no days-until/urgency here: those depend on the *student's*
// local date, and a server in another timezone would mislabel what's due
// today. The client computes that from its own clock.
function decorate(application: ApplicationRecord, universitiesById: Map<number, University>) {
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

// Undated (rolling) applications sort last — they have no fixed date to
// place on a timeline, not an infinitely distant one.
function byDeadline(a: ApplicationRecord, b: ApplicationRecord): number {
  if (!a.deadline && !b.deadline) return 0;
  if (!a.deadline) return 1;
  if (!b.deadline) return -1;
  return a.deadline.localeCompare(b.deadline);
}

/**
 * 404 unless the student exists.
 *
 * On Express this wrote the response and returned null, and every caller had
 * to remember to `return` on a falsy result — a check that fails open if
 * forgotten. As Hono middleware the framework enforces it instead: not calling
 * `next()` ends the request, so a route cannot run without its student.
 */
const requireStudent = createMiddleware<AppEnv>(async (c, next) => {
  const student = await c.get("store").getStudent(c.req.param("id"));
  if (!student) return c.json({ error: "Student not found" }, 404);
  c.set("student", student);
  await next();
});

// ORDER IS LOAD-BEARING. Hono applies middleware only to routes registered
// *after* it, so a new /students/:id/applications or /students/:id/notes route
// added above this block would silently skip the existence check — and, once
// Phase 2 adds requireOwner here, silently skip the ownership check too. That
// is the single most common regression in apps like this. Add routes below.
app.use("/students/:id/applications", requireStudent);
app.use("/students/:id/applications/*", requireStudent);
app.use("/students/:id/notes", requireStudent);
app.use("/students/:id/notes/*", requireStudent);

app.get("/students/:id/applications", async (c) => {
  const index = universityIndex();
  const applications = [...(await c.get("store").getApplications(c.req.param("id")))]
    .sort(byDeadline)
    .map((a) => decorate(a, index));
  return c.json({
    studentId: c.req.param("id"),
    cycleYear: currentCycleYear(),
    applications,
  });
});

app.post("/students/:id/applications", async (c) => {
  const store = c.get("store");
  const index = universityIndex();
  const { valid, errors, application } = validateApplication(
    await readJson(c),
    new Set(index.keys())
  );
  if (!valid) return c.json({ errors }, 400);

  if (await store.hasApplicationFor(c.req.param("id"), application.universityId)) {
    return c.json({ error: "That university is already on your list." }, 409);
  }

  const record = await store.createApplication(c.req.param("id"), application);
  return c.json(decorate(record, index), 201);
});

app.patch("/students/:id/applications/:appId", async (c) => {
  const store = c.get("store");
  const existing = await store.findApplication(c.req.param("id"), c.req.param("appId"));
  if (!existing) return c.json({ error: "Application not found" }, 404);

  // Partial update: only the fields actually present in the body change.
  const patch: Partial<ApplicationInput> = {};
  const errors: string[] = [];
  const body = await readJson<Record<string, unknown>>(c);

  if (body.plan !== undefined) {
    const plan = String(body.plan).toUpperCase();
    if (!DECISION_PLANS[plan]) {
      errors.push(`plan must be one of: ${Object.keys(DECISION_PLANS).join(", ")}`);
    } else {
      patch.plan = plan;
    }
  }

  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status as string)) {
      errors.push(`status must be one of: ${STATUSES.join(", ")}`);
    } else {
      patch.status = body.status as string;
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
    patch.checklist = normalizeChecklist({
      ...existing.checklist,
      ...(body.checklist as Checklist),
    });
  }

  if (body.notes !== undefined) {
    patch.notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 1000) : "";
  }

  if (errors.length) return c.json({ errors }, 400);

  const record = await store.updateApplication(c.req.param("id"), c.req.param("appId"), patch);
  return c.json(decorate(record!, universityIndex()));
});

app.delete("/students/:id/applications/:appId", async (c) => {
  const removed = await c
    .get("store")
    .deleteApplication(c.req.param("id"), c.req.param("appId"));
  if (!removed) return c.json({ error: "Application not found" }, 404);
  return c.body(null, 204);
});

// ---- School notes ----
//
// Notes are joined to their university on the way out, the same as
// applications are, so every page that renders a note has the school's name
// without a second request or a client-side lookup table.

const MAX_NOTE = 1000;

function decorateNote(
  note: Pick<SchoolNoteRecord, "universityId" | "starred" | "note"> & Partial<SchoolNoteRecord>,
  universitiesById: Map<number, University>
) {
  const uni = universitiesById.get(note.universityId) || null;
  return {
    ...note,
    university: uni
      ? {
          id: uni.id,
          name: uni.name,
          shortName: uni.shortName,
          city: uni.city,
          state: uni.state,
          region: uni.region,
          acceptanceRate: uni.acceptanceRate,
          tuition: uni.tuition,
        }
      : null,
  };
}

app.get("/students/:id/notes", async (c) => {
  const index = universityIndex();
  const notes = (await c.get("store").getSchoolNotes(c.req.param("id"))).map((n) =>
    decorateNote(n, index)
  );
  return c.json({ studentId: c.req.param("id"), notes });
});

app.put("/students/:id/notes/:universityId", async (c) => {
  const store = c.get("store");
  const index = universityIndex();
  const universityId = Number(c.req.param("universityId"));
  if (!Number.isInteger(universityId) || !index.has(universityId)) {
    return c.json({ error: "University not found" }, 404);
  }

  const body = await readJson<Record<string, unknown>>(c);
  const existing = await store.getSchoolNote(c.req.param("id"), universityId);

  // A partial write keeps the other half: starring a school from a card must
  // not wipe the paragraph typed about it on another page, and vice versa.
  const starred =
    body.starred === undefined ? Boolean(existing?.starred) : Boolean(body.starred);

  let note = existing?.note ?? "";
  if (body.note !== undefined) {
    if (typeof body.note !== "string") {
      return c.json({ error: "note must be a string" }, 400);
    }
    note = body.note.slice(0, MAX_NOTE);
  }

  const record = await store.saveSchoolNote(c.req.param("id"), universityId, { starred, note });

  // Emptied and unstarred, so the row is gone. The client still gets the same
  // shape back — an empty note for that school — plus `removed` so it can drop
  // the card from a saved list without refetching.
  if (!record) {
    const blank = { universityId, starred: false, note: "" };
    return c.json({ ...decorateNote(blank, index), removed: true });
  }
  return c.json(decorateNote(record, index));
});

app.delete("/students/:id/notes/:universityId", async (c) => {
  const removed = await c
    .get("store")
    .deleteSchoolNote(c.req.param("id"), Number(c.req.param("universityId")));
  if (!removed) return c.json({ error: "No note for that school" }, 404);
  return c.body(null, 204);
});

// ---- Chat ----
//
// The only route with a limiter in code. See middleware/rateLimit.ts for why
// this one and not the others.

app.use(
  "/chat",
  rateLimit({
    bucket: "chat",
    limit: 30,
    windowMs: 15 * 60 * 1000,
    message: "Too many questions in a short time — please wait a few minutes and try again.",
  })
);

app.post("/chat", async (c) => {
  const store = c.get("store");
  const { studentId, question } = await readJson<{ studentId?: string; question?: unknown }>(c);

  if (typeof question !== "string" || question.trim() === "") {
    return c.json({ error: "A non-empty question is required." }, 400);
  }
  if (question.length > 1000) {
    return c.json({ error: "Please keep questions under 1000 characters." }, 400);
  }

  const student = studentId ? await store.getStudent(studentId) : null;
  const history = studentId ? await store.getConversation(studentId) : [];

  try {
    const { answer, source } = await c
      .get("llm")
      .answerAdmissionsQuestion(question.trim(), student, history);
    // Only persist history against a profile that exists — chat history is a
    // child of the student row, so there is nothing to hang an unknown id off.
    if (student) {
      await store.appendMessage(student.id, "user", question.trim());
      await store.appendMessage(student.id, "assistant", answer);
    }
    return c.json({ answer, source });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        route: "/api/chat",
        detail: err instanceof Error ? err.message : String(err),
      })
    );
    return c.json({ error: "Something went wrong answering that. Please try again." }, 500);
  }
});

app.get("/students/:id/chat", async (c) => {
  const store = c.get("store");
  const student = await store.getStudent(c.req.param("id"));
  if (!student) return c.json({ error: "Student not found" }, 404);
  return c.json({ messages: await store.getConversation(c.req.param("id")) });
});

// ---- Fallbacks ----

app.notFound((c) => c.json({ error: "Not found" }, 404));

// The client is told what went wrong, never how the server is built: no stack,
// no file paths, no driver messages. The full error goes to the log, which is
// the only place with the context to act on it.
//
// Client mistakes keep their own status — readJson() raises 413 for an
// oversized body and 400 for malformed JSON, and answering either with a
// blanket 500 would tell an honest caller to retry a request that can never
// succeed.
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    console.warn(
      JSON.stringify({
        level: "warn",
        method: c.req.method,
        path: c.req.path,
        status: err.status,
        detail: err.message,
      })
    );
    return err.getResponse();
  }

  console.error(
    JSON.stringify({
      level: "error",
      method: c.req.method,
      path: c.req.path,
      status: 500,
      detail: err instanceof Error ? (err.stack ?? err.message) : String(err),
    })
  );
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
