// Types for the exported transforms of import-scorecard.mjs.
//
// The importer stays plain JavaScript: it is a build-time CLI that runs under
// bare `node` with no build step, and adding one so a script can be TypeScript
// would be the only compile step in the repo that Wrangler does not already do.
// Its pure functions are unit-tested from TypeScript though, so they need
// declarations — tsc resolves a .mjs module through the sibling .d.mts.

/** Interpolates a GPA from an SAT average over GPA_ANCHORS; clamps at both ends. */
export function estimateGpa(sat: number): number;

/** Anchor points [SAT, GPA] the estimate interpolates between. */
export const GPA_ANCHORS: readonly (readonly [number, number])[];

/** GPA from an admission rate (percent), for test-blind schools with no SAT. */
export function estimateGpaFromAdmitRate(admitPercent: number): number;

/** Anchor points [admit rate %, GPA], calibrated on the SAT-derived population. */
export const ADMIT_GPA_ANCHORS: readonly (readonly [number, number])[];

/**
 * Majors above `threshold` share of degrees awarded, highest share first and
 * capped at `cap`. `readColumn` returns a raw CSV cell by column name.
 */
export function majorsFor(
  readColumn: (column: string) => string | undefined,
  threshold: number,
  cap: number
): string[];

/** A display abbreviation; falls back to the full name rather than truncating. */
export function shortNameFor(name: string): string;

/** IPEDS locale code → Urban | Suburban | College Town | Rural. */
export function settingFor(locale: string | number): string;

/** ADMCON7 → the admission-test policy, or null when unreported. */
export function testPolicyFor(
  admcon7: string | number
): "required" | "recommended" | "not-used" | "optional" | null;

/** Strips the campus suffix IPEDS appends to a flagship's name. */
export function cleanName(instnm: string): string;

/** Number, or null for the several spellings of "missing" Scorecard uses. */
export function numberOrNull(value: unknown): number | null;

/** RFC 4180 reader; yields one array of fields per row. */
export function parseCsv(text: string): Generator<string[]>;

/** State code → Census region. */
export const CENSUS_REGION: Record<string, string>;

/** Hand-verified shortName → IPEDS UNITID for the curated schools. */
export const CURATED_UNITIDS: Record<string, number>;
