// Data store for Compass — D1 for everything the student creates.
//
// Three things changed from the node:sqlite version, all forced by the Workers
// runtime rather than chosen:
//
//   1. **It's a factory, not a module.** `db.js` opened one DatabaseSync at
//      import time and every caller shared it. A Worker has no module state
//      that outlives a request; the D1 binding arrives on `c.env` per request,
//      so the store is built per request from it.
//   2. **Every method is async.** D1's prepare().bind().first()/all()/run() all
//      return Promises. Nothing about the queries changed — only the awaits.
//   3. **Writes use RETURNING.** The old code wrote then re-read to get the
//      stored row back, which was two cheap function calls locally but is two
//      network round trips to D1. `RETURNING *` collapses them into one.
//
// Reference data (universities, scholarships) moved to ./staticData.ts — it
// never lived in SQLite and has no reason to touch this file.

import type {
  ApplicationInput,
  ApplicationRecord,
  Checklist,
  ChatMessage,
  SchoolNoteRecord,
  SessionRecord,
  StudentProfile,
  StudentRecord,
  UserRecord,
} from "../types.js";

// --- JSON column helpers -------------------------------------------------
// Arrays and the checklist object are stored as JSON text. A row written by an
// older build (or hand-edited) shouldn't crash a request, so parsing failures
// fall back to the empty value rather than throwing.

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function fromJson<T>(text: unknown, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  try {
    const parsed = JSON.parse(String(text));
    return parsed === null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

// SQLite has no boolean type; store 1/0 and read it back as a real boolean so
// the JSON the API emits keeps the shape the client already expects.
const bool = (v: unknown): number => (v ? 1 : 0);

// ---- Row shapes as D1 hands them back ----

interface StudentRow {
  id: string;
  name: string;
  gpa: number;
  sat_score: number | null;
  act_score: number | null;
  interested_majors: string;
  extracurriculars: string;
  career_goals: string;
  financial_need: string;
  preferred_regions: string;
  created_at: string;
  updated_at: string | null;
}

interface ApplicationRow {
  id: string;
  student_id: string;
  university_id: number;
  plan: string;
  status: string;
  deadline: string | null;
  deadline_is_typical: number;
  checklist: string;
  notes: string;
  created_at: string;
  updated_at: string | null;
}

interface UserRow {
  id: number;
  email: string | null;
  password_hash: string | null;
  created_at: string;
  updated_at: string | null;
}

interface SessionRow {
  id: string;
  user_id: number;
  created_at: string;
  expires_at: string;
}

interface SchoolNoteRow {
  student_id: string;
  university_id: number;
  starred: number;
  note: string;
  created_at: string;
  updated_at: string | null;
}

// ---- Row → API record ----

function studentFromRow(row: StudentRow | null): StudentRecord | null {
  if (!row) return null;
  const record: StudentRecord = {
    id: row.id,
    name: row.name,
    gpa: row.gpa,
    satScore: row.sat_score,
    actScore: row.act_score,
    interestedMajors: fromJson<string[]>(row.interested_majors, []),
    extracurriculars: fromJson<string[]>(row.extracurriculars, []),
    careerGoals: row.career_goals,
    financialNeed: row.financial_need as StudentRecord["financialNeed"],
    preferredRegions: fromJson<string[]>(row.preferred_regions, []),
    createdAt: row.created_at,
  };
  // Absent until the profile is actually edited, as it was in memory.
  if (row.updated_at) record.updatedAt = row.updated_at;
  return record;
}

function applicationFromRow(row: ApplicationRow | null): ApplicationRecord | null {
  if (!row) return null;
  const record: ApplicationRecord = {
    id: row.id,
    studentId: row.student_id,
    universityId: row.university_id,
    plan: row.plan,
    status: row.status,
    deadline: row.deadline,
    deadlineIsTypical: Boolean(row.deadline_is_typical),
    checklist: fromJson<Checklist>(row.checklist, {}),
    notes: row.notes,
    createdAt: row.created_at,
  };
  if (row.updated_at) record.updatedAt = row.updated_at;
  return record;
}

/**
 * `password_hash` is deliberately dropped here.
 *
 * Every route that returns a user returns this shape, so the hash cannot reach
 * a response body by someone forgetting to strip it — the only code that sees
 * it is the login path, which reads the row directly.
 */
function userFromRow(row: UserRow | null): UserRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    guest: row.email === null,
    createdAt: row.created_at,
  };
}

