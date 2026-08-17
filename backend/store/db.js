// SQLite connection + schema for Compass.
//
// Uses `node:sqlite`, which ships with Node itself — no new dependency, and no
// server to run before `npm start` works. The API surface is synchronous, so
// swapping the in-memory Maps for real rows did not turn a single call site
// into a promise.
//
// Where the file lives:
//   COMPASS_DB env var, if set (":memory:" is honoured)
//   otherwise backend/data/compass.db  — gitignored; universities.json, which
//   is reference data rather than user data, stays a plain JSON file.
// Under Jest each test file gets its own private in-memory database, so the
// suites stay independent of each other and of whatever is on disk.

const path = require("path");
const { DatabaseSync } = require("node:sqlite");

function resolveLocation() {
  if (process.env.COMPASS_DB) return process.env.COMPASS_DB;
  if (process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID) return ":memory:";
  return path.join(__dirname, "..", "data", "compass.db");
}

const db = new DatabaseSync(resolveLocation());

// WAL keeps reads from blocking on a write; a no-op for :memory:.
db.exec("PRAGMA journal_mode = WAL");
// Off by default in SQLite, and the applications/messages tables lean on it to
// clean up after a deleted student.
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    gpa               REAL NOT NULL,
    sat_score         REAL,
    act_score         REAL,
    interested_majors TEXT NOT NULL DEFAULT '[]',
    extracurriculars  TEXT NOT NULL DEFAULT '[]',
    career_goals      TEXT NOT NULL DEFAULT '',
    financial_need    TEXT NOT NULL DEFAULT 'medium',
    preferred_regions TEXT NOT NULL DEFAULT '[]',
    created_at        TEXT NOT NULL,
    updated_at        TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    at         TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS messages_by_student ON messages(student_id, seq);

  CREATE TABLE IF NOT EXISTS applications (
    id                   TEXT PRIMARY KEY,
    student_id           TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    university_id        INTEGER NOT NULL,
    plan                 TEXT NOT NULL,
    status               TEXT NOT NULL,
    deadline             TEXT,
    deadline_is_typical  INTEGER NOT NULL DEFAULT 0,
    checklist            TEXT NOT NULL DEFAULT '{}',
    notes                TEXT NOT NULL DEFAULT '',
    created_at           TEXT NOT NULL,
    updated_at           TEXT,
    -- The "one application per school" rule the tracker enforces, stated where
    -- it cannot be bypassed by a second process or a future code path.
    UNIQUE (student_id, university_id)
  );

  CREATE INDEX IF NOT EXISTS applications_by_student ON applications(student_id);

  -- One note per student per school, shared by every page that shows it. The
  -- primary key is the pair, which is what makes "one school, one notepad"
  -- true in the data rather than only in the UI.
  CREATE TABLE IF NOT EXISTS school_notes (
    student_id    TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    university_id INTEGER NOT NULL,
    starred       INTEGER NOT NULL DEFAULT 0,
    note          TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    updated_at    TEXT,
    PRIMARY KEY (student_id, university_id)
  );
`);

// One-time backfill: before school notes existed, the only place to write
// about a school was the tracker's own notes field. Those notes are the same
// kind of thing, so they are copied across rather than stranded. The
// applications.notes column stays exactly where it was — nothing is deleted,
// and re-running this is a no-op because the pair is already present.
db.exec(`
  INSERT INTO school_notes (student_id, university_id, starred, note, created_at)
  SELECT a.student_id, a.university_id, 0, a.notes, a.created_at
    FROM applications a
   WHERE TRIM(a.notes) <> ''
     AND NOT EXISTS (
       SELECT 1 FROM school_notes n
        WHERE n.student_id = a.student_id AND n.university_id = a.university_id
     )
`);

// --- JSON column helpers -------------------------------------------------
// Arrays and the checklist object are stored as JSON text. A row written by an
// older build (or hand-edited) shouldn't crash a request, so parsing failures
// fall back to the empty value rather than throwing.

function toJson(value) {
  return JSON.stringify(value ?? null);
}

function fromJson(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

module.exports = { db, toJson, fromJson, resolveLocation };
