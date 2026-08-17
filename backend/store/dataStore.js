// Data store for Compass — SQLite (see ./db.js) for everything the student
// creates, plain JSON for the university reference data.
//
// Profiles, chat history and tracked applications now survive a restart. The
// function signatures are unchanged from the in-memory version, and still
// synchronous, so callers were not touched: `getStudent(id)` returns the record
// or null exactly as before.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { db, toJson, fromJson } = require("./db");

const UNIVERSITIES_PATH = path.join(__dirname, "..", "data", "universities.json");
const SCHOLARSHIPS_PATH = path.join(__dirname, "..", "data", "scholarships.json");

let universitiesCache = null;
let scholarshipsCache = null;

function loadUniversities() {
  if (!universitiesCache) {
    const raw = fs.readFileSync(UNIVERSITIES_PATH, "utf-8");
    universitiesCache = JSON.parse(raw);
  }
  return universitiesCache;
}

// The scholarship file wraps its array in an object so it can carry the note
// about where the data came from — JSON has nowhere else to put a comment.
function loadScholarships() {
  if (!scholarshipsCache) {
    const raw = fs.readFileSync(SCHOLARSHIPS_PATH, "utf-8");
    scholarshipsCache = JSON.parse(raw).scholarships;
  }
  return scholarshipsCache;
}

// SQLite has no boolean type; store 1/0 and read it back as a real boolean so
// the JSON the API emits keeps the shape the client already expects.
const bool = (v) => (v ? 1 : 0);

// ---- Students ----

function studentFromRow(row) {
  if (!row) return null;
  const record = {
    id: row.id,
    name: row.name,
    gpa: row.gpa,
    satScore: row.sat_score,
    actScore: row.act_score,
    interestedMajors: fromJson(row.interested_majors, []),
    extracurriculars: fromJson(row.extracurriculars, []),
    careerGoals: row.career_goals,
    financialNeed: row.financial_need,
    preferredRegions: fromJson(row.preferred_regions, []),
    createdAt: row.created_at,
  };
  // Absent until the profile is actually edited, as it was in memory.
  if (row.updated_at) record.updatedAt = row.updated_at;
  return record;
}

const insertStudent = db.prepare(`
  INSERT INTO students (
    id, name, gpa, sat_score, act_score, interested_majors, extracurriculars,
    career_goals, financial_need, preferred_regions, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectStudent = db.prepare("SELECT * FROM students WHERE id = ?");

const updateStudentRow = db.prepare(`
  UPDATE students SET
    name = ?, gpa = ?, sat_score = ?, act_score = ?, interested_majors = ?,
    extracurriculars = ?, career_goals = ?, financial_need = ?,
    preferred_regions = ?, updated_at = ?
  WHERE id = ?
`);

function createStudent(profile) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  insertStudent.run(
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
    createdAt
  );
  return studentFromRow(selectStudent.get(id));
}

function getStudent(id) {
  if (typeof id !== "string") return null;
  return studentFromRow(selectStudent.get(id));
}

function updateStudent(id, profile) {
  const existing = getStudent(id);
  if (!existing) return null;
  // Merge rather than replace: a caller sending a partial profile keeps the
  // fields it left out, which is what the in-memory spread did.
  const next = { ...existing, ...profile };
  updateStudentRow.run(
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
  );
  return getStudent(id);
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

function getConversation(studentId) {
  if (typeof studentId !== "string") return [];
  return selectMessages.all(studentId);
}

function appendMessage(studentId, role, content) {
  insertMessage.run(studentId, role, content, new Date().toISOString());
  trimMessages.run(studentId, studentId);
  return getConversation(studentId);
}

// ---- Applications ----
//
// One list per student. A student can only track a given university once —
// picking a different decision plan for the same school is an edit, not a
// second application. That rule is a UNIQUE constraint in the schema now.

function applicationFromRow(row) {
  if (!row) return null;
  const record = {
    id: row.id,
    studentId: row.student_id,
    universityId: row.university_id,
    plan: row.plan,
    status: row.status,
    deadline: row.deadline,
    deadlineIsTypical: Boolean(row.deadline_is_typical),
    checklist: fromJson(row.checklist, {}),
    notes: row.notes,
    createdAt: row.created_at,
  };
  if (row.updated_at) record.updatedAt = row.updated_at;
  return record;
}

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
`);

const updateApplicationRow = db.prepare(`
  UPDATE applications SET
    university_id = ?, plan = ?, status = ?, deadline = ?,
    deadline_is_typical = ?, checklist = ?, notes = ?, updated_at = ?
  WHERE student_id = ? AND id = ?
`);

const deleteApplicationRow = db.prepare(
  "DELETE FROM applications WHERE student_id = ? AND id = ?"
);

function getApplications(studentId) {
  if (typeof studentId !== "string") return [];
  return selectApplications.all(studentId).map(applicationFromRow);
}

function findApplication(studentId, applicationId) {
  if (typeof studentId !== "string" || typeof applicationId !== "string") return null;
  return applicationFromRow(selectApplication.get(studentId, applicationId));
}

function hasApplicationFor(studentId, universityId) {
  return countApplicationFor.get(studentId, universityId).n > 0;
}

function createApplication(studentId, application) {
  const id = crypto.randomUUID();
  insertApplication.run(
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
  );
  return findApplication(studentId, id);
}

function updateApplication(studentId, applicationId, patch) {
  const existing = findApplication(studentId, applicationId);
  if (!existing) return null;
  // id, studentId and createdAt are not patchable — the merge order below is
  // what guarantees that, same as the in-memory version.
  const next = { ...existing, ...patch };
  updateApplicationRow.run(
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
  );
  return findApplication(studentId, applicationId);
}

function deleteApplication(studentId, applicationId) {
  if (typeof studentId !== "string" || typeof applicationId !== "string") return false;
  return deleteApplicationRow.run(studentId, applicationId).changes > 0;
}

module.exports = {
  loadUniversities,
  loadScholarships,
  createStudent,
  getStudent,
  updateStudent,
  getConversation,
  appendMessage,
  getApplications,
  findApplication,
  hasApplicationFor,
  createApplication,
  updateApplication,
  deleteApplication,
};
