import { describe, expect, test } from "vitest";
import { majorCatalog, majorInsights } from "../src/services/majorInsights.js";
import { body, get, post } from "./helpers.js";
import type { StudentRecord, University } from "../src/types.js";

// A small hand-built dataset, so the assertions are about the logic rather
// than about whatever happens to be in universities.json today.
const FIXTURE = [
  {
    id: 1, name: "Alpha", shortName: "Alpha", avgGPA: 3.9, avgSAT: 1500,
    majors: ["CS", "Math"], acceptanceRate: 5, tuition: 60000,
    region: "Northeast", city: "A", state: "MA", setting: "Urban", type: "Private",
  },
  {
    id: 2, name: "Beta", shortName: "Beta", avgGPA: 3.5, avgSAT: 1300,
    majors: ["CS", "Business"], acceptanceRate: 50, tuition: 30000,
    region: "West", city: "B", state: "CA", setting: "Suburban", type: "Public",
  },
  {
    id: 3, name: "Gamma", shortName: "Gamma", avgGPA: 3.7, avgSAT: 1400,
    majors: ["CS", "Math", "Business"], acceptanceRate: 25, tuition: 45000,
    region: "West", city: "C", state: "OR", setting: "Rural", type: "Public",
  },
  {
    id: 4, name: "Delta", shortName: "Delta", avgGPA: 3.2, avgSAT: 1200,
    majors: ["Business"], acceptanceRate: 70, tuition: 20000,
    region: "South", city: "D", state: "TX", setting: "Urban", type: "Public",
  },
] as University[];

