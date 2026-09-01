-- Compass initial schema.
--
-- Carried over from the node:sqlite CREATE TABLE block in the old
-- backend/store/db.js. D1 speaks the same SQL dialect, so the table
-- definitions are unchanged. Three things from that file are deliberately
-- absent:
--
--   PRAGMA journal_mode = WAL  — D1 manages its own storage; not ours to set.
--   PRAGMA foreign_keys = ON   — already on in D1, unlike bare SQLite.
--   The school_notes backfill   — that was a one-time copy of application
--     notes written before school_notes existed. A fresh D1 database has no
--     such rows, so running it here would be a no-op against empty tables.

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
