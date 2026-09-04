// Compass API — Hono on the Cloudflare Workers runtime.
//
// Endpoints (unchanged from the Express build):
//   POST /api/auth/signup                    Create an account (claims a guest)
//   POST /api/auth/login                     Start a session
//   POST /api/auth/logout                    Revoke the session
//   GET  /api/auth/me                        Current user + their student id
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
import { matchedRoute, requestLog } from "./middleware/requestLog.js";
import { createLogger, errorFields } from "./log.js";
import {
  ensureSession,
  ownedStudent,
  ownsStudent,
  requireOwner,
  sessionContext,
} from "./middleware/auth.js";
import authRoutes from "./routes/auth.js";
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

// ---- Observability ----
//
// FIRST, AND THAT IS LOAD-BEARING. This middleware reports on whatever
// happens beneath it, so anything registered above it is a request it cannot
// see and time — including the 413s bodyLimit returns and the preflights CORS
// rejects. Same ordering hazard as the requireOwner block below, in the
// opposite direction: there, a route above the guard is unprotected; here, a
// middleware above the logger is unobserved.
app.use("*", requestLog);

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
    // On since Phase 2: the session cookie is not sent on a cross-origin
    // request without it. Safe only because `origin` above is an allowlist —
    // credentials:true combined with a reflected-any origin would let every
    // site on the internet make authenticated calls as a visitor.
    credentials: true,
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

// Resolves the session cookie onto the context for every route. It does not
// create a session — see middleware/auth.ts for why that is lazy.
app.use("*", sessionContext);

// ---- Accounts ----
app.route("/auth", authRoutes);

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
  // Ownership has to be checked by hand here: the student id arrives as a
  // query parameter, so this route sits outside the /students/:id prefix
  // requireOwner guards — but the insights it returns are derived from the
  // profile (the student's percentile against each school's averages), so
  // reading it for an id you do not own leaks exactly what that gate exists
  // to protect. Without the profile the route still works, unpersonalized.
  const studentId = c.req.query("studentId");
  if (studentId && !(await ownsStudent(c, studentId))) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const student = studentId ? await ownedStudent(c) : null;

  const major = c.req.param("major");
  const insights = majorInsights(major, student);
  if (insights.schoolCount === 0) {
    return c.json({ error: `No universities in this set offer ${major}.` }, 404);
  }
  return c.json(insights);
});

// ---- Students ----
//
// ORDER IS LOAD-BEARING, AND THIS IS THE PLACE IT MATTERS MOST. Hono applies
// middleware only to routes registered *after* it, so every /students/:id
// route in this file must be declared below these two lines. A route added
// above them would serve any student's profile to any caller, silently and
// with passing tests — the exact regression the implementation guide calls the
// most common one in apps like this.
app.use("/students/:id", requireOwner);
app.use("/students/:id/*", requireOwner);

/**
 * Create the caller's profile.
 *
 * Not behind requireOwner: there is nothing to own yet. ensureSession() mints
 * an anonymous account for a first-time visitor, so the row is owned from the
 * moment it exists and the "no account needed" flow costs no security.
 */
app.post("/students", async (c) => {
  const { valid, errors, profile } = validateProfile(await readJson(c));
  if (!valid) return c.json({ errors }, 400);

  const store = c.get("store");
  const session = await ensureSession(c);

  // One profile per account, matching the UNIQUE index on students.user_id.
  // Before Phase 2 the frontend re-POSTed on every profile edit and orphaned
  // the previous row each time; the id comes back here so the client can PUT
  // to the right place instead.
  const existing = await store.getStudentByUserId(session.userId);
  if (existing) {
    return c.json(
      { error: "You already have a profile — update it instead.", studentId: existing.id },
      409
    );
  }

  const record = await store.createStudent(profile, session.userId);
  return c.json(record, 201);
});