describe("majorInsights", () => {
  test("counts only the schools that actually offer the major", () => {
    const cs = majorInsights("CS", null, FIXTURE);
    expect(cs.schoolCount).toBe(3);
    expect(cs.schools.map((s) => s.shortName).sort()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(cs.shareOfDataset).toBe(0.75);
  });

  test("spreads report min, median and max", () => {
    const cs = majorInsights("CS", null, FIXTURE);
    expect(cs.selectivity).toEqual({ min: 5, median: 25, max: 50 });
    expect(cs.tuition).toEqual({ min: 30000, median: 45000, max: 60000 });
    expect(cs.avgGPA).toEqual({ min: 3.5, median: 3.7, max: 3.9 });
  });

  test("adjacent majors are ranked by how often they co-occur", () => {
    const cs = majorInsights("CS", null, FIXTURE);
    // Math and Business each appear at 2 of the 3 CS schools; CS excludes itself.
    expect(cs.adjacent!.map((a) => a.key)).not.toContain("CS");
    const math = cs.adjacent!.find((a) => a.key === "Math");
    expect(math!.count).toBe(2);
    expect(math!.share).toBeCloseTo(0.667, 2);
  });

  test("schools are sorted most selective first", () => {
    const cs = majorInsights("CS", null, FIXTURE);
    expect(cs.schools.map((s) => s.acceptanceRate)).toEqual([5, 25, 50]);
  });

  test("without a student there is no position or combination data", () => {
    const cs = majorInsights("CS", null, FIXTURE);
    expect(cs.position).toBeNull();
    expect(cs.combinations).toBeNull();
    expect(cs.schools.every((s) => s.tier === null)).toBe(true);
  });

  test("position tiers are computed against the student's own GPA", () => {
    const strong = majorInsights("CS", { gpa: 4.0, interestedMajors: ["CS"] } as unknown as StudentRecord as unknown as StudentRecord, FIXTURE);
    const weak = majorInsights("CS", { gpa: 3.0, interestedMajors: ["CS"] } as unknown as StudentRecord as unknown as StudentRecord, FIXTURE);
    // A stronger student converts reaches into targets and safeties.
    expect(strong.position!.tiers.safety).toBeGreaterThan(weak.position!.tiers.safety);
    expect(weak.position!.tiers.reach).toBeGreaterThan(strong.position!.tiers.reach);
  });

  test("gpaGapToMedian is signed relative to the major's median", () => {
    const above = majorInsights("CS", { gpa: 3.9, interestedMajors: ["CS"] } as unknown as StudentRecord as unknown as StudentRecord, FIXTURE);
    expect(above.position!.medianGPA).toBe(3.7);
    expect(above.position!.gpaGapToMedian).toBeCloseTo(0.2, 2);

    const below = majorInsights("CS", { gpa: 3.5, interestedMajors: ["CS"] } as unknown as StudentRecord as unknown as StudentRecord, FIXTURE);
    expect(below.position!.gpaGapToMedian).toBeCloseTo(-0.2, 2);
  });

  test("combinations count schools covering a second interest", () => {
    const cs = majorInsights(
      "CS",
      { gpa: 3.7, interestedMajors: ["CS", "Math", "Business"] } as unknown as StudentRecord as unknown as StudentRecord,
      FIXTURE
    );
    const math = cs.combinations!.find((c) => c.major === "Math");
    const business = cs.combinations!.find((c) => c.major === "Business");
    expect(math!.count).toBe(2); // Alpha, Gamma
    expect(business!.count).toBe(2); // Beta, Gamma
    // The major itself is never listed as a combination with itself.
    expect(cs.combinations!.map((c) => c.major)).not.toContain("CS");
  });

  test("alsoCovers lists the student's other majors per school", () => {
    const cs = majorInsights("CS", { gpa: 3.7, interestedMajors: ["CS", "Math"] } as unknown as StudentRecord as unknown as StudentRecord, FIXTURE);
    const gamma = cs.schools.find((s) => s.shortName === "Gamma");
    const beta = cs.schools.find((s) => s.shortName === "Beta");
    expect(gamma!.alsoCovers).toEqual(["Math"]);
    expect(beta!.alsoCovers).toEqual([]);
  });

  test("affordability respects the student's stated need", () => {
    const high = majorInsights("CS", { gpa: 3.7, financialNeed: "high", interestedMajors: [] } as unknown as StudentRecord as unknown as StudentRecord, FIXTURE);
    const low = majorInsights("CS", { gpa: 3.7, financialNeed: "low", interestedMajors: [] } as unknown as StudentRecord as unknown as StudentRecord, FIXTURE);
    expect(high.position!.affordable).toBe(1); // only Beta at 30k
    expect(low.position!.affordable).toBe(3); // no ceiling
  });

  test("a major nobody offers returns an empty result rather than throwing", () => {
    const none = majorInsights("Basket Weaving", null, FIXTURE);
    expect(none.schoolCount).toBe(0);
    expect(none.schools).toEqual([]);
  });

  test("catalog counts every major across the dataset", () => {
    const catalog = majorCatalog(FIXTURE);
    expect(catalog.find((c) => c.major === "Business")!.schoolCount).toBe(3);
    expect(catalog.find((c) => c.major === "Math")!.schoolCount).toBe(2);
  });
});

describe("major endpoints", () => {
  test("GET /api/majors lists majors with counts", async () => {
    const b = await body(await get("/api/majors"), 200);
    expect(b.majors.length).toBeGreaterThan(5);
    expect(b.majors[0]).toHaveProperty("schoolCount");
  });

  test("GET /api/majors/:major works anonymously", async () => {
    const b = await body(await get("/api/majors/CS"), 200);
    expect(b.position).toBeNull();
    expect(b.researchQuestions.length).toBeGreaterThan(0);
  });

  test("a studentId personalizes the response", async () => {
    const student = await body(
      await post("/api/students", { name: "Kai", gpa: 3.9, interestedMajors: ["CS", "Math"] }),
      201
    );

    const b = await body(await get(`/api/majors/CS?studentId=${student.id}`), 200);
    expect(b.position).not.toBeNull();
    expect(b.combinations.map((c: { major: string }) => c.major)).toContain("Math");
  });

  test("majors with spaces survive URL encoding", async () => {
    const b = await body(await get(`/api/majors/${encodeURIComponent("Data Science")}`), 200);
    expect(b.major).toBe("Data Science");
  });

  test("an unknown major 404s; a studentId the caller does not own 403s", async () => {
    expect((await get("/api/majors/Nonexistent")).status).toBe(404);
    // The studentId arrives as a query parameter, outside the /students/:id
    // prefix requireOwner guards, so this route checks ownership by hand — the
    // insights it returns are derived from the profile.
    expect((await get("/api/majors/CS?studentId=nope")).status).toBe(403);
  });
});
