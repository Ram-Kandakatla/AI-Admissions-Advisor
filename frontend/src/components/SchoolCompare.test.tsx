import { describe, expect, it } from "vitest";
import { standoutIndex } from "./SchoolCompare";
import type { Metric } from "./SchoolCompare";
import { university } from "../test/factories";
import type { University } from "../types";

// The grid flags one column per numeric row — "Highest bar", "Best odds". Most
// of the dataset's GPAs are inferred, so the flag has to know the difference
// between a real lead and the estimator's own noise.

const gpaRow = (uncertainty?: (u: University) => number): Metric => ({
  key: "gpa",
  label: "Avg admitted GPA",
  cell: (u) => u.avgGPA,
  standout: { of: (u) => u.avgGPA, pick: "max", label: "Highest bar", uncertainty },
});

const NOISE: Record<string, number> = {
  curated: 0,
  "estimated-sat": 0.09,
  "estimated-profile": 0.152,
};
const gpaNoise = (u: University) => NOISE[u.gpaSource ?? "curated"] ?? 0;

describe("standoutIndex", () => {
  it("flags the leader when the numbers are reported", () => {
    const cols = [
      university({ id: 1, avgGPA: 3.5, gpaSource: "curated" }),
      university({ id: 2, avgGPA: 3.9, gpaSource: "curated" }),
    ];
    expect(standoutIndex(gpaRow(gpaNoise), cols)).toBe(1);
  });

  it("does not flag a lead smaller than the estimate's own error", () => {
    // The finding: an interpolated 3.93 took "Highest bar" from a reported 3.90
    // on a 0.03 gap, adjudicated with a number whose RMSE is 0.09.
    const cols = [
      university({ id: 1, avgGPA: 3.9, gpaSource: "curated" }),
      university({ id: 2, avgGPA: 3.93, gpaSource: "estimated-sat" }),
    ];
    expect(standoutIndex(gpaRow(gpaNoise), cols)).toBe(-1);
  });

  it("still flags a lead that clears the error", () => {
    const cols = [
      university({ id: 1, avgGPA: 3.4, gpaSource: "curated" }),
      university({ id: 2, avgGPA: 3.93, gpaSource: "estimated-sat" }),
    ];
    expect(standoutIndex(gpaRow(gpaNoise), cols)).toBe(1);
  });

  it("uses the noisiest column's error, not the winner's", () => {
    // A confident number beating a vague one is still only as sure as the vague
    // one. 3.80 vs 3.70 is 0.10 — inside the 0.152 of the profile estimate.
    const cols = [
      university({ id: 1, avgGPA: 3.7, gpaSource: "estimated-profile" }),
      university({ id: 2, avgGPA: 3.8, gpaSource: "curated" }),
    ];
    expect(standoutIndex(gpaRow(gpaNoise), cols)).toBe(-1);
  });

  it("flags nothing when every column ties", () => {
    const cols = [university({ id: 1, avgGPA: 3.5 }), university({ id: 2, avgGPA: 3.5 })];
    expect(standoutIndex(gpaRow(gpaNoise), cols)).toBe(-1);
  });

  it("flags nothing with a single column", () => {
    expect(standoutIndex(gpaRow(gpaNoise), [university({ avgGPA: 3.5 })])).toBe(-1);
  });

  it("is unaffected on rows that declare no uncertainty", () => {
    // Acceptance rate and tuition are reported figures; a 0.03 lead is real.
    const cols = [
      university({ id: 1, avgGPA: 3.9, gpaSource: "curated" }),
      university({ id: 2, avgGPA: 3.93, gpaSource: "estimated-sat" }),
    ];
    expect(standoutIndex(gpaRow(), cols)).toBe(1);
  });
});
