// Reference data — universities and scholarships.
//
// The Express build read these off disk with `fs.readFileSync` and memoized
// the result. A Worker has no filesystem, so they are imported as modules
// instead: Wrangler inlines the JSON into the bundle at build time, which
// makes the read free at runtime and removes the cache these functions used
// to need.
//
// This is also why the engines take their data as a parameter with a default
// rather than reaching into the store — nothing here touches D1, so the
// scoring logic stays synchronous and directly testable.

import universitiesJson from "../../data/universities.json";
import scholarshipsJson from "../../data/scholarships.json";
import type { Scholarship, University } from "../types.js";

const universities = universitiesJson as University[];

// The scholarship file wraps its array in an object so it can carry the note
// about where the data came from — JSON has nowhere else to put a comment.
const scholarships = (scholarshipsJson as { scholarships: Scholarship[] }).scholarships;

export function loadUniversities(): University[] {
  return universities;
}

export function loadScholarships(): Scholarship[] {
  return scholarships;
}

/** Universities keyed by id, for the joins the API does on the way out. */
export function universityIndex(): Map<number, University> {
  return new Map(universities.map((u) => [u.id, u]));
}

// Built once: the dataset is part of the bundle, so the set cannot change
// while an isolate is alive.
const majors = new Set(universities.flatMap((u) => u.majors));

/**
 * Every major some school in the dataset offers.
 *
 * The profile form only ever offers these (it reads them from /api/meta), and
 * validateProfile uses the same set to refuse anything else — a major no school
 * here teaches matches nothing, and an unbounded free-text list was the one
 * profile field that flowed uncapped into the chatbot's prompt.
 */
export function knownMajors(): ReadonlySet<string> {
  return majors;
}
