// The facts the legal pages state about who runs Compass and how to reach them.
//
// WHY THESE ARE IN ONE MODULE RATHER THAN IN THE PAGES
//
// Four pages assert the same handful of things — who operates this, which
// law governs it, where a security report goes, when the documents last
// changed. Written inline they would be four copies that drift, and the
// failure mode is specific and bad: a Terms page saying one jurisdiction and
// a Privacy page saying another is worse than either page not existing,
// because it reads as boilerplate that nobody checked.
//
// WHY SOME OF THESE ARE PLACEHOLDERS
//
// Compass has never been deployed — index.html still points at
// compass.example.com — so the operator's legal name and governing state are
// genuinely not known yet. The choice was between inventing them, omitting
// the clauses, or marking them. Inventing is the one option that ships a
// false statement in a legal document, and omitting a governing-law clause
// leaves the whole agreement ambiguous. So they are marked, loudly: every
// unfilled value renders in the page with a highlight (see `<Unfilled>` in
// components/legal/LegalPage.tsx) so it cannot be missed in review, and
// `legal.test.ts` enumerates them so a deploy checklist has one list to read.
//
// FILL IN BEFORE THE FIRST PUBLIC DEPLOY — and see PLACEHOLDERS below.

/** A value that has to be replaced before these pages are true. */
const TODO = (what: string) => `[${what}]` as const;

/**
 * Who operates Compass.
 *
 * The user's answer on 2026-09-07: a personal, non-commercial project rather
 * than a company. That is not a hedge, it is the fact that makes the rest of
 * the Terms honest — a free tool run by one person has different obligations
 * and different promises than a funded service, and saying so plainly is what
 * lets the disclaimer sections be short instead of defensive.
 */
export const OPERATOR_NAME = TODO("YOUR FULL NAME");

/**
 * The state or country whose law governs the Terms, and whose courts hear a
 * dispute. Conventionally where the operator lives.
 */
export const GOVERNING_LAW = TODO("YOUR STATE, COUNTRY");

/**
 * A contact address for privacy questions, data requests, and legal notice.
 *
 * Deliberately separate from the security channel below. A privacy request is
 * from a student or a parent and should reach a human inbox; a vulnerability
 * report is from a researcher and belongs somewhere with a disclosure
 * workflow attached. Collapsing them puts "please delete my data" in the same
 * queue as an exploit chain.
 */
export const CONTACT_EMAIL = TODO("YOUR CONTACT EMAIL");

/** The public repository. Compass is open source, which the pages lean on. */
export const REPO_URL = "https://github.com/kandakatla-ram/AI-Admissions-Advisor";

/**
 * Where a vulnerability report goes.
 *
 * GitHub's private vulnerability reporting rather than an email address, on
 * the user's behalf (they had no preference on 2026-09-07). Three reasons it
 * is the better default for a project at this stage: there is no inbox to
 * publish and therefore none to harvest; the report arrives with a disclosure
 * workflow, a CVE path and a private fork already attached; and — most
 * practically — it cannot go stale the way a personal address does. A
 * disclosure page pointing at a dead mailbox is worse than no page, because
 * it converts a researcher who wanted to help into one who thinks they were
 * ignored.
 *
 * Requires "Private vulnerability reporting" to be switched on in the repo:
 * Settings -> Code security and analysis. Off by default; the security.txt in
 * frontend/public/.well-known says the same thing.
 */
export const SECURITY_ADVISORY_URL = `${REPO_URL}/security/advisories/new`;

/**
 * When the legal documents last changed, ISO-8601.
 *
 * One date across all four rather than one each. They were written together
 * and describe one system; per-page dates would imply an independence they do
 * not have, and would leave a reader wondering what changed in Privacy that
 * did not change in Cookies. Bump this whenever any of them is edited in a
 * way that changes what it means — not for a typo.
 */
export const LEGAL_UPDATED = "2026-09-07";

/**
 * The date these terms take effect. Same as the last update for now, and kept
 * as its own constant because the two diverge the first time a material change
 * ships with notice ahead of it.
 */
export const LEGAL_EFFECTIVE = LEGAL_UPDATED;

/**
 * True for a value nobody has filled in yet.
 *
 * The bracket convention is doing real work: it is the marker `<Unfilled>`
 * keys off to highlight the value in the rendered page, and the thing
 * legal.test.ts asserts on. A placeholder that looked like ordinary prose
 * would ship silently, which is the entire failure this guards against.
 */
export function isUnfilled(value: string): boolean {
  return value.startsWith("[") && value.endsWith("]");
}

/**
 * Every operator-specific value, for the deploy checklist and for the test
 * that keeps this list honest.
 */
export const PLACEHOLDERS = {
  OPERATOR_NAME,
  GOVERNING_LAW,
  CONTACT_EMAIL,
} as const;

/**
 * "2026-09-07" -> "September 7, 2026".
 *
 * Parsed as a local date rather than through `new Date(iso)`, which reads a
 * bare date as UTC midnight and so renders as the previous day anywhere west
 * of Greenwich — the same bug dates.ts exists to fix, and a legal document
 * quietly dated one day early is exactly the kind of small wrongness these
 * pages cannot afford.
 */
export function formatLegalDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(
    new Date(y, m - 1, d)
  );
}
