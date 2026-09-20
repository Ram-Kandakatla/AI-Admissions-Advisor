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
//   POST /api/chat                           Ask the chatbot (?mode=advising|essay)
//   GET  /api/students/:id/chat              Fetch one thread (?mode=advising|essay)
//   GET  /api/students/:id/share             The student's share link, if any
//   POST /api/students/:id/share             Create it, or {rotate:true} to replace
//   DELETE /api/students/:id/share           Revoke it
//   GET  /api/shared/:token                  Read-only plan — NO SESSION, token is the credential
//   GET  /api/majors                         Every major with a school count
//   GET  /api/majors/:major                  Deep dive on one major (?studentId=)
//   GET  /api/application-meta               Decision plans, statuses, checklist
//   GET  /api/students/:id/applications      Tracked applications + timeline
//   POST /api/students/:id/applications      Track a university
//   PATCH  /api/students/:id/applications/:appId  Update one application
//   DELETE /api/students/:id/applications/:appId  Stop tracking
//
// The app is exported as a factory-free Hono instance so the entry point can
// mount it under either wrangler config: backend/wrangler.toml runs the API
// alone on :8787, the root one deploys it alongside the built frontend. Phase 7
// briefly added a second entry (functions/api/[[route]].ts via
// hono/cloudflare-pages) for Pages; the 2026-09-18 move to Workers deleted it
// and there is one entry again. Routing lives here rather than in the entry
// file precisely so that churn never reached this file.

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
  const allowed = allowedOrigins(c.env);
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    // On since Phase 2: the session cookie is not sent on a cross-origin
    // request without it. Safe only because `origin` above is an allowlist —
    // credentials:true combined with a reflected-any origin would let every
    // site on the internet make authenticated calls as a visitor.
    credentials: true,
  })(c, next);
});

// CORS above decides who may *read* a response; this decides who may *send* a
// write with the visitor's cookie attached. They are different questions, and
// on a pages.dev host SameSite alone does not answer the second one — see
// middleware/crossOrigin.ts. After CORS so a preflight is still answered.
app.use("*", crossOriginGuard);

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

// Derive the list of majors/regions actually present in the dataset. The
// majors come from the same set validateProfile checks against, so the form
// can never offer a major the API would then refuse.
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

// Creating a profile with no session mints a user, a session and a student in
// one request, with no account and no email. That makes it the one write in
// the API a script can repeat from a cold start, so it is the one that could
// fill the database for everybody — and until PHASE-7's WAF rule exists there
// is no global limit in front of it.
//
// Only cookieless requests are counted: a caller who already has a session is
// not minting anything, and the route answers them 409 or 201 on their own
// row. The budget is generous because the realistic false positive is a
// classroom behind one school NAT, all opening Compass for the first time in
// the same lesson.
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

/**
 * How many schools per tier the matches page actually returns.
 *
 * Before the Scorecard import the dataset was 42 schools and every match fit on
 * one page. At 614 a mid-range student matches ~550 of them, which is not a
 * college list — it is the whole database re-sorted. Measured at that size the
 * page rendered 16,500 DOM nodes over 93 screens, and "Save as PDF" (which is
 * window.print(), by design) produced a 64-page document.
 *
 * Browsing everything is what /explore is for. Matches is a shortlist, so the
 * engine's ranking is allowed to mean something: each tier is already sorted by
 * matchScore, so this keeps the strongest and drops the tail. `counts` below
 * stays the TRUE total — the student is told what was filtered, never shown a
 * truncated list presented as the whole result.
 */
const MATCHES_PER_TIER = 20;

