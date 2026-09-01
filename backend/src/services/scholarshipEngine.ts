// Rule-based scholarship matcher — the money side of the recommendation engine.
//
// Deliberately parallel to services/recommendationEngine.js: the same base
// score, the same "hard requirement filters it out entirely" shape, the same
// reach / target / safety vocabulary, so a student reading both pages is
// reading one idea twice rather than two.
//
// Two things it does NOT do, on purpose:
//
//   1. It never claims a student meets a demographic or membership condition.
//      Compass does not ask for race, gender, sexuality, tribal enrollment or
//      club membership, and it is not going to start asking in order to sort a
//      list. Awards carrying those conditions are shown with the condition
//      stated as something for the student to confirm, and they are capped at
//      "target" — the engine will never call an award a safety on the strength
//      of a fact it does not have.
//
//   2. It never asserts a deadline date. Scholarship deadlines move every
//      cycle, so the data carries the month a program typically closes plus the
//      sponsor's own URL, and the client labels it as unconfirmed — the same
//      rule models/application.js follows for college deadlines.

import { loadScholarships } from "../store/staticData.js";
import { currentCycleYear } from "../models/application.js";
import type { Scholarship, StudentRecord, Tier, Tiered } from "../types.js";

/** The deadline shape the client renders — a month and a year, never a date. */
export interface DeadlineWindow {
  month: number | null;
  year: number | null;
  label: string;
  sortKey: string;
  isTypical: boolean;
  note: string;
}

