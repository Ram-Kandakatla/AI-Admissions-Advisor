-- Sign-ups waiting on their confirmation link.
--
-- WHY SIGNUP NO LONGER CREATES THE ACCOUNT STRAIGHT AWAY
--
-- It used to, and that made POST /api/auth/signup a membership oracle: a new
-- address answered 201 and an address with an account answered 409, so a list
-- of ten thousand addresses could be sorted into "has a Compass account" and
-- "does not" — for an app used mostly by teenagers. /auth/forgot already
-- refuses to be that oracle; signup was the way round it.
--
-- The only response that can be identical for both cases is "check your
-- inbox", which means the account cannot exist yet when the response is sent.
-- So a request lands here, and the account is created when the emailed link is
-- opened. An address that already has an account is sent a note saying so, and
-- never gets a row in this table.
--
-- WHY THE PASSWORD HASH WAITS HERE
--
-- The person chose it on the signup form, and it is the same PBKDF2 form as
-- users.password_hash. It is also what the confirmation page checks when the
-- link is opened anywhere but the browser that asked — see guest_user_id.
--
-- WHY THE TOKEN IS A HASH
--
-- The same reasoning, and the same primitive, as password_resets.token_hash.

CREATE TABLE IF NOT EXISTS pending_signups (
  -- SHA-256 of the emailed token, hex.
  token_hash    TEXT PRIMARY KEY,
  -- Normalised (trimmed, lower-cased) exactly as users.email is, so the check
  -- for an existing account compares like with like.
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  -- The account that asked: a guest row, minted by the signup request itself
  -- when the visitor had no session yet. It has two jobs.
  --
  -- It is the row the confirmed account claims, so a profile built as a guest
  -- is kept — signup stays a claim, not a create.
  --
  -- And it is how the confirmation step recognises the browser that asked,
  -- which is what stops account pre-hijacking. Anyone can request a signup for
  -- someone else's address. If that person then opened the link and was signed
  -- straight in, they would be building a college list inside an account whose
  -- password the requester chose. So the link completes on its own only for the
  -- session that owns this row, and anywhere else it asks for the password
  -- chosen at signup, which the owner of the inbox does not have.
  --
  -- CASCADE, so deleting the guest account takes its pending signup with it:
  -- the address typed into the form is personal data, and erasure means all of
  -- it.
  guest_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

-- Supports clearing every pending signup for an address once one is confirmed.
CREATE INDEX IF NOT EXISTS pending_signups_by_email ON pending_signups(email);

-- Supports clearing a guest's other pending signups at the same moment, so one
-- guest profile becomes one account and not two.
CREATE INDEX IF NOT EXISTS pending_signups_by_guest ON pending_signups(guest_user_id);

-- Supports the opportunistic sweep of expired rows, same pattern as sessions.
CREATE INDEX IF NOT EXISTS pending_signups_by_expiry ON pending_signups(expires_at);
