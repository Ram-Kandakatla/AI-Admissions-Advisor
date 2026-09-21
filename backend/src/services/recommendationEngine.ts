// Rule-based university recommendation engine.
// Given a student profile, returns schools grouped into reach / target / safety,
// each annotated with a match score and human-readable reasons.
//
// The rules are intentionally simple and transparent so they can be validated
// with real students before any move to a learned model.

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

/**
 * Score a single university against the student.
 * Returns null when the school has no overlap with the student's intended majors
 * (a hard requirement), otherwise a recommendation object.
 */
export function evaluate(uni: University, student: StudentRecord): Recommendation | null {
  const majors = student.interestedMajors || [];
  const matchedMajors = majors.filter((m: string) => uni.majors.includes(m));
  if (matchedMajors.length === 0) return null; // Rule 1: must offer an intended major

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
  // Scored only when the school's SAT average is evidence the GPA block above
  // has not already used. Two cases where it is not:
  //
  //  - avgSAT is null. That is not missing data — the school reports no SAT
  //    average because it does not consider the SAT. Scoring against it would
  //    invent a hurdle the school does not have, so a test-blind school is
  //    neither rewarded nor penalised here and the student is told why.
  //  - avgGPA was interpolated *from* avgSAT (gpaSource "estimated-sat", which
  //    is most of the dataset). Then gpaGap and satGap are the same measurement
  //    twice: a school scored on both could earn 26 points from one number
  //    while a school with a single signal earns 18. The reasons would restate
  //    one fact too, in two of the three slots a card shows.
  //
  // A curated school keeps both terms, because there its GPA and SAT really are
  // two independent figures the school reported.
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

// Reach / target / safety based on selectivity and GPA distance.
export function classifyTier(uni: Pick<University, "acceptanceRate">, gpaGap: number): Tier {
  if (uni.acceptanceRate < 12 || gpaGap >= 0.15) return "reach";
  if (uni.acceptanceRate > 40 && gpaGap <= -0.1) return "safety";
  return "target";
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
