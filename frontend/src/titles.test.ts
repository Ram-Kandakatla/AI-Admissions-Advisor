import { describe, expect, it } from "vitest";
import { titleFor } from "./titles";

describe("titleFor", () => {
  it("introduces the app on the homepage", () => {
    expect(titleFor("/")).toBe("Compass — College Admissions Advisor");
  });

  it("leads with the distinguishing word, not the brand", () => {
    // A narrow tab truncates from the right, so "Your matches — Comp…" still
    // says which tab it is and "Compass — Your ma…" does not.
    expect(titleFor("/matches")).toBe("Your matches — Compass");
    expect(titleFor("/tracker")).toBe("Application tracker — Compass");
  });

  it("names the major on a deep link", () => {
    // Three open major tabs all reading "Majors" is the exact problem
    // per-route titles exist to solve.
    expect(titleFor("/majors/computer-science")).toBe("Computer Science — Compass");
    expect(titleFor("/majors/nursing")).toBe("Nursing — Compass");
  });

  it("falls back to the section for the bare majors path", () => {
    expect(titleFor("/majors")).toBe("Majors — Compass");
  });

  it("does not append the brand where the page name already carries it", () => {
    expect(titleFor("/chat")).toBe("Ask Compass");
  });

  it("gives an unknown path the 404's title", () => {
    expect(titleFor("/nope")).toBe("Page not found — Compass");
    // Including one that only looks like a major route.
    expect(titleFor("/majors/")).toBe("Page not found — Compass");
  });

  it("covers every path in the nav", () => {
    // The list here is the nav's, written out by hand on purpose: importing it
    // would let both drift together and still pass. Adding a destination
    // should fail this until its title exists.
    const destinations = [
      "/",
      "/profile",
      "/matches",
      "/scholarships",
      "/saved",
      "/tracker",
      "/timeline",
      "/compare",
      "/majors",
      "/explore",
      "/chat",
      "/signin",
      "/signup",
    ];
    for (const path of destinations) {
      expect(titleFor(path), path).not.toBe("Page not found — Compass");
    }
  });
});
