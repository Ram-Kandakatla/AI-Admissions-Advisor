import { describe, expect, it } from "vitest";
import {
  formatLegalDate,
  isUnfilled,
  LEGAL_EFFECTIVE,
  LEGAL_UPDATED,
  PLACEHOLDERS,
  REPO_URL,
  SECURITY_ADVISORY_URL,
} from "./legal";

describe("placeholders", () => {
  it("marks a value nobody has filled in", () => {
    expect(isUnfilled("[YOUR STATE, COUNTRY]")).toBe(true);
    expect(isUnfilled("California, United States")).toBe(false);
  });

  it("does not treat a bracket in ordinary prose as a placeholder", () => {
    // Only a value that is bracketed end to end counts. A sentence that
    // happens to contain brackets is not an unfilled field.
    expect(isUnfilled("see section [4] below")).toBe(false);
  });

  /**
   * The deploy checklist, as a test.
   *
   * It asserts the *shape* rather than the values, so it keeps passing once
   * they are filled in — a test that failed until launch would be commented
   * out within a week and would then be protecting nothing. What it actually
   * pins is that every operator-specific value goes through the placeholder
   * convention, so `<Unfilled>` can highlight it and this list stays the one
   * place to look before a deploy.
   */
  it("routes every operator-specific value through the convention", () => {
    for (const [name, value] of Object.entries(PLACEHOLDERS)) {
      expect(typeof value, name).toBe("string");
      expect(value.length, name).toBeGreaterThan(0);
    }
  });

  it("still has these three unfilled, which is the pre-deploy state", () => {
    // Written as a deliberate snapshot of "not launched yet". When these are
    // filled in, this expectation flips to false and the failure is the
    // reminder to delete this test — at which point the placeholder machinery
    // has done its job and can go too.
    const unfilled = Object.entries(PLACEHOLDERS)
      .filter(([, v]) => isUnfilled(v))
      .map(([k]) => k);
    expect(unfilled).toEqual(["OPERATOR_NAME", "GOVERNING_LAW", "CONTACT_EMAIL"]);
  });
});

describe("dates", () => {
  it("renders a bare ISO date as the day it actually names", () => {
    // The bug this guards against: `new Date("2026-09-07")` parses as UTC
    // midnight, so anywhere west of Greenwich it renders as September 6 — a
    // legal document quietly dated a day early. The suite runs in New York
    // (see vitest.config.ts) precisely so this is observable.
    expect(formatLegalDate("2026-09-07")).toBe("September 7, 2026");
    expect(formatLegalDate("2026-01-01")).toBe("January 1, 2026");
  });

  it("keeps the documents' dates well-formed", () => {
    expect(LEGAL_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(LEGAL_EFFECTIVE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Terms cannot take effect after they were last written.
    expect(LEGAL_EFFECTIVE <= LEGAL_UPDATED).toBe(true);
  });
});

describe("links", () => {
  it("points the security report at private advisories on the real repo", () => {
    // A disclosure page whose only channel 404s is worse than none at all.
    expect(SECURITY_ADVISORY_URL.startsWith(REPO_URL)).toBe(true);
    expect(SECURITY_ADVISORY_URL).toContain("/security/advisories/new");
  });

  it("uses https everywhere", () => {
    expect(REPO_URL.startsWith("https://")).toBe(true);
  });
});
