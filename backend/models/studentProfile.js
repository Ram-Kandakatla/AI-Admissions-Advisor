// Student profile shape + validation/normalization helpers.
// Profiles are kept in memory (see store/dataStore.js) for the MVP.

const FINANCIAL_NEED = ["high", "medium", "low"];

const REGIONS = ["Northeast", "South", "Midwest", "West"];

/**
 * Validate and normalize an incoming profile payload.
 * Returns { valid, errors, profile } where `profile` holds cleaned values.
 */
function validateProfile(payload = {}) {
  const errors = [];
  const profile = {};

  // Name — required, non-empty string
  if (typeof payload.name !== "string" || payload.name.trim() === "") {
    errors.push("name is required");
  } else {
    profile.name = payload.name.trim().slice(0, 80);
  }

  // GPA — required, 0-4.0 (we allow a little headroom for weighted scales)
  const gpa = Number(payload.gpa);
  if (Number.isNaN(gpa) || gpa < 0 || gpa > 5) {
    errors.push("gpa must be a number between 0 and 5.0");
  } else {
    profile.gpa = gpa;
  }

  // SAT — optional, 400-1600
  if (payload.satScore !== undefined && payload.satScore !== null && payload.satScore !== "") {
    const sat = Number(payload.satScore);
    if (Number.isNaN(sat) || sat < 400 || sat > 1600) {
      errors.push("satScore must be between 400 and 1600");
    } else {
      profile.satScore = sat;
    }
  } else {
    profile.satScore = null;
  }

  // ACT — optional, 1-36
  if (payload.actScore !== undefined && payload.actScore !== null && payload.actScore !== "") {
    const act = Number(payload.actScore);
    if (Number.isNaN(act) || act < 1 || act > 36) {
      errors.push("actScore must be between 1 and 36");
    } else {
      profile.actScore = act;
    }
  } else {
    profile.actScore = null;
  }

  // Interested majors — required, at least one
  const majors = toStringArray(payload.interestedMajors);
  if (majors.length === 0) {
    errors.push("interestedMajors must include at least one major");
  }
  profile.interestedMajors = majors;

  // Extracurriculars — optional
  profile.extracurriculars = toStringArray(payload.extracurriculars);

  // Career goals — optional free text
  profile.careerGoals =
    typeof payload.careerGoals === "string" ? payload.careerGoals.trim().slice(0, 500) : "";

  // Financial need — defaults to medium
  profile.financialNeed = FINANCIAL_NEED.includes(payload.financialNeed)
    ? payload.financialNeed
    : "medium";

  // Preferred regions — optional, validated against known regions
  profile.preferredRegions = toStringArray(payload.preferredRegions).filter((r) =>
    REGIONS.includes(r)
  );

  return { valid: errors.length === 0, errors, profile };
}

function toStringArray(value) {
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

module.exports = { validateProfile, FINANCIAL_NEED, REGIONS };
