import { describe, expect, test } from "vitest";
import {
  amountLabel,
  classifyTier,
  deadlineWindow,
  evaluate,
  recommendScholarships,
} from "../src/services/scholarshipEngine.js";
import { loadScholarships } from "../src/store/staticData.js";
import { body, get, post } from "./helpers.js";
import type { Scholarship, StudentRecord } from "../src/types.js";

const student = (overrides: Record<string, unknown> = {}): StudentRecord => ({
  id: "s1",
  name: "Sam",
  gpa: 3.6,
  satScore: 1350,
  actScore: null,
  interestedMajors: ["CS"],
  extracurriculars: [],
  careerGoals: "",
  financialNeed: "medium",
  preferredRegions: [],
  ...overrides,
}) as unknown as StudentRecord;

const award = (overrides: Record<string, unknown> = {}): Scholarship => ({
  id: "test",
  name: "Test Award",
  sponsor: "Nobody",
  url: "https://example.org",
  summary: "",
  award: { min: 5000, max: 5000, term: "total", renewable: false },
  awardsPerYear: 100,
  minGPA: 3.0,
  need: "none",
  maxHouseholdIncome: null,
  citizenship: "any",
  forMajors: [],
  audience: [],
  effort: "essay",
  competitiveness: "moderate",
  deadlineMonth: 11,
  deadlineNote: "",
  tags: [],
  ...overrides,
}) as unknown as Scholarship;

describe("scholarship dataset", () => {
  const all = loadScholarships();

  test("every entry carries the fields the engine reads", () => {
    for (const s of all) {
      expect(typeof s.id).toBe("string");
      expect(typeof s.name).toBe("string");
      expect(s.url).toMatch(/^https:\/\//);
      expect(Array.isArray(s.forMajors)).toBe(true);
      expect(Array.isArray(s.audience)).toBe(true);
      expect(["required", "considered", "none"]).toContain(s.need);
      expect(["short", "essay", "multi-stage"]).toContain(s.effort);
      expect(["elite", "high", "moderate", "broad", "entitlement"]).toContain(s.competitiveness);
      expect(s.deadlineMonth === null || (s.deadlineMonth >= 1 && s.deadlineMonth <= 12)).toBe(true);
    }
  });

  test("ids are unique", () => {
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length);
  });

  test("no entry asserts a specific deadline date", () => {
    // Months and notes only — a hard date here would be a promise the data
    // can't keep from one cycle to the next.
    for (const s of all) {
      expect(s).not.toHaveProperty("deadline");
      expect(s.deadlineNote).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    }
  });
});

describe("eligibility gates", () => {
  test("a GPA under a stated floor filters the award out entirely", () => {
    expect(evaluate(award({ minGPA: 3.8 }), student({ gpa: 3.6 }))).toBeNull();
    expect(evaluate(award({ minGPA: 3.5 }), student({ gpa: 3.6 }))).not.toBeNull();
  });

  test("a test floor only applies to students who have a score", () => {
    const s = award({ minSAT: 1400 });
    expect(evaluate(s, student({ satScore: 1200 }))).toBeNull();
    // Test-optional: no score sent, so the floor has nothing to judge.
    expect(evaluate(s, student({ satScore: null }))).not.toBeNull();
  });

  test("major-restricted awards need an overlap with the student's majors", () => {
    const s = award({ forMajors: ["Nursing"] });
    expect(evaluate(s, student({ interestedMajors: ["CS"] }))).toBeNull();
    expect(evaluate(s, student({ interestedMajors: ["CS", "Nursing"] }))).not.toBeNull();
  });

  test("need-based awards drop out for a student reporting no need", () => {
    const s = award({ need: "required" });
    expect(evaluate(s, student({ financialNeed: "low" }))).toBeNull();
    expect(evaluate(s, student({ financialNeed: "high" }))).not.toBeNull();
  });
});

