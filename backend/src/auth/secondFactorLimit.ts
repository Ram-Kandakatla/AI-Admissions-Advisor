// How long a wrong two-factor code makes the next one wait. A doubling wait
// (1 min → 24 h after five free tries) allows ~380 guesses a year; a fixed
// "10 an hour" window would allow 87,600.

/** Which count an attempt is charged to. Only `password` since reset was removed. */
export type FirstFactor = "password";

export const FREE_FAILURES = 5;
const FIRST_WAIT_MS = 60_000;
const LONGEST_WAIT_MS = 24 * 60 * 60_000;

/** Short enough that a claim left by a crashed Worker expires on its own. */
export const CLAIM_HOLD_MS = 5_000;

export function waitAfter(failures: number): number {
  if (failures < FREE_FAILURES) return 0;
  return Math.min(FIRST_WAIT_MS * 2 ** (failures - FREE_FAILURES), LONGEST_WAIT_MS);
}

/** Rounds up, so it never says to come back before the lock lifts. */
export function describeWait(ms: number): string {
  if (ms <= 10_000) return "a few seconds";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return minutes === 1 ? "a minute" : `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}
