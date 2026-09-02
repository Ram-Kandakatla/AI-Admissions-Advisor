-- Accounts, sessions, and the ownership link (Phase 2).
--
-- WHY GUESTS GET A USER ROW
--
-- The product keeps its "no account required" front door: you can build a
-- profile and see matches before signing up. That leaves two kinds of owner —
-- a guest and a member — and the obvious schema gives them two different
-- ownership paths (session -> student for a guest, session -> user -> student
-- for a member). Two paths means every future ownership check has two ways to
-- be written and one way to be forgotten, which is exactly the regression the
-- implementation guide warns about.
--
-- So a guest gets a real `users` row with `email` and `password_hash` left
-- NULL. `students.user_id` is then the *only* ownership column, `requireOwner`
-- has one path, and signing up is a single UPDATE that fills in the two NULL
-- columns — the student row is never reparented, so there is no claim-time
-- data migration to get wrong.
--
-- A NULL email cannot be logged into: `WHERE email = ?` is never true for a
-- NULL, so an anonymous row is unreachable by every auth route by
-- construction rather than by a check someone has to remember.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  -- NULL until a guest signs up. SQLite permits many NULLs in a UNIQUE
  -- column, which is what lets every anonymous visitor share that state.
  email         TEXT UNIQUE,
  password_hash TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

-- Sessions are server-side so a logout is a real revocation (delete the row),
-- not a client politely forgetting a token it still holds. Every session has
-- a user — anonymous or not — which is what keeps the ownership path single.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
-- Supports the opportunistic sweep of expired rows.
CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires_at);

-- The link the whole phase exists to create. Nullable because rows written
-- before this migration have no owner: they are not deleted, but no session
-- can reach them either, which is the correct outcome for a profile nobody
-- can prove they wrote.
ALTER TABLE students ADD COLUMN user_id INTEGER REFERENCES users(id);

-- One profile per user, for now. Stated as an index because SQLite cannot add
-- a UNIQUE constraint to an existing table — same rule, enforced in the same
-- place. NULLs are exempt, so the pre-migration rows above coexist happily.
CREATE UNIQUE INDEX IF NOT EXISTS students_by_user ON students(user_id);
