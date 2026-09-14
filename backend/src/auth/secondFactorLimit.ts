// How long a wrong two-factor code makes the next one wait.
//
// Pure functions with no I/O, like totp.ts, so the schedule can be tested by
// itself. Why the limit exists, and why it is counted per account and per first
// factor, is in migrations/0011_mfa_attempts.sql.
//
// WHY A DOUBLING WAIT, AND NOT A WINDOW
//
// Five wrong codes are free, which covers typos. After that each further code
// waits a minute, then two, then four, up to a day. That allows 15 guesses in
// the first day and about 380 in a year — roughly a 1-in-900 chance of hitting
// a code in a year, per count. A fixed window that sounds strict, 10 an hour,
// allows 87,600 guesses a year: about 23%.

/**
 * The first factor that got a caller to the code prompt, which picks the count
 * an attempt is charged to: `password` for signing in and the two-factor
 * settings, `reset` for an emailed reset link.
 */
export type FirstFactor = "password" | "reset";

/** Wrong codes allowed before any wait: enough for typos. */
export const FREE_FAILURES = 5;
const FIRST_WAIT_MS = 60_000;
const LONGEST_WAIT_MS = 24 * 60 * 60_000;

/**
 * How long a claim holds the account while one code is checked.
 *
 * Far longer than three HMACs and a couple of D1 writes take, and short enough
 * that if the Worker dies mid-check the hold runs out by itself — the attempt
 * is simply not counted, and nobody waits long on it.
 */
export const CLAIM_HOLD_MS = 5_000;

/** The wait after `failures` consecutive wrong codes. */
export function waitAfter(failures: number): number {
  if (failures < FREE_FAILURES) return 0;
  return Math.min(FIRST_WAIT_MS * 2 ** (failures - FREE_FAILURES), LONGEST_WAIT_MS);
}

/**
 * "a few seconds", "12 minutes", "an hour", for the refusal message.
 *
 * Rounded up, so the message never tells someone to come back before the lock
 * has lifted.
 */
export function describeWait(ms: number): string {
  if (ms <= 10_000) return "a few seconds";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return minutes === 1 ? "a minute" : `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}
