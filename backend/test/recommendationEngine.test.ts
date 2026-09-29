import { expect, test } from "vitest";
import { classifyTier, recommendUniversities } from "../src/services/recommendationEngine.js";
import type { StudentRecord, University } from "../src/types.js";

const sampleUniversities = [
  {
    id: 1,
    name: "Elite Tech",
    shortName: "ET",
    avgGPA: 3.95,
    avgSAT: 1540,
    majors: ["CS", "Engineering"],
    acceptanceRate: 4,
    tuition: 60000,
    region: "Northeast",
    city: "Cambridge",
    state: "MA",
  },
  {
    id: 2,
    name: "Mid State",
    shortName: "MS",
    avgGPA: 3.7,
    avgSAT: 1350,
    majors: ["CS", "Business"],
    acceptanceRate: 45,
    tuition: 30000,
    region: "Midwest",
    city: "Columbus",
    state: "OH",
  },
  {
    id: 3,
    name: "Open Access U",
    shortName: "OAU",
    avgGPA: 3.3,
    avgSAT: 1150,
    majors: ["CS", "Psychology"],
    acceptanceRate: 85,
    tuition: 25000,
    region: "West",
    city: "Tempe",
    state: "AZ",
  },
  {
    id: 4,
    name: "Art House",
    shortName: "AH",
    avgGPA: 3.6,
    avgSAT: 1280,
    majors: ["Art", "Communications"],
    acceptanceRate: 60,
    tuition: 40000,
    region: "West",
    city: "Portland",
    state: "OR",
  },
] as unknown as University[];

const baseStudent = {
  gpa: 3.7,
  satScore: 1400,
  interestedMajors: ["CS"],
  extracurriculars: [],
  financialNeed: "low",
  preferredRegions: [],
} as unknown as StudentRecord;

test("groups schools into reach, target, and safety", () => {
  const recs = recommendUniversities(baseStudent, sampleUniversities);
  expect(recs.reach.some((u) => u.shortName === "ET")).toBe(true);
  expect(recs.safety.some((u) => u.shortName === "OAU")).toBe(true);
  expect(recs.target.some((u) => u.shortName === "MS")).toBe(true);
});

test("excludes schools that do not offer an intended major", () => {
  const recs = recommendUniversities(baseStudent, sampleUniversities);
  const allNames = [...recs.reach, ...recs.target, ...recs.safety].map((u) => u.shortName);
  expect(allNames).not.toContain("AH"); // Art House offers no CS
});

test("high financial need penalizes expensive schools in score", () => {
  const wealthyOk = recommendUniversities({ ...baseStudent, financialNeed: "low" }, sampleUniversities);
  const highNeed = recommendUniversities({ ...baseStudent, financialNeed: "high" }, sampleUniversities);
  const eliteLow = [...wealthyOk.reach].find((u) => u.shortName === "ET");
  const eliteHigh = [...highNeed.reach].find((u) => u.shortName === "ET");
  expect(eliteHigh!.matchScore).toBeLessThan(eliteLow!.matchScore);
  expect(eliteHigh!.affordable).toBe(false);
});

test("region preference boosts matching schools", () => {
  const recs = recommendUniversities(
    { ...baseStudent, preferredRegions: ["Midwest"] },
    sampleUniversities
  );
  const midState = [...recs.reach, ...recs.target, ...recs.safety].find((u) => u.shortName === "MS");
  expect(midState!.regionFit).toBe(true);
  expect(midState!.reasons.join(" ")).toMatch(/region/i);
});

test("classifyTier marks highly selective schools as reach", () => {
  expect(classifyTier({ acceptanceRate: 5 }, -0.5)).toBe("reach");
  expect(classifyTier({ acceptanceRate: 70 }, -0.3)).toBe("safety");
  expect(classifyTier({ acceptanceRate: 30 }, 0.0)).toBe("target");
});

// --- How much a GPA gap means depends on how hard the school is to get into ---

test("a school admitting almost everyone is not a reach on a small GPA gap", () => {
  // The regression: acceptanceRate was read as a binary above 40%, so the whole
  // decision rested on gpaGap and Cal State Stanislaus — 98.1% admit — came out
  // a "reach" for a 3.2 student sitting 0.16 under its typical admit.
  expect(classifyTier({ acceptanceRate: 98 }, 0.16)).not.toBe("reach");
  expect(classifyTier({ acceptanceRate: 90 }, 0.3)).not.toBe("reach");
});

