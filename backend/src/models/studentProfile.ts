// Profile validation. List fields are capped and de-duplicated: guests can
// write profiles with no account, and interestedMajors goes into the chatbot
// prompt, which is billed per token.

import { knownMajors } from "../store/staticData.js";
import type { FinancialNeed, StudentProfile } from "../types.js";

export const FINANCIAL_NEED: FinancialNeed[] = ["high", "medium", "low"];

export const REGIONS = ["Northeast", "South", "Midwest", "West"];

/** ProfileForm enforces the same limits, so nothing typed is silently dropped. */
export const MAX_ACTIVITIES = 30;
export const MAX_ACTIVITY_LENGTH = 100;

export interface ProfileValidation {
  valid: boolean;
  errors: string[];
  profile: StudentProfile;
}

/** `majors` is a parameter only so tests can pass a fixture. */
export function validateProfile(
  payload: unknown = {},
  majors: ReadonlySet<string> = knownMajors()
): ProfileValidation {
  const body = (payload ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  const profile: Partial<StudentProfile> = {};

  if (typeof body.name !== "string" || body.name.trim() === "") {
    errors.push("name is required");
  } else {
    profile.name = body.name.trim().slice(0, 80);
  }

  // Up to 5.0 to allow weighted scales.
  const gpa = Number(body.gpa);
  if (Number.isNaN(gpa) || gpa < 0 || gpa > 5) {
    errors.push("gpa must be a number between 0 and 5.0");
  } else {
    profile.gpa = gpa;
  }

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

  // De-duplicated, or thousands of copies of one valid major would pass.
  const interestedMajors = unique(toStringArray(body.interestedMajors)).filter((m) =>
    majors.has(m)
  );
  if (interestedMajors.length === 0) {
    errors.push("interestedMajors must include at least one major");
  }
  profile.interestedMajors = interestedMajors;

  profile.extracurriculars = unique(
    toStringArray(body.extracurriculars).map((e) => e.slice(0, MAX_ACTIVITY_LENGTH).trim())
  ).slice(0, MAX_ACTIVITIES);

  profile.careerGoals =
    typeof body.careerGoals === "string" ? body.careerGoals.trim().slice(0, 500) : "";

  profile.financialNeed = FINANCIAL_NEED.includes(body.financialNeed as FinancialNeed)
    ? (body.financialNeed as FinancialNeed)
    : "medium";

  profile.preferredRegions = unique(toStringArray(body.preferredRegions)).filter((r) =>
    REGIONS.includes(r)
  );

  return {
    valid: errors.length === 0,
    errors,
    profile: profile as StudentProfile,
  };
}

/** First occurrence wins, so the order the student chose is kept. */
function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}
