// Operator facts shared by the four legal pages, kept in one place so the
// pages can't contradict each other.
//
// Bracketed values are unfilled placeholders. <Unfilled> highlights them on the
// page and legal.test.ts lists them. Fill them in before the first public deploy.

const TODO = (what: string) => `[${what}]` as const;

/** A personal, non-commercial project, which is why the disclaimers can be short. */
export const OPERATOR_NAME = TODO("YOUR FULL NAME");

export const GOVERNING_LAW = TODO("YOUR STATE, COUNTRY");

/** Privacy and legal contact. Kept separate from security reports on purpose. */
export const CONTACT_EMAIL = TODO("YOUR CONTACT EMAIL");

export const REPO_URL = "https://github.com/Ram-Kandakatla/AI-Admissions-Advisor";

/**
 * GitHub private vulnerability reporting: no inbox to harvest or let go stale.
 * Must be switched on in the repo settings; security.txt points here too.
 */
export const SECURITY_ADVISORY_URL = `${REPO_URL}/security/advisories/new`;

/** One date for all four documents. Bump it for changes in meaning, not typos. */
export const LEGAL_UPDATED = "2026-09-07";

/** Separate from LEGAL_UPDATED so a change can be announced before it takes effect. */
export const LEGAL_EFFECTIVE = LEGAL_UPDATED;

/** The bracket convention is what <Unfilled> and legal.test.ts detect. */
export function isUnfilled(value: string): boolean {
  return value.startsWith("[") && value.endsWith("]");
}

export const PLACEHOLDERS = {
  OPERATOR_NAME,
  GOVERNING_LAW,
  CONTACT_EMAIL,
} as const;

/** Parsed as a local date: `new Date(iso)` would show the previous day west of UTC. */
export function formatLegalDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(
    new Date(y, m - 1, d)
  );
}
