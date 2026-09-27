// Rule-based matching into reach / target / safety, with a score and reasons.
// Kept simple and transparent on purpose, so the rules can be checked by hand.

import { clamp, round } from "../math.js";
import { loadUniversities } from "../store/staticData.js";
import type { StudentRecord, Tier, Tiered, University } from "../types.js";

/** A university plus everything the engine worked out about it for one student. */
export interface Recommendation extends University {
  tier: Tier;
  matchScore: number;
  matchedMajors: string[];
  gpaGap: number;
  affordable: boolean;
  regionFit: boolean;
  reasons: string[];
}

// Tuition thresholds used to judge financial fit by need level (USD/year sticker).
const AFFORDABLE_CEILING: Record<string, number> = { high: 35000, medium: 55000, low: Infinity };

export function recommendUniversities(
  student: StudentRecord,
  allUniversities: University[] = loadUniversities()
): Tiered<Recommendation> {
  const scored = allUniversities
    .map((uni) => evaluate(uni, student))
    .filter((r): r is Recommendation => r !== null)
    .sort((a, b) => b.matchScore - a.matchScore);

  const tiers: Tiered<Recommendation> = { reach: [], target: [], safety: [] };
  for (const rec of scored) {
    tiers[rec.tier].push(rec);
  }
  return tiers;
}

/** Null when the school offers none of the student's intended majors. */
export function evaluate(uni: University, student: StudentRecord): Recommendation | null {
  const majors = student.interestedMajors || [];
  const matchedMajors = majors.filter((m: string) => uni.majors.includes(m));
  if (matchedMajors.length === 0) return null;

  const reasons = [];
  let score = 50;

  // --- Academic proximity ---
  const gpaGap = round(uni.avgGPA - student.gpa, 2); // positive => school is a stretch
  if (gpaGap <= -0.1) {
    score += 18;
    reasons.push("Your GPA is above their typical admit.");
  } else if (gpaGap <= 0.1) {
    score += 12;
    reasons.push("Your GPA lines up with their typical admit.");
  } else if (gpaGap <= 0.25) {
    score += 4;
    reasons.push("A reach on GPA, but within striking distance.");
  } else {
    score -= 6;
    reasons.push("A significant reach on GPA.");
  }

  // --- Test scores ---
  //
  // Skipped for test-blind schools (null avgSAT), and for "estimated-sat"
  // schools, whose GPA was derived from the SAT: scoring both would count the
  // same number twice.
  if (student.satScore) {
    if (uni.avgSAT === null) {
      reasons.push("Test-blind — they don't consider SAT scores.");
    } else if (uni.gpaSource !== "estimated-sat") {
      const satGap = uni.avgSAT - student.satScore;
      if (satGap <= -30) {
        score += 8;
        reasons.push("Your SAT is comfortably above their average.");
      } else if (satGap <= 40) {
        score += 5;
        reasons.push("Your SAT is in range.");
      } else {
        score -= 4;
      }
    }
  }

  // --- Major fit ---
  score += Math.min(matchedMajors.length, 3) * 4;
  reasons.push(
    matchedMajors.length > 1
      ? `Offers ${matchedMajors.length} of your intended majors.`
      : `Offers your intended major (${matchedMajors[0]}).`
  );

  // --- Region preference ---
  let regionFit = true;
  if (student.preferredRegions && student.preferredRegions.length > 0) {
    if (student.preferredRegions.includes(uni.region)) {
      score += 8;
      reasons.push(`In a region you prefer (${uni.region}).`);
    } else {
      regionFit = false;
      score -= 6;
    }
  }

  // --- Financial fit ---
  const ceiling = AFFORDABLE_CEILING[student.financialNeed] ?? Infinity;
  const affordable = uni.tuition <= ceiling;
  if (student.financialNeed === "high") {
    if (affordable) {
      score += 10;
      reasons.push("Sticker tuition fits a high-need budget.");
    } else {
      score -= 12;
      reasons.push("Higher sticker price — look closely at aid and net price.");
    }
  } else if (student.financialNeed === "medium" && !affordable) {
    score -= 4;
    reasons.push("On the pricier side — worth checking aid packages.");
  }

  const tier = classifyTier(uni, gpaGap);

  return {
    ...uni,
    tier,
    matchScore: clamp(Math.round(score), 0, 100),
    matchedMajors,
    gpaGap,
    affordable,
    regionFit,
    reasons,
  };
}

// Tiering. A GPA gap means more at a selective school than at one admitting
// nine in ten, so the reach/safety thresholds widen as admission gets easier.

/** Below this, a school is never a safety: 2-in-5 odds are not "very likely". */
const SAFETY_FLOOR = 40;
/** Below this, a school is a reach for everyone, however strong. */
const REACH_CEILING = 12;

/** 0 at the safety floor, 1 at open admission. */
function admissionEase(acceptanceRate: number): number {
  return clamp((acceptanceRate - SAFETY_FLOOR) / (100 - SAFETY_FLOOR), 0, 1);
}

// GPA-gap thresholds at the safety floor and at open admission. Judgement
// calls, not fitted; these are the numbers to tune.
const REACH_GAP = { atFloor: 0.15, atOpen: 0.6 };
const SAFETY_GAP = { atFloor: -0.1, atOpen: 0.3 };

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export function classifyTier(uni: Pick<University, "acceptanceRate">, gpaGap: number): Tier {
  const ease = admissionEase(uni.acceptanceRate);
  if (uni.acceptanceRate < REACH_CEILING) return "reach";
  if (gpaGap >= lerp(REACH_GAP.atFloor, REACH_GAP.atOpen, ease)) return "reach";
  if (
    uni.acceptanceRate > SAFETY_FLOOR &&
    gpaGap <= lerp(SAFETY_GAP.atFloor, SAFETY_GAP.atOpen, ease)
  ) {
    return "safety";
  }
  return "target";
}
