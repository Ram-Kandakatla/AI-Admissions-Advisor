-- Wrong two-factor codes, counted per account.
--
-- WHY PER ACCOUNT
--
-- Every route that checks a second-factor code was already rate limited, but
-- only per network: 15 attempts per 15 minutes per address, in rate_limits.
-- That stops one machine, not someone with many. A code is accepted across a
-- ±1 step window, so each guess is right about three times in a million, and
-- through the reset route — where one request is one guess — a thousand
-- addresses make 60,000 guesses an hour: a coin flip in about four hours. The
-- people in a position to try already hold the inbox or the password, and they
-- are exactly who a second factor exists to stop. So the count that bounds
-- them has to follow the account.
--
-- WHY TWO COUNTS PER ACCOUNT
--
-- One per first factor, named for what got the caller to the code prompt:
-- 'password' for signing in and the two-factor settings, 'reset' for an
-- emailed reset link. With a single count, someone holding only the password
-- could keep the account locked, reset flow included — shutting the owner out
-- of the one way to take the password back. With two, the owner can always
-- recover through the factor the other person lacks, and a right code there
-- clears both. Only someone with the password *and* the inbox can lock both,
-- and by then the second factor is the last thing standing.
--
-- WHY NOT rate_limits
--
-- Its fixed windows cannot count *consecutive* failures, a right code cannot
-- reset them, and they cannot stop two guesses being checked at once. The last
-- is what locked_until is for: each attempt first claims its row with an upsert
-- that succeeds only when the account is not locked, and that pushes the lock a
-- few seconds ahead while its one code is checked — so a guess sent alongside
-- it finds the account locked. See claimSecondFactorAttempt in
-- src/store/dataStore.ts.

CREATE TABLE IF NOT EXISTS mfa_attempts (
  -- CASCADE, so deleting the account takes its counts with it. Unlike
  -- rate_limits, nothing is protected by keeping them: a count guards one
  -- account's secret, and that goes too.
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'password' or 'reset': the first factor that reached the code prompt.
  factor       TEXT    NOT NULL,
  -- Wrong codes since the last right one.
  failures     INTEGER NOT NULL DEFAULT 0,
  -- ISO-8601 UTC. No code is checked for this account and factor before it.
  locked_until TEXT    NOT NULL,
  PRIMARY KEY (user_id, factor)
);

-- No other index. Every read is by (user_id, factor), and the clear is by
-- user_id, the primary key's leading column.