test("the same GPA gap means different things at different admission rates", () => {
  const gap = 0.2;
  expect(classifyTier({ acceptanceRate: 41 }, gap)).toBe("reach");
  expect(classifyTier({ acceptanceRate: 95 }, gap)).toBe("safety");
});

test("a student far below the bar is still a reach, however open the school", () => {
  // Widening the tolerance must not collapse into "everything is a safety".
  expect(classifyTier({ acceptanceRate: 99 }, 0.8)).toBe("reach");
});

test("holds the two invariants the tiers rest on", () => {
  for (let gap = -1; gap <= 1; gap += 0.05) {
    const g = Number(gap.toFixed(2));
    // Nobody is safe at a school taking one applicant in ten.
    expect(classifyTier({ acceptanceRate: 8 }, g), `gap ${g}`).toBe("reach");
    // 2-in-5 odds are not "very likely admits you", however strong the student.
    expect(classifyTier({ acceptanceRate: 40 }, g), `gap ${g}`).not.toBe("safety");
  }
});

test("never makes a school more of a reach than the fixed thresholds did", () => {
  // The change loosens tiers; it must not newly discourage anyone. A student
  // told their safety is actually a reach is the failure that costs applications.
  const rank = { safety: 0, target: 1, reach: 2 };
  const before = (acc: number, gap: number) =>
    acc < 12 || gap >= 0.15 ? "reach" : acc > 40 && gap <= -0.1 ? "safety" : "target";
  for (let acc = 1; acc <= 100; acc += 1) {
    for (let gap = -1; gap <= 1; gap += 0.05) {
      const g = Number(gap.toFixed(2));
      const now = classifyTier({ acceptanceRate: acc }, g);
      expect(rank[now], `admit ${acc}, gap ${g}`).toBeLessThanOrEqual(
        rank[before(acc, g) as keyof typeof rank]
      );
    }
  }
});

// --- Derived signals ---
//
// Most of the dataset's avgGPA is interpolated from avgSAT by
// scripts/import-scorecard.mjs. Where that is true the two fields are one
// measurement, and scoring both would let a school earn up to 26 points from
// the same number that earns another school 18.

const satOnlyStudent = { ...baseStudent, gpa: 3.7, satScore: 1500 } as StudentRecord;

function scoreOf(uni: Partial<University>): number {
  const school = {
    id: 99,
    name: "Derived U",
    shortName: "DU",
    avgGPA: 3.5,
    avgSAT: 1300,
    majors: ["CS"],
    acceptanceRate: 50,
    tuition: 20000,
    region: "West",
    city: "Reno",
    state: "NV",
    ...uni,
  } as University;
  const recs = recommendUniversities(satOnlyStudent, [school]);
  return [...recs.reach, ...recs.target, ...recs.safety][0]!.matchScore;
}

test("does not score SAT twice when the GPA was derived from it", () => {
  // Identical school, identical student; the only difference is whether avgGPA
  // is the school's own figure or one interpolated from avgSAT.
  const independent = scoreOf({ gpaSource: "curated" });
  const derived = scoreOf({ gpaSource: "estimated-sat" });
  expect(derived).toBeLessThan(independent);
});

test("says nothing about SAT when the GPA already encodes it", () => {
  const recs = recommendUniversities(satOnlyStudent, [
    { ...(sampleUniversities[1] as University), gpaSource: "estimated-sat" },
  ]);
  const only = [...recs.reach, ...recs.target, ...recs.safety][0]!;
  // Restating one fact would cost a slot in the three reasons a card shows.
  expect(only.reasons.join(" ")).not.toMatch(/SAT/i);
});

test("still scores SAT for a school that reported both figures", () => {
  const recs = recommendUniversities(satOnlyStudent, [
    { ...(sampleUniversities[1] as University), gpaSource: "curated" },
  ]);
  const only = [...recs.reach, ...recs.target, ...recs.safety][0]!;
  expect(only.reasons.join(" ")).toMatch(/SAT/i);
});

test("a test-blind school is neither scored nor silent about it", () => {
  const recs = recommendUniversities(satOnlyStudent, [
    { ...(sampleUniversities[1] as University), avgSAT: null, gpaSource: "estimated-profile" },
  ]);
  const only = [...recs.reach, ...recs.target, ...recs.safety][0]!;
  expect(only.reasons.join(" ")).toMatch(/test-blind/i);
  expect(only.matchScore).toBe(scoreOf({ ...sampleUniversities[1], avgSAT: null, gpaSource: "estimated-profile" }));
});
