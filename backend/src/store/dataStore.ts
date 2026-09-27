// D1 storage for everything a student creates. Built per request from the D1
// binding; writes use RETURNING to save a round trip.

import type { FirstFactor } from "../auth/secondFactorLimit.js";
import { DEFAULT_CHAT_MODE, type ChatMode } from "../models/chatMode.js";
import type {
  ApplicationInput,
  ApplicationRecord,
  Checklist,
  ChatMessage,
  SchoolNoteRecord,
  SessionRecord,
  ShareLinkRecord,
  StudentProfile,
  StudentRecord,
  UserRecord,
} from "../types.js";

// --- JSON column helpers -------------------------------------------------
// A malformed JSON column falls back to the empty value rather than failing
// the request.

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

// D1 reports a constraint violation only through the error's message, so this
// is a string match — kept narrow on purpose, since anything else is rethrown.
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/**
 * A signup waiting on its link. It carries the password hash, so it belongs to
 * the store and the verify route only — never to a response body.
 */
export interface PendingSignup {
  email: string;
  passwordHash: string;
  guestUserId: number;
}

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
  totp_secret: string | null;
  totp_enabled_at: string | null;
  totp_last_step: number | null;
}

interface SessionRow {
  id: string;
  user_id: number;
  created_at: string;
  expires_at: string;
}

interface ShareLinkRow {
  token: string;
  student_id: string;
  created_at: string;
}

interface SchoolNoteRow {
  student_id: string;
  university_id: number;
  starred: number;
  note: string;
  contact_name: string;
  contact_role: string;
  contact_last_at: string;
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

/** Drops `password_hash`, so no route can return it by forgetting to strip it. */
function userFromRow(row: UserRow | null): UserRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    guest: row.email === null,
    createdAt: row.created_at,
    // Confirmed only; a staged secret never proved with a code doesn't count.
    twoFactorEnabled: row.totp_enabled_at !== null,
  };
}

function shareFromRow(row: ShareLinkRow | null): ShareLinkRecord | null {
  if (!row) return null;
  return { token: row.token, studentId: row.student_id, createdAt: row.created_at };
}

function noteFromRow(row: SchoolNoteRow | null): SchoolNoteRecord | null {
  if (!row) return null;
  const record: SchoolNoteRecord = {
    universityId: row.university_id,
    starred: Boolean(row.starred),
    note: row.note,
    // Never undefined: a missing field would make the client's input uncontrolled.
    contactName: row.contact_name ?? "",
    contactRole: row.contact_role ?? "",
    contactLastAt: row.contact_last_at ?? "",
    createdAt: row.created_at,
  };
  if (row.updated_at) record.updatedAt = row.updated_at;
  return record;
}