function noteFromRow(row: SchoolNoteRow | null): SchoolNoteRecord | null {
  if (!row) return null;
  const record: SchoolNoteRecord = {
    universityId: row.university_id,
    starred: Boolean(row.starred),
    note: row.note,
    createdAt: row.created_at,
  };
  if (row.updated_at) record.updatedAt = row.updated_at;
  return record;
}

export type Store = ReturnType<typeof createStore>;

/**
 * Build a store bound to one request's D1 handle.
 *
 * `db.prepare()` is cheap and the statements are re-bound per call, so they
 * are declared once here rather than rebuilt inside each method.
 */
export function createStore(db: D1Database) {
  // ---- Students ----

  const insertStudent = db.prepare(`
    INSERT INTO students (
      id, name, gpa, sat_score, act_score, interested_majors, extracurriculars,
      career_goals, financial_need, preferred_regions, created_at, user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `);

  const selectStudent = db.prepare("SELECT * FROM students WHERE id = ?");

  // The ownership lookup the whole phase turns on: given a session's user,
  // which profile may it touch? The UNIQUE index on students.user_id is what
  // makes "the" profile a well-defined thing to ask for.
  const selectStudentByUser = db.prepare("SELECT * FROM students WHERE user_id = ?");

  const updateStudentRow = db.prepare(`
    UPDATE students SET
      name = ?, gpa = ?, sat_score = ?, act_score = ?, interested_majors = ?,
      extracurriculars = ?, career_goals = ?, financial_need = ?,
      preferred_regions = ?, updated_at = ?
    WHERE id = ?
    RETURNING *
  `);

  /**
   * Create a profile owned by `userId`.
   *
   * The owner is required rather than optional: an unowned profile is exactly
   * the hole this phase closes, and making the argument optional would let a
   * future caller reopen it by omission. Guests are not an exception — they
   * have a user row too.
   */
  async function createStudent(
    profile: StudentProfile,
    userId: number
  ): Promise<StudentRecord> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const row = await insertStudent
      .bind(
        id,
        profile.name,
        profile.gpa,
        profile.satScore ?? null,
        profile.actScore ?? null,
        toJson(profile.interestedMajors ?? []),
        toJson(profile.extracurriculars ?? []),
        profile.careerGoals ?? "",
        profile.financialNeed ?? "medium",
        toJson(profile.preferredRegions ?? []),
        createdAt,
        userId
      )
      .first<StudentRow>();
    // The INSERT either returns its row or throws; a null here would mean D1
    // accepted a write and produced nothing, which is not a case to paper over.
    return studentFromRow(row)!;
  }

  async function getStudent(id: unknown): Promise<StudentRecord | null> {
    if (typeof id !== "string") return null;
    return studentFromRow(await selectStudent.bind(id).first<StudentRow>());
  }

  async function getStudentByUserId(userId: number): Promise<StudentRecord | null> {
    return studentFromRow(await selectStudentByUser.bind(userId).first<StudentRow>());
  }

  async function updateStudent(
    id: string,
    profile: Partial<StudentProfile>
  ): Promise<StudentRecord | null> {
    const existing = await getStudent(id);
    if (!existing) return null;
    // Merge rather than replace: a caller sending a partial profile keeps the
    // fields it left out, which is what the in-memory spread did.
    const next = { ...existing, ...profile };
    const row = await updateStudentRow
      .bind(
        next.name,
        next.gpa,
        next.satScore ?? null,
        next.actScore ?? null,
        toJson(next.interestedMajors ?? []),
        toJson(next.extracurriculars ?? []),
        next.careerGoals ?? "",
        next.financialNeed ?? "medium",
        toJson(next.preferredRegions ?? []),
        new Date().toISOString(),
        id
      )
      .first<StudentRow>();
    return studentFromRow(row);
  }

  // ---- Conversations ----

  const insertMessage = db.prepare(
    "INSERT INTO messages (student_id, role, content, at) VALUES (?, ?, ?, ?)"
  );

  const selectMessages = db.prepare(
    "SELECT role, content, at FROM messages WHERE student_id = ? ORDER BY seq"
  );

  // Keep history bounded at the most recent 40 turns, as before — the difference
  // is that the trim now happens in the table instead of in an array.
  const trimMessages = db.prepare(`
    DELETE FROM messages
    WHERE student_id = ?
      AND seq NOT IN (
        SELECT seq FROM messages WHERE student_id = ? ORDER BY seq DESC LIMIT 40
      )
  `);

  async function getConversation(studentId: unknown): Promise<ChatMessage[]> {
    if (typeof studentId !== "string") return [];
    const { results } = await selectMessages.bind(studentId).all<ChatMessage>();
    return results;
  }

  async function appendMessage(
    studentId: string,
    role: string,
    content: string
  ): Promise<ChatMessage[]> {
    // Batched so the insert and the trim land together. On Express these were
    // two synchronous calls that could not interleave; in a Worker two
    // concurrent chat requests can, and a trim that runs against a
    // half-written history would drop the wrong turn.
    await db.batch([
      insertMessage.bind(studentId, role, content, new Date().toISOString()),
      trimMessages.bind(studentId, studentId),
    ]);
    return getConversation(studentId);
  }

  // ---- Applications ----
  //
  // One list per student. A student can only track a given university once —
  // picking a different decision plan for the same school is an edit, not a
  // second application. That rule is a UNIQUE constraint in the schema.

  const selectApplications = db.prepare(
    "SELECT * FROM applications WHERE student_id = ? ORDER BY created_at, id"
  );

  const selectApplication = db.prepare(
    "SELECT * FROM applications WHERE student_id = ? AND id = ?"
  );

  const countApplicationFor = db.prepare(
    "SELECT COUNT(*) AS n FROM applications WHERE student_id = ? AND university_id = ?"
  );

  const insertApplication = db.prepare(`
    INSERT INTO applications (
      id, student_id, university_id, plan, status, deadline,
      deadline_is_typical, checklist, notes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `);

  const updateApplicationRow = db.prepare(`
    UPDATE applications SET
      university_id = ?, plan = ?, status = ?, deadline = ?,
      deadline_is_typical = ?, checklist = ?, notes = ?, updated_at = ?
    WHERE student_id = ? AND id = ?
    RETURNING *
  `);

  const deleteApplicationRow = db.prepare(
    "DELETE FROM applications WHERE student_id = ? AND id = ?"
  );

  async function getApplications(studentId: unknown): Promise<ApplicationRecord[]> {
    if (typeof studentId !== "string") return [];
    const { results } = await selectApplications.bind(studentId).all<ApplicationRow>();
    return results.map((r) => applicationFromRow(r)!);
  }

  async function findApplication(
    studentId: unknown,
    applicationId: unknown
  ): Promise<ApplicationRecord | null> {
    if (typeof studentId !== "string" || typeof applicationId !== "string") return null;
    return applicationFromRow(
      await selectApplication.bind(studentId, applicationId).first<ApplicationRow>()
    );
  }

  async function hasApplicationFor(studentId: string, universityId: number): Promise<boolean> {
    const row = await countApplicationFor
      .bind(studentId, universityId)
      .first<{ n: number }>();
    return (row?.n ?? 0) > 0;
  }

  async function createApplication(
    studentId: string,
    application: ApplicationInput
  ): Promise<ApplicationRecord> {
    const id = crypto.randomUUID();
    const row = await insertApplication
      .bind(
        id,
        studentId,
        application.universityId,
        application.plan,
        application.status,
        application.deadline ?? null,
        bool(application.deadlineIsTypical),
        toJson(application.checklist ?? {}),
        application.notes ?? "",
        new Date().toISOString()
      )
      .first<ApplicationRow>();
    return applicationFromRow(row)!;
  }

  async function updateApplication(
    studentId: string,
    applicationId: string,
    patch: Partial<ApplicationInput>
  ): Promise<ApplicationRecord | null> {
    const existing = await findApplication(studentId, applicationId);
    if (!existing) return null;
    // id, studentId and createdAt are not patchable — the merge order below is
    // what guarantees that, same as the in-memory version.
    const next = { ...existing, ...patch };
    const row = await updateApplicationRow
      .bind(
        existing.universityId,
        next.plan,
        next.status,
        next.deadline ?? null,
        bool(next.deadlineIsTypical),
        toJson(next.checklist ?? {}),
        next.notes ?? "",
        new Date().toISOString(),
        studentId,
        applicationId
      )
      .first<ApplicationRow>();
    return applicationFromRow(row);
  }

  async function deleteApplication(
    studentId: unknown,
    applicationId: unknown
  ): Promise<boolean> {
    if (typeof studentId !== "string" || typeof applicationId !== "string") return false;
    const { meta } = await deleteApplicationRow.bind(studentId, applicationId).run();
    return meta.changes > 0;
  }

  // ---- School notes ----
  //
  // A star and a scrap of text per school, keyed by the pair rather than by an
  // id of its own: there is exactly one note per school, and every page edits
  // the same one. A note that is emptied and unstarred is deleted rather than
  // kept as a blank row — an empty note is the absence of a note.

  const selectNotes = db.prepare(
    "SELECT * FROM school_notes WHERE student_id = ? ORDER BY starred DESC, updated_at DESC, created_at DESC"
  );

  const selectNote = db.prepare(
    "SELECT * FROM school_notes WHERE student_id = ? AND university_id = ?"
  );

  // The pair is the primary key, so an upsert is the whole write path: no
  // read-then-branch, and no way to end up with two notes for one school.
  const upsertNote = db.prepare(`
    INSERT INTO school_notes (student_id, university_id, starred, note, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (student_id, university_id) DO UPDATE SET
      starred = excluded.starred,
      note = excluded.note,
      updated_at = excluded.created_at
    RETURNING *
  `);

  const deleteNoteRow = db.prepare(
    "DELETE FROM school_notes WHERE student_id = ? AND university_id = ?"
  );

  async function getSchoolNotes(studentId: unknown): Promise<SchoolNoteRecord[]> {
    if (typeof studentId !== "string") return [];
    const { results } = await selectNotes.bind(studentId).all<SchoolNoteRow>();
    return results.map((r) => noteFromRow(r)!);
  }

  async function getSchoolNote(
    studentId: unknown,
    universityId: number
  ): Promise<SchoolNoteRecord | null> {
    if (typeof studentId !== "string") return null;
    return noteFromRow(await selectNote.bind(studentId, universityId).first<SchoolNoteRow>());
  }

  async function saveSchoolNote(
    studentId: string,
    universityId: number,
    { starred = false, note = "" }: { starred?: boolean; note?: string } = {}
  ): Promise<SchoolNoteRecord | null> {
    if (!starred && note.trim() === "") {
      await deleteNoteRow.bind(studentId, universityId).run();
      return null;
    }
    const row = await upsertNote
      .bind(studentId, universityId, bool(starred), note, new Date().toISOString())
      .first<SchoolNoteRow>();
    return noteFromRow(row);
  }

  async function deleteSchoolNote(
    studentId: unknown,
    universityId: number
  ): Promise<boolean> {
    if (typeof studentId !== "string") return false;
    const { meta } = await deleteNoteRow.bind(studentId, universityId).run();
    return meta.changes > 0;
  }

  // ---- Accounts & sessions ----
  //
  // Every visitor who owns anything has a users row, guest or not. See
  // migrations/0003_auth.sql for why that is one table rather than two.

  const insertUser = db.prepare(
    "INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?) RETURNING *"
  );

  const selectUser = db.prepare("SELECT * FROM users WHERE id = ?");

  // Only ever called with a non-null email, so an anonymous row (email NULL)
  // can never match: `NULL = 'x'` is not true in SQL. That is what makes a
  // guest account unreachable by login without a check to remember.
  const selectUserByEmail = db.prepare("SELECT * FROM users WHERE email = ?");

  // `AND email IS NULL` is the guard that makes claiming safe: it can only
  // ever fill in a guest row, never overwrite the email or password of an
  // account that already exists.
  const claimUserRow = db.prepare(`
    UPDATE users SET email = ?, password_hash = ?, updated_at = ?
    WHERE id = ? AND email IS NULL
    RETURNING *
  `);

  const insertSession = db.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  );

  const selectSession = db.prepare(
    "SELECT * FROM sessions WHERE id = ? AND expires_at > ?"
  );

  const deleteSessionRow = db.prepare("DELETE FROM sessions WHERE id = ?");

  const sweepSessionRows = db.prepare("DELETE FROM sessions WHERE expires_at <= ?");

  /** Sessions last 30 days from creation. Not extended on use — a fixed life
   *  means a stolen cookie has a definite expiry rather than one the thief can
   *  renew indefinitely just by continuing to use it. */
  const SESSION_DAYS = 30;

  async function createAnonymousUser(): Promise<UserRecord> {
    const row = await insertUser
      .bind(null, null, new Date().toISOString())
      .first<UserRow>();
    return userFromRow(row)!;
  }

  async function getUser(id: number): Promise<UserRecord | null> {
    return userFromRow(await selectUser.bind(id).first<UserRow>());
  }

  /**
   * The one place a password hash leaves the database.
   *
   * Returns the raw row rather than a UserRecord precisely because the login
   * route needs `password_hash`, and naming that exception here keeps every
   * other caller on the shape that cannot leak it.
   */
  async function findUserForLogin(email: string): Promise<UserRow | null> {
    return (await selectUserByEmail.bind(email).first<UserRow>()) ?? null;
  }

  async function emailTaken(email: string): Promise<boolean> {
    return (await selectUserByEmail.bind(email).first<UserRow>()) != null;
  }

  /**
   * Turn a guest row into a real account.
   *
   * Null when the row already has an email — either a genuine race between two
   * signups on one session, or a bug. Either way the caller must not treat it
   * as success, which is why it is a null rather than a silent no-op.
   */
  async function claimUser(
    userId: number,
    email: string,
    passwordHash: string
  ): Promise<UserRecord | null> {
    const row = await claimUserRow
      .bind(email, passwordHash, new Date().toISOString(), userId)
      .first<UserRow>();
    return userFromRow(row);
  }

  async function createSession(userId: number): Promise<SessionRecord> {
    // randomUUID is a CSPRNG here — 122 bits of entropy, which is the whole
    // security of a bearer token that is never derived from anything.
    const id = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    await insertSession.bind(id, userId, now.toISOString(), expiresAt).run();
    return { id, userId, expiresAt };
  }

  /**
   * Look up a live session.
   *
   * Expiry is enforced in the WHERE clause, not by the caller: an expired row
   * is indistinguishable from a missing one to every consumer, so there is no
   * path where a stale session is read and then forgotten about. ISO-8601 UTC
   * strings compare correctly with `>`, which is why the column is TEXT.
   */
  async function getSession(sessionId: unknown): Promise<SessionRecord | null> {
    if (typeof sessionId !== "string" || sessionId === "") return null;
    const row = await selectSession
      .bind(sessionId, new Date().toISOString())
      .first<SessionRow>();
    if (!row) return null;
    return { id: row.id, userId: row.user_id, expiresAt: row.expires_at };
  }

  async function deleteSession(sessionId: string): Promise<void> {
    await deleteSessionRow.bind(sessionId).run();
  }

  /** Housekeeping — expired rows are already unreadable, this reclaims space. */
  async function sweepSessions(): Promise<void> {
    await sweepSessionRows.bind(new Date().toISOString()).run();
  }

  return {
    createStudent,
    getStudent,
    getStudentByUserId,
    updateStudent,
    createAnonymousUser,
    getUser,
    findUserForLogin,
    emailTaken,
    claimUser,
    createSession,
    getSession,
    deleteSession,
    sweepSessions,
    getConversation,
    appendMessage,
    getApplications,
    findApplication,
    hasApplicationFor,
    createApplication,
    updateApplication,
    deleteApplication,
    getSchoolNotes,
    getSchoolNote,
    saveSchoolNote,
    deleteSchoolNote,
  };
}
