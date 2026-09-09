-- Password reset tokens (Phase 8).
--
-- WHY THE TOKEN IS STORED AS A HASH
--
-- A reset token is a bearer credential: whoever holds it can take over the
-- account it names, without knowing the password. Storing it in plaintext
-- means a single SELECT on this table — a read-only SQL injection, a leaked
-- backup, a support tool with too much reach — hands over every account with a
-- pending reset. Storing the hash means the same read yields nothing usable,
-- because the mailed value cannot be recovered from it.
--
-- WHY SHA-256 AND NOT PBKDF2, unlike users.password_hash
--
-- These two columns look alike and are protecting against opposite things. A
-- password is low-entropy and human-chosen, so the only defence against an
-- offline attack on a stolen hash is to make each guess expensive — that is
-- what PBKDF2's 100k iterations buy. A reset token is 256 bits from a CSPRNG:
-- there is no dictionary, no reuse across sites, and no feasible brute force
-- to slow down. Iterating here would add latency to every verification while
-- defending against an attack that cannot happen. A single fast hash is the
-- correct primitive for a high-entropy secret.
--
-- WHY THERE IS NO ROW FOR THE EMAIL ADDRESS
--
-- The user_id is enough, and adding the address would put a second copy of it
-- somewhere that has to be deleted in step with the first.

CREATE TABLE IF NOT EXISTS password_resets (
  -- SHA-256 of the token, hex. Primary key because a lookup is always by the
  -- token the caller presents, and because two colliding tokens must be
  -- impossible rather than merely unlikely.
  token_hash TEXT PRIMARY KEY,
  -- CASCADE so deleting an account takes its pending resets with it. Without
  -- this, DELETE /api/auth/account would fail on a constraint violation for
  -- anyone who had requested a reset — the same trap students.user_id sets,
  -- and the reason this one says so explicitly.
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  -- Set the moment a token is spent. The row is kept rather than deleted so a
  -- second use can be told apart from a token that never existed — the first
  -- is worth logging as a possible replay, the second is a typo.
  used_at    TEXT
);

-- Supports "invalidate this user's other pending resets", which runs whenever
-- a new one is issued and again when one is spent.
CREATE INDEX IF NOT EXISTS password_resets_by_user ON password_resets(user_id);

-- Supports the opportunistic sweep of expired rows, same pattern as sessions.
CREATE INDEX IF NOT EXISTS password_resets_by_expiry ON password_resets(expires_at);
