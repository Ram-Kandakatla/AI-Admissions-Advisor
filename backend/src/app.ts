// Compass API on Hono. The route list lives in backend/README.md; auth routes
// are in routes/auth.ts.

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
import { CHAT_MODES, parseChatMode } from "./models/chatMode.js";
import { createStore } from "./store/dataStore.js";
import { knownMajors, loadUniversities, universityIndex } from "./store/staticData.js";
import { recommendUniversities } from "./services/recommendationEngine.js";
import { recommendScholarships } from "./services/scholarshipEngine.js";
import { majorCatalog, majorInsights } from "./services/majorInsights.js";
import { createLlmService } from "./services/llmService.js";
import { bodyLimit } from "./middleware/bodyLimit.js";
import { allowedOrigins, crossOriginGuard } from "./middleware/crossOrigin.js";
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
  Tiered,
  University,
} from "./types.js";

const app = new Hono<AppEnv>().basePath("/api");

// ---- Observability ----
//
// Must stay first: middleware registered above it is invisible to the log.
app.use("*", requestLog);

// ---- Security middleware ----

app.use(
  "*",
  secureHeaders({
    // CORS decides who may read the API; "same-origin" CORP would also break
    // a frontend deployed on a separate origin.
    crossOriginResourcePolicy: "cross-origin",
    // No CSP here: this origin serves JSON only, with no document to constrain.
    xFrameOptions: "DENY",
  })
);

// An allowlist, never bare `cors()`: that reflects any Origin, and with
// credentials:true would let every site make signed-in calls as a visitor.
app.use("*", async (c, next) => {
  const allowed = allowedOrigins(c.env);
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    credentials: true,
  })(c, next);
});

// CORS limits who may read; this limits who may send a cookie-bearing write.
// After CORS so preflights are still answered.
app.use("*", crossOriginGuard);

app.use("*", bodyLimit());

// ---- Per-request wiring ----
app.use("*", async (c, next) => {
  c.set("store", createStore(c.env.DB));
  c.set("llm", createLlmService(c.env));
  await next();
});

app.use("*", sessionContext);

// ---- Accounts ----
app.route("/auth", authRoutes);

// Majors come from the set validateProfile accepts, so the form can't offer
// one the API would refuse.
function buildMeta() {
  const regions = new Set(loadUniversities().map((u) => u.region));
  return {
    majors: [...knownMajors()].sort(),
    regions: [...regions].sort(),
    financialNeed: ["high", "medium", "low"],
  };
}

// ---- Health & meta ----