// requireOwner has already loaded and authorized the profile, so these read it
// off the context rather than re-querying. There is no 404 branch left: a
// profile the session owns necessarily exists.
app.get("/students/:id", (c) => c.json(c.get("student")));

app.put("/students/:id", async (c) => {
  const { valid, errors, profile } = validateProfile(await readJson(c));
  if (!valid) return c.json({ errors }, 400);
  const record = await c.get("store").updateStudent(c.req.param("id"), profile);
  return c.json(record!);
});

app.get("/students/:id/recommendations", (c) => {
  const student = c.get("student");
  const recommendations = recommendUniversities(student);
  const counts = {
    reach: recommendations.reach.length,
    target: recommendations.target.length,
    safety: recommendations.safety.length,
  };
  return c.json({ studentId: student.id, counts, recommendations });
});

// ---- Scholarships ----

app.get("/students/:id/scholarships", (c) => {
  const student = c.get("student");
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

// Phase 1's requireStudent middleware lived here. requireOwner replaced it:
// an existence check is implied by an ownership check, so keeping both would
// have meant two gates to remember on every new route instead of one.
//
// One contract change came with that, deliberately. An unknown student id used
// to answer 404 and an unowned one would have answered 403 — which tells any
// caller which ids exist. Both are 403 now: whether a profile you cannot see
// exists is not information this API gives out.

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
    // The follow-up PHASE-1.md left open, and the reason this limiter is in
    // code rather than a WAF rule at all. A signed-in account is budgeted as
    // itself; everyone else still falls back to IP.
    //
    // This matters for who actually uses Compass: a high school sits behind
    // one NAT, so IP-keying gives an entire class 30 questions between them.
    // Guests keep sharing that budget — a guest can mint a fresh session by
    // clearing a cookie, so per-session keying would be no limit at all — and
    // "sign in for your own quota" is the honest incentive that creates.
    key: async (c) => {
      const session = c.get("session");
      if (!session) return null;
      const user = await c.get("store").getUser(session.userId);
      return user && !user.guest ? `user:${user.id}` : null;
    },
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

  // Same off-path ownership case as /majors/:major above, with more at stake:
  // the chatbot is handed the profile as context and answers out of it, and
  // the conversation history is returned to whoever asks. An unowned id is
  // refused rather than quietly ignored — silently dropping the context would
  // turn a client bug into answers that look personalized and are not.
  const wantsProfile = typeof studentId === "string" && studentId !== "";
  if (wantsProfile && !(await ownsStudent(c, studentId))) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const student = wantsProfile ? await ownedStudent(c) : null;
  const history = wantsProfile ? await store.getConversation(studentId) : [];

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
    createLogger(c.env).error("chat request failed", {
      route: "/api/chat",
      ...errorFields(err),
    });
    return c.json({ error: "Something went wrong answering that. Please try again." }, 500);
  }
});

app.get("/students/:id/chat", async (c) => {
  return c.json({ messages: await c.get("store").getConversation(c.req.param("id")) });
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
//
// These lines carry method and route even though the request logger already
// reports both, so an error is legible on its own rather than only after being
// joined to another line by its ray id — which is not a join you can make
// locally, where there is no ray id at all. The route is the *pattern*, for the
// same reason it is in the request log: c.req.path here would put a student's
// id into the log on every 500.
app.onError((err, c) => {
  const log = createLogger(c.env);

  if (err instanceof HTTPException) {
    // Not a server fault — readJson raises these for a malformed or oversized
    // body. Warn rather than error: something is wrong with the request, and
    // nothing is wrong with the Worker.
    log.warn("client error", {
      method: c.req.method,
      route: matchedRoute(c),
      status: err.status,
      // Undefined rather than "" for an exception raised without a message, so
      // JSON.stringify drops the field instead of logging an empty one.
      detail: err.message || undefined,
    });
    return err.getResponse();
  }

  log.error("unhandled error", {
    method: c.req.method,
    route: matchedRoute(c),
    status: 500,
    ...errorFields(err),
  });
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