/** A scholarship plus everything the engine worked out about it for one student. */
export interface ScholarshipMatch extends Scholarship {
  tier: Tier;
  matchScore: number;
  matchedMajors: string[];
  gpaHeadroom: number | null;
  /** Ceiling of the award, for sorting ties. Uncapped awards sort at the top. */
  expectedValue: number;
  amountLabel: string;
  deadline: DeadlineWindow;
  eligibilityToConfirm: string[];
  reasons: string[];
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// How much a household at each need level can absorb before sticker price
// bites — reused from the university engine's thinking, applied to awards.
const NEED_WEIGHT: Record<string, number> = { high: 1, medium: 0.6, low: 0.25 };

export function recommendScholarships(
  student: StudentRecord,
  all: Scholarship[] = loadScholarships(),
  cycleYear: number = currentCycleYear()
): Tiered<ScholarshipMatch> {
  const scored = all
    .map((s) => evaluate(s, student, cycleYear))
    .filter((r): r is ScholarshipMatch => r !== null)
    .sort((a, b) => b.matchScore - a.matchScore || b.expectedValue - a.expectedValue);

  const tiers: Tiered<ScholarshipMatch> = { reach: [], target: [], safety: [] };
  for (const rec of scored) {
    tiers[rec.tier].push(rec);
  }
  return tiers;
}

/**
 * Score one scholarship against the student.
 * Returns null when the student is plainly ineligible — a stated GPA floor
 * they are under, a major restriction they don't meet, or a need-based award
 * when they've told us they have no financial need. Everything else is shown,
 * because a scholarship you don't apply for is a scholarship you don't win.
 */
export function evaluate(
  scholarship: Scholarship,
  student: StudentRecord,
  cycleYear: number = currentCycleYear()
): ScholarshipMatch | null {
  const majors = student.interestedMajors || [];

  // --- Hard eligibility gates ---

  if (scholarship.minGPA != null && student.gpa < scholarship.minGPA) return null;

  // A test floor only excludes when the student actually has a score to judge.
  // Test-optional students aren't disqualified by a number they never sent.
  if (scholarship.minSAT != null && student.satScore != null && student.satScore < scholarship.minSAT) {
    return null;
  }

  const matchedMajors = scholarship.forMajors.length
    ? majors.filter((m: string) => scholarship.forMajors.includes(m))
    : [];
  if (scholarship.forMajors.length && matchedMajors.length === 0) return null;

  if (scholarship.need === "required" && student.financialNeed === "low") return null;

  // --- Scoring ---

  const reasons = [];
  let score = 50;

  // Headroom over the stated academic floor. Distance above a bar is the
  // scholarship equivalent of the university engine's GPA gap, inverted:
  // there, above the average is comfort; here, above the minimum is merely
  // eligibility, so the credit is smaller.
  const gpaHeadroom = scholarship.minGPA == null ? null : round(student.gpa - scholarship.minGPA, 2);
  if (gpaHeadroom == null) {
    score += 6;
    reasons.push("No GPA cutoff — the application itself decides this one.");
  } else if (gpaHeadroom >= 0.5) {
    score += 16;
    reasons.push(`Clears the ${scholarship.minGPA} GPA floor with room to spare.`);
  } else if (gpaHeadroom >= 0.2) {
    score += 10;
    reasons.push(`Comfortably over the ${scholarship.minGPA} GPA minimum.`);
  } else {
    score += 4;
    reasons.push(`Just over the ${scholarship.minGPA} GPA minimum — every other part has to carry it.`);
  }

  // --- Financial need alignment ---
  const weight = NEED_WEIGHT[student.financialNeed] ?? 0.6;
  if (scholarship.need === "required") {
    score += Math.round(18 * weight);
    reasons.push("Need-based, and you've reported need — that narrows the field in your favour.");
  } else if (scholarship.need === "considered") {
    score += Math.round(8 * weight);
  } else if (student.financialNeed === "high") {
    // A merit award is still worth applying for, it just isn't tilted your way.
    score -= 2;
  }

  // --- Major fit ---
  if (matchedMajors.length > 0) {
    score += 12;
    reasons.push(
      matchedMajors.length > 1
        ? `Restricted to fields you're aiming at (${matchedMajors.join(", ")}).`
        : `Restricted to ${matchedMajors[0]} — your field, so most applicants are filtered out before you.`
    );
  }

  // --- Odds ---
  // Award count is the closest thing to an acceptance rate we have. It is a
  // blunt proxy — a 500-award program with 90,000 applicants is not generous —
  // so it moves the score, and the competitiveness field does the real tiering.
  const awards = scholarship.awardsPerYear ?? 0;
  if (scholarship.competitiveness === "entitlement") {
    score += 20;
    reasons.push("Not a contest — you qualify or you don't, and filing is the whole application.");
  } else if (awards >= 1000) {
    score += 10;
    reasons.push(`Around ${formatCount(awards)} awards a year — unusually good odds for a national program.`);
  } else if (awards >= 300) {
    score += 6;
  } else if (awards > 0 && awards < 50) {
    score -= 6;
    reasons.push(`Only about ${awards} awards a year.`);
  }

  // --- Effort ---
  // Effort is not a negative: it's a filter that thins the applicant pool. But
  // a short application is worth flagging, because it's the one a student with
  // four supplements left can actually finish this week.
  if (scholarship.effort === "short") {
    score += 8;
    reasons.push("Short application — no long essay to write.");
  } else if (scholarship.effort === "multi-stage") {
    score -= 3;
    reasons.push("Multi-stage — semifinalist rounds, so start it early.");
  }

  // --- Size of the award ---
  const value = awardCeiling(scholarship);
  if (scholarship.award.term === "full-ride" || scholarship.award.term === "full-need") {
    score += 12;
    reasons.push("Covers the full cost of attendance, not a slice of it.");
  } else if (scholarship.award.term === "full-tuition") {
    score += 10;
    reasons.push("Covers full tuition.");
  } else if (value >= 20000) {
    score += 8;
  } else if (value > 0 && value < 3000) {
    score -= 4;
  }

  if (scholarship.award.renewable) {
    reasons.push("Renewable — it pays again each year you stay eligible.");
  }

  // --- Conditions we cannot check ---
  // "low-income" is the one audience tag the profile does answer — the student
  // told us their financial need, and the hard gate above already acted on it.
  // Repeating it here would ask them to confirm something they just typed in.
  const eligibilityToConfirm = (scholarship.audience || [])
    .filter((key: string) => !VERIFIED_BY_PROFILE.has(key))
    .map(audienceLabel);
  if (eligibilityToConfirm.length) {
    reasons.push(`Open only to ${joinList(eligibilityToConfirm)} — confirm you qualify before investing the time.`);
  }

  const tier = classifyTier(scholarship, gpaHeadroom, eligibilityToConfirm.length > 0);

  return {
    ...scholarship,
    tier,
    matchScore: clamp(Math.round(score), 0, 100),
    matchedMajors,
    gpaHeadroom,
    /** Ceiling of the award, for sorting ties. Uncapped awards sort at the top. */
    expectedValue: value,
    amountLabel: amountLabel(scholarship),
    deadline: deadlineWindow(scholarship, cycleYear),
    eligibilityToConfirm,
    reasons,
  };
}

/**
 * Reach / target / safety.
 *
 * "Safety" here does not mean easy — it means an award where, on the facts we
 * actually hold, there is no reason you wouldn't be competitive. Anything
 * gated on a condition we can't verify stops at target no matter how broad it
 * is, and the elite national programs are a reach for everyone, by design.
 */
export function classifyTier(
  scholarship: Pick<Scholarship, "competitiveness">,
  gpaHeadroom: number | null,
  unverifiedCondition: boolean
): Tier {
  if (scholarship.competitiveness === "entitlement") return "safety";
  if (scholarship.competitiveness === "elite") return "reach";

  // Sitting on the floor of a stated minimum is a reach whatever the pool size.
  const thin = gpaHeadroom != null && gpaHeadroom < 0.2;

  if (scholarship.competitiveness === "high") return thin ? "reach" : "target";
  if (scholarship.competitiveness === "broad" && !thin) {
    return unverifiedCondition ? "target" : "safety";
  }
  return "target";
}

// --- Deadlines ---
//
// A month, a year, and the sponsor's own words about it — never a date this
// app invented. Months from August on belong to the autumn the cycle opens;
// January through July fall in the calendar year after it.
export function deadlineWindow(
  scholarship: Pick<Scholarship, "deadlineMonth" | "deadlineNote">,
  cycleYear: number
): DeadlineWindow {
  if (scholarship.deadlineMonth == null) {
    return { month: null, year: null, label: "Rolling / varies", sortKey: "9999-99", isTypical: true, note: scholarship.deadlineNote };
  }
  const month = scholarship.deadlineMonth;
  const year = month >= 8 ? cycleYear : cycleYear + 1;
  return {
    month,
    year,
    label: `${MONTHS[month - 1]} ${year}`,
    sortKey: `${year}-${String(month).padStart(2, "0")}`,
    isTypical: true,
    note: scholarship.deadlineNote,
  };
}

// --- Money ---

// A four-year sticker price at a private college, standing in for the awards
// whose value depends on where you enrol. A real number rather than Infinity
// so it survives JSON and sorts against the fixed sums without special cases.
const FULL_COST_PROXY = 300000;

function awardCeiling(scholarship: Pick<Scholarship, "award">): number {
  const { min, max, term } = scholarship.award;
  // Full-ride/full-need/full-tuition awards carry 0/0 in the data because the
  // number depends on the college; treat them as above every fixed sum.
  if (term === "full-ride" || term === "full-need") return FULL_COST_PROXY;
  if (term === "full-tuition") return FULL_COST_PROXY * 0.7;
  return max || min || 0;
}

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

export function amountLabel(scholarship: Pick<Scholarship, "award">): string {
  const { min, max, term } = scholarship.award;
  if (term === "full-ride") return "Full cost of attendance";
  if (term === "full-need") return "Full demonstrated need";
  if (term === "full-tuition") return "Full tuition";
  const range = min === max || !min ? usd(max || min) : `${usd(min)}–${usd(max)}`;
  if (term === "per-year") return `${range} per year`;
  return range;
}

const VERIFIED_BY_PROFILE = new Set(["low-income"]);

// Audience keys exist so the data stays machine-readable; these are the
// student-facing words for them.
const AUDIENCE_LABELS: Record<string, string> = {
  "minority-students": "students of colour",
  "black-students": "Black students",
  "hispanic-students": "Hispanic and Latino students",
  "asian-pacific-islander": "Asian and Pacific Islander American students",
  "native-american": "Native American and Alaska Native students",
  "first-generation": "first-generation college students",
  "low-income": "students with demonstrated financial need",
  "underrepresented-in-tech": "students underrepresented in technology",
  "women-in-stem": "women in engineering and computing",
  lgbtq: "LGBTQ students",
  adversity: "students who have overcome significant adversity",
  rural: "students at rural and small-town public high schools",
  athletes: "student athletes",
  "club-members": "active club members",
  "military-service": "students willing to take on a service commitment",
};

function audienceLabel(key: string): string {
  return AUDIENCE_LABELS[key] || key.replace(/-/g, " ");
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] || "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function formatCount(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)},000` : String(n);
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