app.get("/health", async (c) => {
  // Probes D1 so a monitor can tell "Worker up, database down" from healthy.
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
  // Outside requireOwner's prefix but returns profile-derived data, so
  // ownership is checked here. Without a studentId it is unpersonalized.
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
// Every /students/:id route must be registered below these two lines. Hono
// only applies middleware to routes added after it, so a route above them
// would serve any student's data to any caller.
app.use("/students/:id", requireOwner);
app.use("/students/:id/*", requireOwner);

// A cookieless POST mints a user, session and profile, so it's the one write a
// script could repeat to fill the database. Generous, since a whole classroom
// can share one school IP.
const guestCreationLimit = rateLimit({
  bucket: "guest",
  limit: 50,
  windowMs: 15 * 60 * 1000,
  message: "Too many new profiles from this network. Please wait a few minutes and try again.",
});
app.use("/students", async (c, next) => {
  if (c.req.method !== "POST" || c.get("session")) return next();
  return guestCreationLimit(c, next);
});

/** Not behind requireOwner; ensureSession makes the new row owned from the start. */
app.post("/students", async (c) => {
  const { valid, errors, profile } = validateProfile(await readJson(c));
  if (!valid) return c.json({ errors }, 400);

  const store = c.get("store");
  const session = await ensureSession(c);

  // One profile per account; the 409 carries the id so the client can PUT.
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

app.get("/students/:id", (c) => c.json(c.get("student")));

app.put("/students/:id", async (c) => {
  const { valid, errors, profile } = validateProfile(await readJson(c));
  if (!valid) return c.json({ errors }, 400);
  const record = await c.get("store").updateStudent(c.req.param("id"), profile);
  return c.json(record!);
});

/**
 * A mid-range student matches ~550 schools, which renders (and prints) as
 * dozens of pages. Matches is a shortlist; /explore is for browsing all.
 */
const MATCHES_PER_TIER = 20;

/**
 * Keeps the top `perTier` per tier and the true totals, so the page can say
 * what it left out. Use it for every surface that renders a match list.
 */
function shortlist<T>(tiered: Tiered<T>, perTier: number) {
  const counts = {
    reach: tiered.reach.length,
    target: tiered.target.length,
    safety: tiered.safety.length,
  };
  return {
    counts,
    shown: {
      reach: tiered.reach.slice(0, perTier),
      target: tiered.target.slice(0, perTier),
      safety: tiered.safety.slice(0, perTier),
    },
  };
}

app.get("/students/:id/recommendations", (c) => {
  const student = c.get("student");
  // `full=1` skips the cap for Compare, which looks schools up by id and would
  // otherwise call every school past the cut "Not in your matches".
  const full = ["1", "true"].includes(String(c.req.query("full") ?? ""));
  const perTier = full ? Infinity : MATCHES_PER_TIER;
  const { counts, shown } = shortlist(recommendUniversities(student), perTier);
  return c.json({
    studentId: student.id,
    counts,
    recommendations: shown,
    shownPerTier: full ? null : MATCHES_PER_TIER,
  });
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

// No days-until/urgency here: that depends on the student's local date, so the
// client computes it.
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

// Undated (rolling) applications sort last.
function byDeadline(a: ApplicationRecord, b: ApplicationRecord): number {
  if (!a.deadline && !b.deadline) return 0;
  if (!a.deadline) return 1;
  if (!b.deadline) return -1;
  return a.deadline.localeCompare(b.deadline);
}

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

const MAX_NOTE = 1000;
const MAX_CONTACT_NAME = 120;
const MAX_CONTACT_ROLE = 120;

function decorateNote(
  note: Pick<
    SchoolNoteRecord,
    "universityId" | "starred" | "note" | "contactName" | "contactRole" | "contactLastAt"
  > &
    Partial<SchoolNoteRecord>,
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

  // Partial update: fields absent from the body keep their stored values.
  const starred =
    body.starred === undefined ? Boolean(existing?.starred) : Boolean(body.starred);

  let note = existing?.note ?? "";
  if (body.note !== undefined) {
    if (typeof body.note !== "string") {
      return c.json({ error: "note must be a string" }, 400);
    }
    note = body.note.slice(0, MAX_NOTE);
  }

  // Trimmed so " " doesn't count as a contact.
  let contactName = existing?.contactName ?? "";
  let contactRole = existing?.contactRole ?? "";
  for (const [key, cap] of [
    ["contactName", MAX_CONTACT_NAME],
    ["contactRole", MAX_CONTACT_ROLE],
  ] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string") {
      return c.json({ error: `${key} must be a string` }, 400);
    }
    const value = (body[key] as string).trim().slice(0, cap);
    if (key === "contactName") contactName = value;
    else contactRole = value;
  }

  // Validated, not truncated: a truncated date is a different day.
  let contactLastAt = existing?.contactLastAt ?? "";
  if (body.contactLastAt !== undefined) {
    if (body.contactLastAt === null || body.contactLastAt === "") {
      contactLastAt = "";
    } else if (!isDateString(body.contactLastAt)) {
      return c.json({ error: "contactLastAt must be a YYYY-MM-DD date" }, 400);
    } else {
      contactLastAt = body.contactLastAt as string;
    }
  }

  const record = await store.saveSchoolNote(c.req.param("id"), universityId, {
    starred,
    note,
    contactName,
    contactRole,
    contactLastAt,
  });

  // The emptied note was deleted; `removed` lets the client drop its card.
  if (!record) {
    const blank = {
      universityId,
      starred: false,
      note: "",
      contactName: "",
      contactRole: "",
      contactLastAt: "",
    };
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

// ---- Sharing ----
//
// A read-only view of a student's plan for a parent or counselor.

app.get("/students/:id/share", async (c) => {
  const link = await c.get("store").getShareLink(c.req.param("id"));
  return c.json({ link: link && { token: link.token, createdAt: link.createdAt } });
});

/**
 * Idempotent, so a reload doesn't break a URL already sent. `{ rotate: true }`
 * replaces the token and kills the old one immediately.
 */
app.post("/students/:id/share", async (c) => {
  const store = c.get("store");
  const studentId = c.req.param("id");
  const { rotate } = await readJson<{ rotate?: unknown }>(c);

  const link = rotate === true
    ? await store.rotateShareLink(studentId)
    : await store.ensureShareLink(studentId);

  return c.json({ link: { token: link.token, createdAt: link.createdAt } }, 201);
});

app.delete("/students/:id/share", async (c) => {
  await c.get("store").revokeShareLink(c.req.param("id"));
  // 204 even if there was no link, so a double-click isn't an error.
  return c.body(null, 204);
});

/**
 * No session: the token is the credential. Rules for this route:
 *  1. Build the payload field by field, never spread a record, so a new
 *     column can't silently become public.
 *  2. Never include chat history.
 *  3. No email, user id or student id.
 *  4. Same 404 for unknown and revoked tokens.
 */
app.get("/shared/:token", async (c) => {
  const store = c.get("store");
  const link = await store.findShareLink(c.req.param("token"));
  const student = link && (await store.getStudent(link.studentId));

  if (!link || !student) {
    return c.json({ error: "This link is no longer active." }, 404);
  }

  // A cached copy would outlive revocation.
  c.header("Cache-Control", "no-store, private");

  const index = universityIndex();
  const [applications, notes] = await Promise.all([
    store.getApplications(student.id),
    store.getSchoolNotes(student.id),
  ]);
  const sharedMatches = shortlist(recommendUniversities(student), MATCHES_PER_TIER);

  return c.json({
    sharedAt: new Date().toISOString(),
    cycleYear: currentCycleYear(),
    // Enumerated, not spread. See rule 1 above.
    student: {
      name: student.name,
      gpa: student.gpa,
      satScore: student.satScore,
      actScore: student.actScore,
      interestedMajors: student.interestedMajors,
      extracurriculars: student.extracurriculars,
      careerGoals: student.careerGoals,
      preferredRegions: student.preferredRegions,
      // financialNeed deliberately omitted: the most sensitive field, and not
      // needed to read the plan.
    },
    recommendations: sharedMatches.shown,
    recommendationCounts: sharedMatches.counts,
    shownPerTier: MATCHES_PER_TIER,
    scholarships: recommendScholarships(student),
    // Not decorate(), which spreads the record and would leak `studentId`.
    applications: [...applications].sort(byDeadline).map((a) => {
      const uni = index.get(a.universityId);
      return {
        universityId: a.universityId,
        plan: a.plan,
        status: a.status,
        deadline: a.deadline,
        deadlineIsTypical: a.deadlineIsTypical,
        checklist: a.checklist,
        notes: a.notes,
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
    }),
    // Safe to spread: SchoolNoteRecord has no student id (a test guards this).
    notes: notes.map((n) => decorateNote(n, index)),
  });
});

// ---- Chat ----
//
// Every call costs money, so it is rate limited in code.

app.use(
  "/chat",
  rateLimit({
    bucket: "chat",
    limit: 30,
    windowMs: 15 * 60 * 1000,
    message: "Too many questions in a short time — please wait a few minutes and try again.",
    // Members get their own budget, since a school shares one IP. Guests stay
    // keyed by IP: they can mint a new session just by clearing a cookie.
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
  const { studentId, question, mode: rawMode } = await readJson<{
    studentId?: string;
    question?: unknown;
    mode?: unknown;
  }>(c);

  if (typeof question !== "string" || question.trim() === "") {
    return c.json({ error: "A non-empty question is required." }, 400);
  }
  if (question.length > 1000) {
    return c.json({ error: "Please keep questions under 1000 characters." }, 400);
  }

  // Absent means advising; an unknown mode is refused, not coerced into a thread.
  const mode = parseChatMode(rawMode);
  if (!mode) {
    return c.json({ error: `mode must be one of: ${CHAT_MODES.join(", ")}` }, 400);
  }

  // The profile and history feed the answer, so ownership is checked here.
  // An unowned id is refused, not ignored.
  const wantsProfile = typeof studentId === "string" && studentId !== "";
  if (wantsProfile && !(await ownsStudent(c, studentId))) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const student = wantsProfile ? await ownedStudent(c) : null;
  const history = wantsProfile ? await store.getConversation(studentId, mode) : [];

  try {
    const { answer, source } = await c
      .get("llm")
      .answerAdmissionsQuestion(question.trim(), student, history, mode);
    if (student) {
      await store.appendMessage(student.id, "user", question.trim(), mode);
      await store.appendMessage(student.id, "assistant", answer, mode);
    }
    return c.json({ answer, source, mode });
  } catch (err) {
    createLogger(c.env).error("chat request failed", {
      route: "/api/chat",
      mode,
      ...errorFields(err),
    });
    return c.json({ error: "Something went wrong answering that. Please try again." }, 500);
  }
});

app.get("/students/:id/chat", async (c) => {
  const mode = parseChatMode(c.req.query("mode"));
  if (!mode) {
    return c.json({ error: `mode must be one of: ${CHAT_MODES.join(", ")}` }, 400);
  }
  return c.json({
    mode,
    messages: await c.get("store").getConversation(c.req.param("id"), mode),
  });
});

// ---- Fallbacks ----

app.notFound((c) => c.json({ error: "Not found" }, 404));

// Clients never see stacks or internals; the log gets the details. Log the
// route pattern, never c.req.path, which contains a student id.
app.onError((err, c) => {
  const log = createLogger(c.env);

  if (err instanceof HTTPException) {
    // A bad request (e.g. from readJson), not a server fault.
    log.warn("client error", {
      method: c.req.method,
      route: matchedRoute(c),
      status: err.status,
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