export type Store = ReturnType<typeof createStore>;

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

  // The ownership lookup. students.user_id is UNIQUE: one profile per user.
  const selectStudentByUser = db.prepare("SELECT * FROM students WHERE user_id = ?");

  const updateStudentRow = db.prepare(`
    UPDATE students SET
      name = ?, gpa = ?, sat_score = ?, act_score = ?, interested_majors = ?,
      extracurriculars = ?, career_goals = ?, financial_need = ?,
      preferred_regions = ?, updated_at = ?
    WHERE id = ?
    RETURNING *
  `);

  /** `userId` is required: an unowned profile is readable by anyone. */
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

  // Scoped to (student, mode): the advisor and essay assistant keep separate
  // threads and must not see each other's history.
  const insertMessage = db.prepare(
    "INSERT INTO messages (student_id, role, content, at, mode) VALUES (?, ?, ?, ?, ?)"
  );

  const selectMessages = db.prepare(
    "SELECT role, content, at FROM messages WHERE student_id = ? AND mode = ? ORDER BY seq"
  );

  // The latest 40 turns per mode, so one thread can't evict the other.
  const trimMessages = db.prepare(`
    DELETE FROM messages
    WHERE student_id = ?
      AND mode = ?
      AND seq NOT IN (
        SELECT seq FROM messages WHERE student_id = ? AND mode = ? ORDER BY seq DESC LIMIT 40
      )
  `);

  async function getConversation(
    studentId: unknown,
    mode: ChatMode = DEFAULT_CHAT_MODE
  ): Promise<ChatMessage[]> {
    if (typeof studentId !== "string") return [];
    const { results } = await selectMessages.bind(studentId, mode).all<ChatMessage>();
    return results;
  }

  async function appendMessage(
    studentId: string,
    role: string,
    content: string,
    mode: ChatMode = DEFAULT_CHAT_MODE
  ): Promise<ChatMessage[]> {
    // Batched: concurrent chat requests could otherwise interleave insert and
    // trim, and the trim would drop the wrong turn.
    await db.batch([
      insertMessage.bind(studentId, role, content, new Date().toISOString(), mode),
      trimMessages.bind(studentId, mode, studentId, mode),
    ]);
    return getConversation(studentId, mode);
  }

  // ---- Applications ----
  //
  // One per (student, university), enforced by a UNIQUE constraint.

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
  // Keyed by (student, university): one note per school, shared by every page.

  const selectNotes = db.prepare(
    "SELECT * FROM school_notes WHERE student_id = ? ORDER BY starred DESC, updated_at DESC, created_at DESC"
  );

  const selectNote = db.prepare(
    "SELECT * FROM school_notes WHERE student_id = ? AND university_id = ?"
  );

  // The pair is the primary key, so an upsert is the whole write path: no
  // read-then-branch, and no way to end up with two notes for one school.
  const upsertNote = db.prepare(`
    INSERT INTO school_notes (
      student_id, university_id, starred, note,
      contact_name, contact_role, contact_last_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (student_id, university_id) DO UPDATE SET
      starred = excluded.starred,
      note = excluded.note,
      contact_name = excluded.contact_name,
      contact_role = excluded.contact_role,
      contact_last_at = excluded.contact_last_at,
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
    {
      starred = false,
      note = "",
      contactName = "",
      contactRole = "",
      contactLastAt = "",
    }: {
      starred?: boolean;
      note?: string;
      contactName?: string;
      contactRole?: string;
      contactLastAt?: string;
    } = {}
  ): Promise<SchoolNoteRecord | null> {
    // An empty note is deleted, not stored blank. "Empty" must cover every
    // field, or unstarring a school would silently delete its contact.
    const holdsNothing =
      !starred &&
      note.trim() === "" &&
      contactName.trim() === "" &&
      contactRole.trim() === "" &&
      contactLastAt.trim() === "";

    if (holdsNothing) {
      await deleteNoteRow.bind(studentId, universityId).run();
      return null;
    }

    const row = await upsertNote
      .bind(
        studentId,
        universityId,
        bool(starred),
        note,
        contactName,
        contactRole,
        contactLastAt,
        new Date().toISOString()
      )
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

  // ---- Share links ----
  //
  // One per student (UNIQUE on student_id).

  const selectShareByStudent = db.prepare("SELECT * FROM share_links WHERE student_id = ?");
  const selectShareByToken = db.prepare("SELECT * FROM share_links WHERE token = ?");
  const insertShare = db.prepare(
    "INSERT INTO share_links (token, student_id, created_at) VALUES (?, ?, ?) RETURNING *"
  );
  const deleteShare = db.prepare("DELETE FROM share_links WHERE student_id = ?");

  async function getShareLink(studentId: string): Promise<ShareLinkRecord | null> {
    return shareFromRow(await selectShareByStudent.bind(studentId).first<ShareLinkRow>());
  }

  /**
   * The API's only unauthenticated read of student data. Returns the id only;
   * what a link holder may see is decided in the route.
   */
  async function findShareLink(token: unknown): Promise<ShareLinkRecord | null> {
    if (typeof token !== "string" || token === "") return null;
    return shareFromRow(await selectShareByToken.bind(token).first<ShareLinkRow>());
  }

  /** The student's link, creating one if they have none. Idempotent. */
  async function ensureShareLink(studentId: string): Promise<ShareLinkRecord> {
    const existing = await getShareLink(studentId);
    if (existing) return existing;
    const row = await insertShare
      .bind(crypto.randomUUID(), studentId, new Date().toISOString())
      .first<ShareLinkRow>();
    return shareFromRow(row)!;
  }

  /** Batched, so a concurrent caller can't hit the UNIQUE between delete and insert. */
  async function rotateShareLink(studentId: string): Promise<ShareLinkRecord> {
    const token = crypto.randomUUID();
    await db.batch([
      deleteShare.bind(studentId),
      insertShare.bind(token, studentId, new Date().toISOString()),
    ]);
    return (await getShareLink(studentId))!;
  }

  async function revokeShareLink(studentId: string): Promise<boolean> {
    const { meta } = await deleteShare.bind(studentId).run();
    return meta.changes > 0;
  }

  // ---- Accounts & sessions ----
  //
  // Guests and members share the users table; a guest has a NULL email.

  const insertUser = db.prepare(
    "INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?) RETURNING *"
  );

  const selectUser = db.prepare("SELECT * FROM users WHERE id = ?");

  // `NULL = 'x'` is never true, so a guest row can't be reached by login.
  const selectUserByEmail = db.prepare("SELECT * FROM users WHERE email = ?");

  // `AND email IS NULL`: a claim can fill in a guest row, never overwrite an account.
  const claimUserRow = db.prepare(`
    UPDATE users SET email = ?, password_hash = ?, updated_at = ?
    WHERE id = ? AND email IS NULL
    RETURNING *
  `);

  // ---- Pending signups ----
  const insertPendingSignup = db.prepare(
    "INSERT INTO pending_signups (token_hash, email, password_hash, guest_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  // Expiry in the WHERE clause, as for sessions and resets: a stale link is
  // indistinguishable from a missing one to everything that reads it.
  const selectLivePendingSignup = db.prepare(
    "SELECT email, password_hash, guest_user_id FROM pending_signups WHERE token_hash = ? AND expires_at > ?"
  );
  const clearPendingSignupsFor = db.prepare(
    "DELETE FROM pending_signups WHERE email = ? OR guest_user_id = ?"
  );
  const sweepPendingSignupRows = db.prepare("DELETE FROM pending_signups WHERE expires_at <= ?");

  const insertSession = db.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  );

  const selectSession = db.prepare(
    "SELECT * FROM sessions WHERE id = ? AND expires_at > ?"
  );

  const deleteSessionRow = db.prepare("DELETE FROM sessions WHERE id = ?");

  const sweepSessionRows = db.prepare("DELETE FROM sessions WHERE expires_at <= ?");

  // Order matters; see deleteAccount.
  const deleteStudentsOfUser = db.prepare("DELETE FROM students WHERE user_id = ?");

  // ---- Password resets ----
  const insertReset = db.prepare(
    "INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  );
  // Expiry and single-use live in the WHERE, so no caller can forget them.
  const selectLiveReset = db.prepare(
    "SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?"
  );
  const spendReset = db.prepare(
    "UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL"
  );
  const clearResetsForUser = db.prepare("DELETE FROM password_resets WHERE user_id = ?");
  // Unspent only: the spent row stays so a replay is distinguishable from a
  // typo. The expiry sweep removes it later.
  const clearUnusedResetsForUser = db.prepare(
    "DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL"
  );
  const sweepResetRows = db.prepare("DELETE FROM password_resets WHERE expires_at <= ?");
  const updatePasswordRow = db.prepare(
    "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND email IS NOT NULL"
  );
  // Compare-and-set on the old hash — see rehashPassword for why that matters.
  const rehashPasswordRow = db.prepare(
    "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND password_hash = ?"
  );
  const deleteSessionsForUser = db.prepare("DELETE FROM sessions WHERE user_id = ?");

  // ---- Two-factor ----
  // Only while 2FA is off — see stageTotpSecret for why the guard is in the UPDATE.
  const stageTotpSecretRow = db.prepare(
    "UPDATE users SET totp_secret = ?, totp_last_step = NULL, updated_at = ? WHERE id = ? AND email IS NOT NULL AND totp_enabled_at IS NULL"
  );
  const setTotpSecretRow = db.prepare(
    "UPDATE users SET totp_secret = ?, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = ? WHERE id = ? AND email IS NOT NULL"
  );
  const enableTotpRow = db.prepare(
    "UPDATE users SET totp_enabled_at = ?, totp_last_step = ?, updated_at = ? WHERE id = ? AND totp_secret IS NOT NULL AND totp_enabled_at IS NULL"
  );
  const disableTotpRow = db.prepare(
    "UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = ? WHERE id = ?"
  );
  // The compare-and-set that makes replay impossible: the step only moves
  // forward, so a code already spent cannot be spent again inside its window.
  const advanceTotpStepRow = db.prepare(
    "UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)"
  );
  const insertRecoveryCode = db.prepare(
    "INSERT INTO recovery_codes (code_hash, user_id, created_at) VALUES (?, ?, ?)"
  );
  const selectLiveRecoveryCode = db.prepare(
    "SELECT code_hash FROM recovery_codes WHERE code_hash = ? AND user_id = ? AND used_at IS NULL"
  );
  const spendRecoveryCode = db.prepare(
    "UPDATE recovery_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL"
  );
  const clearRecoveryCodes = db.prepare("DELETE FROM recovery_codes WHERE user_id = ?");
  const countRecoveryCodes = db.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) AS remaining FROM recovery_codes WHERE user_id = ?"
  );
  const insertChallenge = db.prepare(
    "INSERT INTO mfa_challenges (token_hash, user_id, created_at, expires_at, purpose) VALUES (?, ?, ?, ?, ?)"
  );
  const selectChallenge = db.prepare(
    "SELECT user_id FROM mfa_challenges WHERE token_hash = ? AND purpose = ? AND expires_at > ?"
  );
  const deleteChallenge = db.prepare("DELETE FROM mfa_challenges WHERE token_hash = ?");
  const clearChallengesForUser = db.prepare("DELETE FROM mfa_challenges WHERE user_id = ?");
  const sweepChallengeRows = db.prepare("DELETE FROM mfa_challenges WHERE expires_at <= ?");

  // ---- Two-factor attempt limit ----
  // Succeeds only if the account is not locked, and pushes the lock ahead while
  // one code is checked. A locked account updates nothing, so RETURNING is empty.
  const claimAttemptRow = db.prepare(`
    INSERT INTO mfa_attempts (user_id, factor, failures, locked_until)
    VALUES (?, ?, 0, ?)
    ON CONFLICT (user_id, factor) DO UPDATE SET locked_until = excluded.locked_until
    WHERE mfa_attempts.locked_until <= ?
    RETURNING failures
  `);
  const selectAttemptLock = db.prepare(
    "SELECT locked_until FROM mfa_attempts WHERE user_id = ? AND factor = ?"
  );
  const recordAttemptFailureRow = db.prepare(
    "UPDATE mfa_attempts SET failures = failures + 1, locked_until = ? WHERE user_id = ? AND factor = ?"
  );
  // Both factors' rows: a right code through either clears the other as well.
  const clearAttemptRows = db.prepare("DELETE FROM mfa_attempts WHERE user_id = ?");

  const deleteUserRow = db.prepare("DELETE FROM users WHERE id = ?");

  /** Fixed from creation, not extended on use, so a stolen cookie still expires. */
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

  /** The one place a password hash leaves the database. */
  async function findUserForLogin(email: string): Promise<UserRow | null> {
    return (await selectUserByEmail.bind(email).first<UserRow>()) ?? null;
  }

  async function emailTaken(email: string): Promise<boolean> {
    return (await selectUserByEmail.bind(email).first<UserRow>()) != null;
  }

  /** Hold a signup until its emailed link is opened. */
  async function createPendingSignup(
    tokenHash: string,
    email: string,
    passwordHash: string,
    guestUserId: number,
    ttlMinutes: number
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();
    await insertPendingSignup
      .bind(tokenHash, email, passwordHash, guestUserId, now.toISOString(), expiresAt)
      .run();
  }

  /** The live signup this token names — or null for every other case. */
  async function findPendingSignup(tokenHash: string): Promise<PendingSignup | null> {
    const row = await selectLivePendingSignup
      .bind(tokenHash, new Date().toISOString())
      .first<{ email: string; password_hash: string; guest_user_id: number }>();
    return row
      ? { email: row.email, passwordHash: row.password_hash, guestUserId: row.guest_user_id }
      : null;
  }

  /**
   * Fills in the guest row that asked, so its profile needs no reparenting.
   * "email-taken": another signup for the address won first. "stale": this
   * guest already became an account through a different signup. On success,
   * all other pending signups for the address and the guest are cleared.
   */
  async function completeSignup(
    pending: PendingSignup
  ): Promise<
    { status: "created"; user: UserRecord } | { status: "email-taken" } | { status: "stale" }
  > {
    if (await emailTaken(pending.email)) return { status: "email-taken" };

    let row: UserRow | null;
    try {
      row = await claimUserRow
        .bind(pending.email, pending.passwordHash, new Date().toISOString(), pending.guestUserId)
        .first<UserRow>();
    } catch (err) {
      if (isUniqueViolation(err)) return { status: "email-taken" };
      throw err;
    }
    if (!row) return { status: "stale" };

    await clearPendingSignupsFor.bind(pending.email, pending.guestUserId).run();
    return { status: "created", user: userFromRow(row)! };
  }

  /** Housekeeping — expired signups are already unusable, this reclaims space. */
  async function sweepPendingSignups(): Promise<void> {
    await sweepPendingSignupRows.bind(new Date().toISOString()).run();
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

  /** Expiry is in the WHERE; ISO-8601 UTC text compares correctly with `>`. */
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

  /** Newest wins: requesting a new link invalidates any earlier one. */
  async function createPasswordReset(
    userId: number,
    tokenHash: string,
    ttlMinutes: number
  ): Promise<{ expiresAt: string }> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();
    await db.batch([
      clearResetsForUser.bind(userId),
      insertReset.bind(tokenHash, userId, now.toISOString(), expiresAt),
    ]);
    return { expiresAt };
  }

  /** The live, unspent reset this token names — or null for every other case. */
  async function findPasswordReset(tokenHash: string): Promise<{ userId: number } | null> {
    const row = await selectLiveReset
      .bind(tokenHash, new Date().toISOString())
      .first<{ user_id: number }>();
    return row ? { userId: row.user_id } : null;
  }

  /**
   * One transaction: spend the token (`used_at IS NULL` makes it a
   * compare-and-set), set the hash (never on a guest row), drop other unspent
   * tokens, and revoke every session in case an attacker holds one. False if
   * a concurrent submit spent the token first.
   */
  async function resetPassword(
    tokenHash: string,
    userId: number,
    passwordHash: string
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const results = await db.batch([
      spendReset.bind(now, tokenHash),
      updatePasswordRow.bind(passwordHash, now, userId),
      clearUnusedResetsForUser.bind(userId),
      deleteSessionsForUser.bind(userId),
    ]);
    return (results[0]?.meta?.changes ?? 0) > 0;
  }

  /**
   * Not resetPassword, which would revoke sessions on a successful login.
   * The WHERE on the old hash stops this, running in waitUntil, from undoing a
   * password change that lands while it is in flight.
   */
  async function rehashPassword(
    userId: number,
    previousHash: string,
    upgradedHash: string
  ): Promise<void> {
    await rehashPasswordRow
      .bind(upgradedHash, new Date().toISOString(), userId, previousHash)
      .run();
  }

  /** The one place the TOTP secret leaves the table; never put it on UserRecord. */
  async function getTotpState(
    userId: number
  ): Promise<{ secret: string | null; enabled: boolean; lastStep: number | null } | null> {
    const row = await selectUser.bind(userId).first<UserRow>();
    if (!row) return null;
    return {
      secret: row.totp_secret,
      enabled: row.totp_enabled_at !== null,
      lastStep: row.totp_last_step,
    };
  }

  /**
   * False if 2FA is already on (use replaceTotpSecret). The guard is in the
   * UPDATE so 2FA enabled in another tab since the route's read isn't overwritten.
   */
  async function stageTotpSecret(userId: number, secret: string): Promise<boolean> {
    const { meta } = await stageTotpSecretRow
      .bind(secret, new Date().toISOString(), userId)
      .run();
    return meta.changes > 0;
  }

  /**
   * Call only after checking a current second factor: this switches 2FA off as
   * surely as disableTotp, and clears the same recovery codes, counts and
   * pending challenges. 2FA stays off until /2fa/enable confirms the new secret.
   */
  async function replaceTotpSecret(userId: number, secret: string): Promise<void> {
    await db.batch([
      setTotpSecretRow.bind(secret, new Date().toISOString(), userId),
      clearRecoveryCodes.bind(userId),
      clearChallengesForUser.bind(userId),
      clearAttemptRows.bind(userId),
    ]);
  }

  /**
   * One batch, so 2FA is never on without recovery codes (reset doesn't
   * bypass 2FA). Also spends `step`, so the confirming code can't sign in.
   */
  async function enableTotp(
    userId: number,
    step: number,
    codeHashes: string[]
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const results = await db.batch([
      enableTotpRow.bind(now, step, now, userId),
      clearRecoveryCodes.bind(userId),
      // A new secret starts from a clean count; an old one never carries over.
      clearAttemptRows.bind(userId),
      ...codeHashes.map((hash) => insertRecoveryCode.bind(hash, userId, now)),
    ]);
    return (results[0]?.meta?.changes ?? 0) > 0;
  }

  /** Turn it off and destroy every recovery code, pending challenge and wrong-code count. */
  async function disableTotp(userId: number): Promise<void> {
    await db.batch([
      disableTotpRow.bind(new Date().toISOString(), userId),
      clearRecoveryCodes.bind(userId),
      clearChallengesForUser.bind(userId),
      clearAttemptRows.bind(userId),
    ]);
  }

  /** False on replay. Guarded in the UPDATE so two identical codes can't both win. */
  async function consumeTotpStep(userId: number, step: number): Promise<boolean> {
    const { meta } = await advanceTotpStepRow.bind(step, userId, step).run();
    return meta.changes > 0;
  }

  /** Spend a recovery code. False if it never existed or was already used. */
  async function consumeRecoveryCode(userId: number, codeHash: string): Promise<boolean> {
    const live = await selectLiveRecoveryCode.bind(codeHash, userId).first<{ code_hash: string }>();
    if (!live) return false;
    const { meta } = await spendRecoveryCode.bind(new Date().toISOString(), codeHash).run();
    return meta.changes > 0;
  }

  /** How many codes are left, for the "3 of 10 remaining" line. */
  async function countRecoveryCodesLeft(
    userId: number
  ): Promise<{ total: number; remaining: number }> {
    const row = await countRecoveryCodes
      .bind(userId)
      .first<{ total: number; remaining: number | null }>();
    return { total: row?.total ?? 0, remaining: row?.remaining ?? 0 };
  }

  /** Replace the whole batch — used by "generate new codes". */
  async function replaceRecoveryCodes(userId: number, codeHashes: string[]): Promise<void> {
    const now = new Date().toISOString();
    await db.batch([
      clearRecoveryCodes.bind(userId),
      ...codeHashes.map((hash) => insertRecoveryCode.bind(hash, userId, now)),
    ]);
  }

  /** Five minutes: the pause between two screens of one flow. */
  const CHALLENGE_TTL_MINUTES = 5;

  async function createMfaChallenge(
    userId: number,
    tokenHash: string,
    purpose: string
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + CHALLENGE_TTL_MINUTES * 60 * 1000
    ).toISOString();
    // Clearing first keeps one live challenge per user, so a stale one from an
    // abandoned attempt cannot be completed later.
    await db.batch([
      clearChallengesForUser.bind(userId),
      insertChallenge.bind(tokenHash, userId, now.toISOString(), expiresAt, purpose),
    ]);
  }

  async function findMfaChallenge(
    tokenHash: string,
    purpose: string
  ): Promise<{ userId: number } | null> {
    const row = await selectChallenge
      .bind(tokenHash, purpose, new Date().toISOString())
      .first<{ user_id: number }>();
    return row ? { userId: row.user_id } : null;
  }

  async function deleteMfaChallenge(tokenHash: string): Promise<void> {
    await deleteChallenge.bind(tokenHash).run();
  }

  /** Housekeeping — expired rows are already unusable, this reclaims space. */
  async function sweepMfaChallenges(): Promise<void> {
    await sweepChallengeRows.bind(new Date().toISOString()).run();
  }

  /**
   * Serialises guesses: the first claim pushes the lock ahead by `holdMs`, so a
   * simultaneous second guess finds it locked. The caller then records the
   * outcome, replacing the hold. Refused, it returns the wait for Retry-After.
   */
  async function claimSecondFactorAttempt(
    userId: number,
    factor: FirstFactor,
    holdMs: number
  ): Promise<{ claimed: true; failures: number } | { claimed: false; retryAfterMs: number }> {
    const now = Date.now();
    const row = await claimAttemptRow
      .bind(userId, factor, new Date(now + holdMs).toISOString(), new Date(now).toISOString())
      .first<{ failures: number }>();
    if (row) return { claimed: true, failures: row.failures };

    const lock = await selectAttemptLock.bind(userId, factor).first<{ locked_until: string }>();
    const until = lock ? Date.parse(lock.locked_until) : now;
    return { claimed: false, retryAfterMs: Math.max(0, until - now) };
  }

  /** Safe to compute the wait from the claim's count: the claim serialised attempts. */
  async function recordSecondFactorFailure(
    userId: number,
    factor: FirstFactor,
    waitMs: number
  ): Promise<void> {
    const lockedUntil = new Date(Date.now() + waitMs).toISOString();
    await recordAttemptFailureRow.bind(lockedUntil, userId, factor).run();
  }

  /** A right code: both counts go, whichever factor it came through. */
  async function clearSecondFactorAttempts(userId: number): Promise<void> {
    await clearAttemptRows.bind(userId).run();
  }

  /** Housekeeping — expired tokens are already unusable, this reclaims space. */
  async function sweepPasswordResets(): Promise<void> {
    await sweepResetRows.bind(new Date().toISOString()).run();
  }

  /**
   * The students row must go first. `students.user_id` has no ON DELETE
   * CASCADE (SQLite can't add one to an existing column), so deleting the user
   * first fails on the foreign key. Everything else cascades from these two.
   *
   * `rate_limits` rows are deliberately kept: they hold only hashes, expire on
   * their own, and deleting them would make delete-and-recreate a limit reset.
   */
  async function deleteAccount(userId: number): Promise<{ hadProfile: boolean }> {
    // One batch, so D1 rolls back both statements together.
    const results = await db.batch([
      deleteStudentsOfUser.bind(userId),
      deleteUserRow.bind(userId),
    ]);
    return { hadProfile: (results[0]?.meta?.changes ?? 0) > 0 };
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
    createPendingSignup,
    findPendingSignup,
    completeSignup,
    sweepPendingSignups,
    createSession,
    getSession,
    deleteSession,
    sweepSessions,
    deleteAccount,
    createPasswordReset,
    findPasswordReset,
    resetPassword,
    rehashPassword,
    sweepPasswordResets,
    getTotpState,
    stageTotpSecret,
    replaceTotpSecret,
    enableTotp,
    disableTotp,
    consumeTotpStep,
    consumeRecoveryCode,
    countRecoveryCodesLeft,
    replaceRecoveryCodes,
    createMfaChallenge,
    findMfaChallenge,
    deleteMfaChallenge,
    sweepMfaChallenges,
    claimSecondFactorAttempt,
    recordSecondFactorFailure,
    clearSecondFactorAttempts,
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
    getShareLink,
    findShareLink,
    ensureShareLink,
    rotateShareLink,
    revokeShareLink,
  };
}