app.get("/students/:id/recommendations", (c) => {
  const student = c.get("student");
  const all = recommendUniversities(student);
  const counts = {
    reach: all.reach.length,
    target: all.target.length,
    safety: all.safety.length,
  };
  const recommendations = {
    reach: all.reach.slice(0, MATCHES_PER_TIER),
    target: all.target.slice(0, MATCHES_PER_TIER),
    safety: all.safety.slice(0, MATCHES_PER_TIER),
  };
  return c.json({ studentId: student.id, counts, recommendations, shownPerTier: MATCHES_PER_TIER });
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
// A name and a job title, not prose. Generous enough for "Assistant Director of
// Admissions, Mid-Atlantic Region" and short enough that neither field becomes
// a second notepad.
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

  // A partial write keeps every other part: starring a school from a card must
  // not wipe the paragraph typed about it on another page, nor the name of the
  // officer recorded on a third. Each field is only touched when the request
  // actually mentions it.
  const starred =
    body.starred === undefined ? Boolean(existing?.starred) : Boolean(body.starred);

  let note = existing?.note ?? "";
  if (body.note !== undefined) {
    if (typeof body.note !== "string") {
      return c.json({ error: "note must be a string" }, 400);
    }
    note = body.note.slice(0, MAX_NOTE);
  }

  // A person's name and job title, not free-form text, so the caps are much
  // tighter than the note's — and trimmed, so " " is stored as the empty
  // string rather than as a contact that looks present to every check and
  // blank on screen.
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

  // Validated rather than capped, unlike the two above: a truncated name is
  // still a name, but a truncated date is a different day. isDateString is the
  // same check application deadlines go through.
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

  // Emptied, unstarred, and with no contact, so the row is gone. The client
  // still gets the same shape back — a blank note for that school — plus
  // `removed` so it can drop the card from a saved list without refetching.
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
// A read-only view of one student's plan, for a parent or a counselor.
//
// The three routes below are behind requireOwner (they sit under
// /students/:id), so only the student manages their own link. The fourth —
// GET /shared/:token — is the single unauthenticated read path into student
// data in this API, and everything about it is written defensively.

app.get("/students/:id/share", async (c) => {
  const link = await c.get("store").getShareLink(c.req.param("id"));
  return c.json({ link: link && { token: link.token, createdAt: link.createdAt } });
});

/**
 * Create the link, or rotate it.
 *
 * Idempotent by default: asking twice gives the same token, so a student who
 * reloads the page does not quietly strand the URL they already sent their
 * counselor. `{ rotate: true }` is the deliberate opposite — it mints a new
 * token and the old one stops working immediately, which is what "this went to
 * the wrong person" needs.
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
  // 204 whether or not there was a link. "Revoked" and "there was nothing to
  // revoke" are the same end state, and reporting 404 for the second would
  // make a double-click look like a failure.
  return c.body(null, 204);
});

/**
 * The shared view. NO SESSION, BY DESIGN — the token is the credential.
 *
 * Registered outside the /students/:id prefix on purpose, so requireOwner does
 * not apply and nobody later assumes it does. Four rules hold this route
 * together, and all four are load-bearing:
 *
 *  1. **It builds its own payload, field by field.** It never spreads a record
 *     from the store. `...student` would ship every column the profile ever
 *     grows, so the next migration would silently widen what a shared link
 *     exposes. Listing the fields means adding one is a decision somebody makes
 *     in this file.
 *  2. **No chat, ever, and no toggle to add it.** A student asking whether
 *     their family can afford a school, or working through an essay about
 *     something hard, did not write it for an audience. There is no product
 *     reason strong enough to make that conditional.
 *  3. **No email, no user id, no session.** The holder learns about the plan,
 *     never about the account behind it.
 *  4. **404 for an unknown token and for a revoked one alike.** Distinguishing
 *     them would confirm that a link was once real, which is exactly the thing
 *     a forwarded-and-then-revoked URL should stop telling people.
 */
app.get("/shared/:token", async (c) => {
  const store = c.get("store");
  const link = await store.findShareLink(c.req.param("token"));
  const student = link && (await store.getStudent(link.studentId));

  if (!link || !student) {
    return c.json({ error: "This link is no longer active." }, 404);
  }

  // Never cached anywhere but the reader's own tab. A shared URL is the kind
  // of thing that ends up passing through a proxy, and a plan cached there
  // outlives the revocation that was supposed to end it.
  c.header("Cache-Control", "no-store, private");

  const index = universityIndex();
  const [applications, notes] = await Promise.all([
    store.getApplications(student.id),
    store.getSchoolNotes(student.id),
  ]);

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
      // financialNeed is deliberately absent. "How much help does this family
      // need paying for college" is the most sensitive field in the profile,
      // it is not needed to read the plan, and a link forwarded one hop past
      // the intended reader should not carry it.
    },
    recommendations: recommendUniversities(student),
    scholarships: recommendScholarships(student),
    // Enumerated for the same reason the profile is, and this one was caught
    // by a test rather than by care: reusing decorate() here shipped the
    // application's `studentId` on every row, because ApplicationRecord
    // carries it and decorate() spreads. Knowing the id opens nothing without
    // a session — but a read-only view has no business handing out the key
    // every owner-gated route is addressed by.
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
    // SchoolNoteRecord carries no student id, so this one is safe as it
    // stands — the test above is what keeps that true.
    notes: notes.map((n) => decorateNote(n, index)),
  });
});

// ---- Chat ----
//
// Limited in code because it is the route that spends real money per call.
// See middleware/rateLimit.ts for the full list of limited routes and why.

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

  // Absent means advising, so every client written before Phase 6.3 keeps
  // working untouched. An unrecognised mode is refused rather than coerced —
  // quietly filing an essay turn in the advising thread is a bug that only
  // shows up later, as history that mysteriously belongs to the wrong
  // conversation.
  const mode = parseChatMode(rawMode);
  if (!mode) {
    return c.json({ error: `mode must be one of: ${CHAT_MODES.join(", ")}` }, 400);
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
  const history = wantsProfile ? await store.getConversation(studentId, mode) : [];

  try {
    const { answer, source } = await c
      .get("llm")
      .answerAdmissionsQuestion(question.trim(), student, history, mode);
    // Only persist history against a profile that exists — chat history is a
    // child of the student row, so there is nothing to hang an unknown id off.
    if (student) {
      await store.appendMessage(student.id, "user", question.trim(), mode);
      await store.appendMessage(student.id, "assistant", answer, mode);
    }
    return c.json({ answer, source, mode });
  } catch (err) {
    createLogger(c.env).error("chat request failed", {
      route: "/api/chat",
      // Which assistant failed is worth knowing and safe to log: it is one of
      // two fixed strings, not anything the student typed.
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
