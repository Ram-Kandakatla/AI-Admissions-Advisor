import { describe, expect, it } from "vitest";
import { majorFromSlug, slugifyMajor } from "./slug";

describe("slugifyMajor", () => {
  it("lowercases and hyphenates a plain name", () => {
    expect(slugifyMajor("Computer Science")).toBe("computer-science");
  });

  it("collapses a run of punctuation into one hyphen", () => {
    // The real catalog has names like these, and "business---economics" would
    // be a URL that works but reads like a bug.
    expect(slugifyMajor("Business / Economics")).toBe("business-economics");
    expect(slugifyMajor("Pre-Med (Biology)")).toBe("pre-med-biology");
  });

  it("does not leave a leading or trailing hyphen", () => {
    expect(slugifyMajor("  Nursing  ")).toBe("nursing");
    expect(slugifyMajor("&Design&")).toBe("design");
  });

  it("keeps digits", () => {
    expect(slugifyMajor("Studio Art 2D")).toBe("studio-art-2d");
  });
});

describe("majorFromSlug", () => {
  const catalog = ["Computer Science", "Business / Economics", "Nursing"];

  it("finds the original name behind a slug", () => {
    expect(majorFromSlug("computer-science", catalog)).toBe("Computer Science");
  });

  it("round-trips every name in a catalog", () => {
    // The whole scheme rests on this: slugify is lossy, so the only guarantee
    // worth having is that a slug made from a name resolves back to it.
    for (const name of catalog) {
      expect(majorFromSlug(slugifyMajor(name), catalog)).toBe(name);
    }
  });

  it("tolerates a slug that is already differently cased or spaced", () => {
    expect(majorFromSlug("Computer%20Science".replace("%20", " "), catalog)).toBe(
      "Computer Science"
    );
  });

  it("returns null for a slug nothing matches", () => {
    // Not an error: the caller falls back to its default, so a mistyped URL
    // shows the page rather than a dead end.
    expect(majorFromSlug("underwater-basket-weaving", catalog)).toBeNull();
  });

  it("returns null against an empty catalog", () => {
    expect(majorFromSlug("nursing", [])).toBeNull();
  });
});