describe("tiering", () => {
  test("elite programs are a reach for everyone, however strong the profile", () => {
    const r = evaluate(award({ competitiveness: "elite", minGPA: 2.0 }), student({ gpa: 4.0 }));
    expect(r!.tier).toBe("reach");
  });

  test("an entitlement is always a safety", () => {
    expect(classifyTier(award({ competitiveness: "entitlement" }), 1.0, false)).toBe("safety");
  });

  test("sitting on the GPA floor makes a competitive award a reach", () => {
    expect(classifyTier(award({ competitiveness: "high" }), 0.05, false)).toBe("reach");
    expect(classifyTier(award({ competitiveness: "high" }), 0.4, false)).toBe("target");
  });

  test("an unverifiable condition caps a broad award at target", () => {
    // Compass never asks for demographics, so it must not promote an award
    // to safety on the assumption the student qualifies.
    expect(classifyTier(award({ competitiveness: "broad" }), 0.6, false)).toBe("safety");
    expect(classifyTier(award({ competitiveness: "broad" }), 0.6, true)).toBe("target");
  });

  test("financial need is never something the student is asked to re-confirm", () => {
    // The profile already answered it, and the need gate already acted on it.
    const r = evaluate(award({ audience: ["low-income"], need: "required" }), student({ financialNeed: "high" }));
    expect(r!.eligibilityToConfirm).toEqual([]);
  });

  test("restricted awards say which condition to confirm", () => {
    const r = evaluate(award({ audience: ["lgbtq"] }), student());
    expect(r!.eligibilityToConfirm).toEqual(["LGBTQ students"]);
    expect(r!.reasons.join(" ")).toMatch(/confirm you qualify/);
  });
});

describe("deadline windows", () => {
  test("autumn months land in the cycle year, winter and spring in the next", () => {
    expect(deadlineWindow(award({ deadlineMonth: 11 }), 2026).label).toBe("November 2026");
    expect(deadlineWindow(award({ deadlineMonth: 2 }), 2026).label).toBe("February 2027");
  });

  test("a program with no fixed month is labelled rolling and sorts last", () => {
    const w = deadlineWindow(award({ deadlineMonth: null }), 2026);
    expect(w.label).toBe("Rolling / varies");
    expect(w.sortKey > "2027-12").toBe(true);
  });

  test("every window is flagged as unconfirmed", () => {
    for (const s of loadScholarships()) {
      expect(deadlineWindow(s, 2026).isTypical).toBe(true);
    }
  });
});

describe("amounts", () => {
  test("fixed, ranged, per-year and full-cost awards each read correctly", () => {
    expect(amountLabel(award({ award: { min: 5000, max: 5000, term: "total" } }))).toBe("$5,000");
    expect(amountLabel(award({ award: { min: 1000, max: 5000, term: "total" } }))).toBe("$1,000–$5,000");
    expect(amountLabel(award({ award: { min: 10000, max: 10000, term: "per-year" } }))).toBe(
      "$10,000 per year"
    );
    expect(amountLabel(award({ award: { min: 0, max: 0, term: "full-ride" } }))).toBe(
      "Full cost of attendance"
    );
  });
});

describe("recommendScholarships", () => {
  test("groups into the three tiers and sorts each by match score", () => {
    const tiers = recommendScholarships(student({ gpa: 3.9, financialNeed: "high" }));
    for (const tier of ["reach", "target", "safety"] as const) {
      const scores = tiers[tier].map((s) => s.matchScore);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    }
    const total = tiers.reach.length + tiers.target.length + tiers.safety.length;
    expect(total).toBeGreaterThan(15);
  });

  test("a low-need student sees fewer awards than a high-need one", () => {
    const count = (s: StudentRecord) => {
      const t = recommendScholarships(s);
      return t.reach.length + t.target.length + t.safety.length;
    };
    expect(count(student({ financialNeed: "low" }))).toBeLessThan(
      count(student({ financialNeed: "high" }))
    );
  });

  test("match scores stay inside 0-100", () => {
    const tiers = recommendScholarships(student({ gpa: 4.0, financialNeed: "high" }));
    for (const tier of ["reach", "target", "safety"] as const) {
      for (const s of tiers[tier]) {
        expect(s.matchScore).toBeGreaterThanOrEqual(0);
        expect(s.matchScore).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("GET /api/students/:id/scholarships", () => {
  async function newStudent(overrides: Record<string, unknown> = {}): Promise<string> {
    const created = await body(
      await post("/api/students", {
        name: "Sam",
        gpa: 3.7,
        interestedMajors: ["CS"],
        financialNeed: "high",
        ...overrides,
      }),
      201
    );
    return created.id;
  }

  test("returns tiered matches with counts", async () => {
    const id = await newStudent();
    const b = await body(await get(`/api/students/${id}/scholarships`), 200);
    expect(b.studentId).toBe(id);
    expect(b.counts.reach).toBe(b.scholarships.reach.length);
    const first = b.scholarships.reach[0];
    expect(first).toHaveProperty("matchScore");
    expect(first).toHaveProperty("amountLabel");
    expect(first.deadline.isTypical).toBe(true);
  });

  test("404s for an unknown student", async () => {
    expect((await get("/api/students/nope/scholarships")).status).toBe(404);
  });
});
