// Universities and scholarships, bundled as JSON (a Worker has no filesystem).
// Kept out of D1 so the scoring engines stay synchronous and easy to test.

import universitiesJson from "../../data/universities.json";
import scholarshipsJson from "../../data/scholarships.json";
import type { Scholarship, University } from "../types.js";

const universities = universitiesJson as University[];

// Wrapped in an object so the file can carry a note on where the data came from.
const scholarships = (scholarshipsJson as { scholarships: Scholarship[] }).scholarships;

export function loadUniversities(): University[] {
  return universities;
}

export function loadScholarships(): Scholarship[] {
  return scholarships;
}

export function universityIndex(): Map<number, University> {
  return new Map(universities.map((u) => [u.id, u]));
}

const majors = new Set(universities.flatMap((u) => u.majors));

/**
 * The profile form's options and validateProfile's allowlist. Free-text majors
 * would flow uncapped into the chatbot prompt.
 */
export function knownMajors(): ReadonlySet<string> {
  return majors;
}
