// Student profile shape + validation/normalization helpers.
//
// Pure logic, no I/O — unchanged from the Express build apart from types.

import type { FinancialNeed, StudentProfile } from "../types.js";

export const FINANCIAL_NEED: FinancialNeed[] = ["high", "medium", "low"];

export const REGIONS = ["Northeast", "South", "Midwest", "West"];

export interface ProfileValidation {
  valid: boolean;
  errors: string[];
  profile: StudentProfile;
}

/**
 * Validate and normalize an incoming profile payload.
 * Returns { valid, errors, profile } where `profile` holds cleaned values.
 */
export function validateProfile(payload: unknown = {}): ProfileValidation {
  const body = (payload ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  const profile: Partial<StudentProfile> = {};

  // Name — required, non-empty string
  if (typeof body.name !== "string" || body.name.trim() === "") {
    errors.push("name is required");
  } else {
    profile.name = body.name.trim().slice(0, 80);
  }

  // GPA — required, 0-4.0 (we allow a little headroom for weighted scales)
  const gpa = Number(body.gpa);
  if (Number.isNaN(gpa) || gpa < 0 || gpa > 5) {
    errors.push("gpa must be a number between 0 and 5.0");
  } else {
    profile.gpa = gpa;
  }

  // SAT — optional, 400-1600
  if (body.satScore !== undefined && body.satScore !== null && body.satScore !== "") {
    const sat = Number(body.satScore);
    if (Number.isNaN(sat) || sat < 400 || sat > 1600) {
      errors.push("satScore must be between 400 and 1600");
    } else {
      profile.satScore = sat;
    }
  } else {
    profile.satScore = null;
  }

  // ACT — optional, 1-36
  if (body.actScore !== undefined && body.actScore !== null && body.actScore !== "") {
    const act = Number(body.actScore);
    if (Number.isNaN(act) || act < 1 || act > 36) {
      errors.push("actScore must be between 1 and 36");
    } else {
      profile.actScore = act;
    }
  } else {
    profile.actScore = null;
  }

  // Interested majors — required, at least one
  const majors = toStringArray(body.interestedMajors);
  if (majors.length === 0) {
    errors.push("interestedMajors must include at least one major");
  }
  profile.interestedMajors = majors;

  // Extracurriculars — optional
  profile.extracurriculars = toStringArray(body.extracurriculars);

  // Career goals — optional free text
  profile.careerGoals =
    typeof body.careerGoals === "string" ? body.careerGoals.trim().slice(0, 500) : "";

  // Financial need — defaults to medium
  profile.financialNeed = FINANCIAL_NEED.includes(body.financialNeed as FinancialNeed)
    ? (body.financialNeed as FinancialNeed)
    : "medium";

  // Preferred regions — optional, validated against known regions
  profile.preferredRegions = toStringArray(body.preferredRegions).filter((r) =>
    REGIONS.includes(r)
  );

  return {
    valid: errors.length === 0,
    errors,
    profile: profile as StudentProfile,
  };
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim() !== "") {
    // Accept comma-separated strings too
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}
