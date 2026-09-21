// Tests for the College Scorecard importer's pure transforms.
//
// The importer is a build-time script, not request-path code, so what is worth
// testing here is narrow: the handful of functions that fail *silently*. A CSV
// parser that mishandles a quoted field does not throw — it shifts every later
// column by one and writes a plausible wrong tuition. numberOrNull returning 0
// for an empty cell does not throw either; it produces a free school. Those are
// the bugs that reach the dataset looking like data.

import { describe, expect, it } from "vitest";
import {
  ADMIT_GPA_ANCHORS,
  CENSUS_REGION,
  CURATED_UNITIDS,
  GPA_ANCHORS,
  cleanName,
  estimateGpa,
  estimateGpaFromAdmitRate,
  majorsFor,
  numberOrNull,
  parseCsv,
  settingFor,
  shortNameFor,
  testPolicyFor,
} from "../scripts/import-scorecard.mjs";
import universities from "../data/universities.json";

const rows = (text: string) => [...parseCsv(text)];

describe("parseCsv", () => {
  it("reads a plain row", () => {
    expect(rows("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps a quoted comma inside one field", () => {
    // The failure this guards is not an exception. Splitting on "," would give
    // this row four fields, silently shifting STABBR into CITY and every numeric
    // column one place left.
    const [row] = rows('"Saint Joseph\'s College, Long Island",NY,11772\n');
    expect(row).toEqual(["Saint Joseph's College, Long Island", "NY", "11772"]);
  });

  it("unescapes a doubled quote", () => {
    expect(rows('"He said ""hi""",x\n')[0]).toEqual(['He said "hi"', "x"]);
  });

  it("keeps a newline inside a quoted field", () => {
    expect(rows('"two\nlines",x\n')[0]).toEqual(["two\nlines", "x"]);
  });

  it("preserves empty fields rather than dropping them", () => {
    expect(rows("a,,c\n")[0]).toEqual(["a", "", "c"]);
  });

  it("yields a final row with no trailing newline", () => {
    expect(rows("a,b\n1,2")).toHaveLength(2);
  });

  it("tolerates CRLF", () => {
    expect(rows("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("numberOrNull", () => {
  it.each(["", "NULL", "null", "PS", "abc"])("treats %o as missing", (v) => {
    expect(numberOrNull(v)).toBeNull();
  });

  it("does not turn an empty cell into zero", () => {
    // Number("") === 0, which would read as a real $0 tuition or a 0% admit rate.
    expect(numberOrNull("")).not.toBe(0);
  });

  it("parses real values including a legitimate zero", () => {
    expect(numberOrNull("0.0432")).toBeCloseTo(0.0432);
    expect(numberOrNull("0")).toBe(0);
  });
});

describe("estimateGpa", () => {
  it("interpolates between anchors", () => {
    // Midway between [1050, 3.10] and [1150, 3.30].
    expect(estimateGpa(1100)).toBeCloseTo(3.2, 2);
  });

  it("returns the anchor value at an anchor", () => {
    for (const [sat, gpa] of GPA_ANCHORS) expect(estimateGpa(sat)).toBeCloseTo(gpa, 2);
  });

  it("clamps outside the anchor range instead of extrapolating", () => {
    // Unbounded extrapolation is how a linear fit produces a 4.4 or a negative
    // GPA at the tails; the curve is only meaningful between its anchors.
    const first = GPA_ANCHORS.at(0);
    const last = GPA_ANCHORS.at(-1);
    expect(first && last).toBeTruthy();
    expect(estimateGpa(400)).toBe(first![1]);
    expect(estimateGpa(1600)).toBe(last![1]);
  });

  it("is monotonic in SAT", () => {
    let prev = -Infinity;
    for (let sat = 700; sat <= 1600; sat += 10) {
      const g = estimateGpa(sat);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
  });

  it("stays inside a believable GPA range across the whole SAT scale", () => {
    for (let sat = 400; sat <= 1600; sat += 10) {
      expect(estimateGpa(sat)).toBeGreaterThan(2.0);
      expect(estimateGpa(sat)).toBeLessThanOrEqual(4.0);
    }
  });

  it("tracks the hand-curated schools it was calibrated against", () => {
    // The curve's only validation data. If someone retunes GPA_ANCHORS, this is
    // what catches a change that no longer agrees with the reported figures.
    const curated = (universities as any[]).filter((u) => u.gpaSource === "curated");
    expect(curated.length).toBeGreaterThan(0);
    const errors = curated.map((u) => estimateGpa(u.avgSAT) - u.avgGPA);
    const bias = errors.reduce((a, b) => a + b, 0) / errors.length;
    const rmse = Math.sqrt(errors.reduce((a, e) => a + e * e, 0) / errors.length);
    expect(Math.abs(bias)).toBeLessThan(0.05);
    expect(rmse).toBeLessThan(0.12);
  });
});

describe("majorsFor", () => {
  const read = (cols: Record<string, string>) => (col: string) => cols[col] ?? "0";

  it("maps a CIP family onto the existing vocabulary", () => {
    expect(majorsFor(read({ PCIP11: "0.4" }), 0.005, 8)).toEqual(["CS"]);
  });

  it("ignores a family below the threshold", () => {
    expect(majorsFor(read({ PCIP11: "0.001" }), 0.005, 8)).toEqual([]);
  });

  it("credits both majors that share a CIP family", () => {
    expect(majorsFor(read({ PCIP40: "0.2" }), 0.005, 8).sort()).toEqual(["Chemistry", "Physics"]);
  });

  it("only credits Data Science when both CS and Math are present", () => {
    expect(majorsFor(read({ PCIP11: "0.3" }), 0.005, 8)).not.toContain("Data Science");
    expect(majorsFor(read({ PCIP11: "0.3", PCIP27: "0.05" }), 0.005, 8)).toContain("Data Science");
  });

  it("caps the list and keeps the largest programs", () => {
    const cols = { PCIP11: "0.30", PCIP14: "0.25", PCIP52: "0.20", PCIP26: "0.15", PCIP54: "0.01" };
    const out = majorsFor(read(cols), 0.005, 2);
    // The cap is what stops an imported school from out-scoring a curated one on
    // major fit in evaluate(), which credits min(matchedMajors, 3) * 4.
    expect(out).toHaveLength(2);
    expect(out).toEqual(["CS", "Engineering"]);
  });

  it("returns nothing when a school reports no programs", () => {
    expect(majorsFor(read({}), 0.005, 8)).toEqual([]);
  });

  it("never invents a major outside the dataset's vocabulary", () => {
    const vocabulary = new Set((universities as any[]).flatMap((u) => u.majors));
    const everything: Record<string, string> = {};
    for (const c of ["01", "03", "09", "11", "13", "14", "23", "26", "27", "40", "42", "45", "50", "51", "52", "54"]) {
      everything[`PCIP${c}`] = "0.5";
    }
    // knownMajors() is derived from this file and feeds both the profile form's
    // dropdown and validateProfile()'s allowlist, so a stray label here would
    // desynchronise the two.
    for (const m of majorsFor(read(everything), 0.005, 99)) {
      expect(vocabulary).toContain(m);
    }
  });
});

describe("shortNameFor", () => {
  it.each([
    ["University of Kentucky", "Kentucky"],
    ["Bridgewater State University", "Bridgewater State"],
    ["Brandeis University", "Brandeis"],
    ["Smith College", "Smith"],
    ["University of South Carolina-Columbia", "South Carolina-Columbia"],
    ["The University of Texas at San Antonio", "Texas at San Antonio"],
  ])("reduces %o to %o", (input, expected) => {
    expect(shortNameFor(input)).toBe(expected);
  });

  it.each([
    ["University of California-Davis", "UC Davis"],
    ["California State University-Fullerton", "Cal State Fullerton"],
    ["State University of New York at Oswego", "SUNY Oswego"],
  ])("uses the colloquial abbreviation for %o", (input, expected) => {
    // The generic rules give "California-Davis" and leave the Cal State names
    // untouched, because they do not end in "State University".
    expect(shortNameFor(input)).toBe(expected);
  });

  it("prefers 'X State' over the bare university rule", () => {
    // Order matters: the generic "X University" rule would leave "Ohio".
    expect(shortNameFor("Ohio State University")).toBe("Ohio State");
  });

  it("falls back to the full name rather than truncating", () => {
    const long = "Washington University in St Louis";
    expect(shortNameFor(long)).toBe(long);
    expect(shortNameFor(long)).not.toContain("…");
  });
});

describe("field mappings", () => {
  it("maps IPEDS locale codes to settings", () => {
    expect(settingFor("11")).toBe("Urban");
    expect(settingFor("22")).toBe("Suburban");
    expect(settingFor("32")).toBe("College Town");
    expect(settingFor("41")).toBe("Rural");
  });

  it("splits the Southwest the way the curated data does", () => {
    // Scorecard's own REGION column puts both in one bucket; Census does not.
    expect(CENSUS_REGION.AZ).toBe("West");
    expect(CENSUS_REGION.TX).toBe("South");
  });

  it("reads the admission-test requirement", () => {
    expect(testPolicyFor("1")).toBe("required");
    expect(testPolicyFor("5")).toBe("optional");
    expect(testPolicyFor("")).toBeNull();
  });

  it("strips the campus suffix IPEDS adds", () => {
    expect(cleanName("Ohio State University-Main Campus")).toBe("Ohio State University");
    expect(cleanName("Arizona State University Campus Immersion")).toBe("Arizona State University");
  });
});

describe("the generated dataset", () => {
  const all = universities as any[];

  it("has no duplicate ids, unitids or names", () => {
    for (const key of ["id", "unitid", "name", "shortName"]) {
      const seen = all.map((u) => u[key]);
      expect(new Set(seen).size, `duplicate ${key}`).toBe(seen.length);
    }
  });

  it("keeps every curated school, with its id and hand-entered GPA", () => {
    const curated = all.filter((u) => u.gpaSource === "curated");
    expect(curated).toHaveLength(Object.keys(CURATED_UNITIDS).length);
    // Curated ids must stay 1..42: school_notes and applications hold
    // university_id in D1, so renumbering repoints a student's saved notes.
    for (const u of curated) {
      expect(u.id).toBeLessThanOrEqual(42);
      expect(CURATED_UNITIDS[u.shortName]).toBe(u.unitid);
    }
  });

  it("gives every school at least one major", () => {
    // evaluate() treats "offers an intended major" as a hard requirement, so a
    // school with none can never be recommended.
    for (const u of all) expect(u.majors.length).toBeGreaterThan(0);
  });

  it("labels every GPA with where it came from", () => {
    for (const u of all) {
      expect(["curated", "estimated-sat", "estimated-admit"]).toContain(u.gpaSource);
    }
  });

  it("holds plausible values in every numeric field", () => {
    for (const u of all) {
      expect(u.avgGPA, u.name).toBeGreaterThan(2.0);
      expect(u.avgGPA, u.name).toBeLessThanOrEqual(4.0);
      expect(u.acceptanceRate, u.name).toBeGreaterThan(0);
      expect(u.acceptanceRate, u.name).toBeLessThanOrEqual(100);
      // >= 0, not > 0: a $0 sticker is real, not a missing value. The Curtis
      // Institute charges no tuition at all and the service academies are
      // government-funded. numberOrNull() already maps "" and "NULL" to null, so
      // a zero that reaches here was reported as a zero.
      expect(u.tuition, u.name).toBeGreaterThanOrEqual(0);
      // avgSAT is nullable: a test-blind school genuinely has none.
      if (u.avgSAT !== null) {
        expect(u.avgSAT, u.name).toBeGreaterThanOrEqual(400);
        expect(u.avgSAT, u.name).toBeLessThanOrEqual(1600);
      }
    }
  });

  it("pairs a null SAT with an admit-rate GPA, and never the reverse", () => {
    // The two must agree or a school is carrying a GPA derived from a number it
    // does not have — or hiding an SAT the engine could have used.
    for (const u of all) {
      if (u.gpaSource === "estimated-admit") expect(u.avgSAT, u.name).toBeNull();
      if (u.gpaSource === "estimated-sat") expect(u.avgSAT, u.name).not.toBeNull();
    }
  });

  it("covers California, including the test-blind systems", () => {
    // The regression this guards: requiring an SAT average silently excluded
    // every UC and CSU campus, because California reports none.
    const ca = all.filter((u) => u.state === "CA");
    expect(ca.length).toBeGreaterThan(40);
    for (const name of ["University of California-Davis", "California Institute of Technology"]) {
      expect(all.map((u) => u.name)).toContain(name);
    }
  });

  it("uses only the four known regions", () => {
    for (const u of all) expect(["Northeast", "Midwest", "South", "West"]).toContain(u.region);
  });
});

describe("estimateGpaFromAdmitRate", () => {
  it("falls as admission gets easier", () => {
    let prev = Infinity;
    for (let a = 1; a <= 100; a++) {
      const g = estimateGpaFromAdmitRate(a);
      expect(g).toBeLessThanOrEqual(prev);
      prev = g;
    }
  });

  it("clamps at both ends", () => {
    const first = ADMIT_GPA_ANCHORS.at(0);
    const last = ADMIT_GPA_ANCHORS.at(-1);
    expect(estimateGpaFromAdmitRate(0)).toBe(first![1]);
    expect(estimateGpaFromAdmitRate(100)).toBe(last![1]);
  });

  it("does not disagree with the SAT curve at the population level", () => {
    // These anchors are calibrated on the SAT-derived population precisely so a
    // test-blind school lands where a comparable SAT-reporting one would. If the
    // two drift apart, a school's GPA starts depending on whether it happens to
    // report SAT, which is an artefact of our pipeline rather than a fact.
    const satSchools = (universities as any[]).filter((u) => u.gpaSource === "estimated-sat");
    const errors = satSchools.map((u) => estimateGpaFromAdmitRate(u.acceptanceRate) - u.avgGPA);
    const bias = errors.reduce((a, b) => a + b, 0) / errors.length;
    expect(Math.abs(bias)).toBeLessThan(0.08);
  });

  it("is a rougher estimate than the SAT curve, as documented", () => {
    const satSchools = (universities as any[]).filter((u) => u.gpaSource === "estimated-sat");
    const rmse = Math.sqrt(
      satSchools.reduce(
        (a, u) => a + (estimateGpaFromAdmitRate(u.acceptanceRate) - u.avgGPA) ** 2,
        0
      ) / satSchools.length
    );
    expect(rmse).toBeGreaterThan(0.12);
    expect(rmse).toBeLessThan(0.3);
  });
});
