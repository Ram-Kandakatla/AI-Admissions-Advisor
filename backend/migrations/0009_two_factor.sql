-- Two-factor authentication (Phase 8).
--
-- TOTP only. Not SMS, which is defeated by a SIM swap and costs money per
-- message; not email codes, which would be theatre here — email is already the
-- password-reset path, so a second factor delivered to the same inbox protects
-- against nothing that matters. An authenticator app is free, works offline,
-- and is the thing students already have.

-- The shared secret, base32. NULL means never enrolled.
--
-- WHY IT IS NOT ENCRYPTED AT REST, STATED PLAINLY
--
-- A TOTP secret is equivalent to the second factor: whoever reads this column
-- can generate codes. Encrypting it with a key from the environment is the
-- obvious hardening and was considered and rejected, because the key would
-- live in the same Cloudflare account as this database — an attacker holding
-- D1 data almost certainly holds the Worker secrets too, so it defends only
-- the narrow case of a leaked backup with no account access. Against that it
-- adds a failure mode with much worse blast radius: lose or rotate the key and
-- every enrolled user is locked out of their own account at once, with no
-- support desk here to fix it. The trade is recorded on the Security page as a
-- known limitation rather than hidden.
ALTER TABLE users ADD COLUMN totp_secret TEXT;

-- NULL until a first code is verified. This is what separates "a secret has
-- been generated and shown on screen" from "the user has proved their app is
-- working" — enrollment that flipped 2FA on before that check would lock out
-- anyone who mistyped the setup key, which is the single most likely way to
-- get this wrong.
ALTER TABLE users ADD COLUMN totp_enabled_at TEXT;

-- The last time-step this account successfully used.
--
-- Replay prevention, and the reason verifyTotp returns a step rather than a
-- boolean. A code is valid across a ±1 step window, so without this a code
-- read off someone's screen stays usable for up to 90 seconds — which is
-- exactly the shoulder-surfing case a second factor is supposed to cover.
-- Refusing any step at or below the last one spent closes it.
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;

-- The way back in when the phone is lost.
--
-- Load-bearing rather than a nicety: password reset does NOT bypass 2FA in
-- this app (a reset that skipped the second factor would leave 2FA protecting
-- only against a stolen password, not a compromised inbox — and the inbox is
-- the threat). That decision is only humane because these exist, so they are
-- issued at enrollment and shown exactly once.
--
-- Hashed for the same reason reset tokens are, and with the same fast hash for
-- the same reason: 60 bits from a CSPRNG has no dictionary to attack, so
-- PBKDF2 would add latency without adding security.
CREATE TABLE IF NOT EXISTS recovery_codes (
  code_hash  TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  -- Kept rather than deleted when spent, so the account page can say "3 of 10
  -- remaining" — a number that is only meaningful if used ones are still
  -- counted. Cleared wholesale when a new batch is issued.
  used_at    TEXT
);

CREATE INDEX IF NOT EXISTS recovery_codes_by_user ON recovery_codes(user_id);

-- The gap between "password accepted" and "second factor accepted".
--
-- Login can no longer mint a session in one step, so something has to carry
-- the fact that the password was already verified. That something must not be
-- the session cookie — a half-authenticated session is a session, and every
-- ownership check in the app would have to learn about a state that does not
-- exist today. A separate short-lived row keeps the session table meaning
-- exactly one thing: fully authenticated.
--
-- Five minutes, because this is the pause between two screens of one flow, not
-- something anyone should be able to come back to.
CREATE TABLE IF NOT EXISTS mfa_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- What the caller is part-way through, so a challenge minted by a login
  -- cannot be redeemed against the password-reset route or the other way
  -- round. Confusing the two would let a reset link plus an old challenge
  -- combine into something neither flow intended.
  purpose    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mfa_challenges_by_expiry ON mfa_challenges(expires_at);
