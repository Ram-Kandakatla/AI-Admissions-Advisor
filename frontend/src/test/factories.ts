// Fixture builders for the frontend suite.
//
// Every builder takes a partial override, so a test names only the fields it
// actually asserts on and the rest stay plausible. The alternative — a literal
// per test — makes it impossible to see at a glance which field a test is
// really about, and every added type field breaks a dozen files at once.

import type {
  Application,
  ApplicationMeta,
  Recommendation,
  RecommendationResponse,
  Scholarship,
  ScholarshipResponse,
  SchoolNote,
  StudentRecord,
  Tier,
  University,
} from "../types";

export function university(over: Partial<University> = {}): University {
  return {
    id: 1,
    name: "Coastal State University",
    shortName: "Coastal State",
    avgGPA: 3.6,
    avgSAT: 1320,
    majors: ["CS", "Biology"],
    acceptanceRate: 42,
    tuition: 28_000,
    region: "West",
    city: "Monterey",
    state: "CA",
    setting: "suburban",
    type: "public",
    ...over,
  };
}

export function recommendation(over: Partial<Recommendation> = {}): Recommendation {
  return {
    ...university(),
    tier: "target",
    matchScore: 78,
    matchedMajors: ["CS"],
    gpaGap: 0.2,
    affordable: true,
    regionFit: true,
    reasons: ["Your GPA is above their average"],
    ...over,
  };
}

export function recommendationResponse(
  by: Partial<Record<Tier, Recommendation[]>> = {}
): RecommendationResponse {
  const recommendations = {
    reach: by.reach ?? [],
    target: by.target ?? [],
    safety: by.safety ?? [],
  };
  return {
    studentId: "stu_1",
    counts: {
      reach: recommendations.reach.length,
      target: recommendations.target.length,
      safety: recommendations.safety.length,
    },
    recommendations,
  };
}

export function scholarship(over: Partial<Scholarship> = {}): Scholarship {
  return {
    id: "sch_1",
    name: "Coastal Merit Award",
    sponsor: "Coastal State Foundation",
    url: "https://example.edu/merit",
    summary: "Merit award for incoming first-years.",
    award: { min: 2_000, max: 8_000, term: "per-year", renewable: true },
    awardsPerYear: 40,
    minGPA: 3.4,
    minSAT: null,
    need: "considered",
    forMajors: ["CS"],
    audience: ["first-year"],
    effort: "essay",
    competitiveness: "moderate",
    deadlineNote: "Usually mid-February.",
    tags: ["merit"],
    tier: "target",
    matchScore: 71,
    matchedMajors: ["CS"],
    gpaHeadroom: 0.2,
    expectedValue: 3_200,
    amountLabel: "$2,000–$8,000 per year",
    deadline: {
      month: 2,
      year: 2026,
      label: "February 2026",
      sortKey: "2026-02",
      isTypical: true,
      note: "Typical month for this program; confirm on the official page.",
    },
    eligibilityToConfirm: ["State residency"],
    reasons: ["Your GPA clears the minimum"],
    ...over,
  };
}

export function scholarshipResponse(
  by: Partial<Record<Tier, Scholarship[]>> = {}
): ScholarshipResponse {
  const scholarships = {
    reach: by.reach ?? [],
    target: by.target ?? [],
    safety: by.safety ?? [],
  };
  return {
    studentId: "stu_1",
    cycleYear: 2026,
    counts: {
      reach: scholarships.reach.length,
      target: scholarships.target.length,
      safety: scholarships.safety.length,
    },
    scholarships,
  };
}

export function schoolNote(over: Partial<SchoolNote> = {}): SchoolNote {
  const u = university();
  return {
    universityId: u.id,
    starred: true,
    note: "Visited in October — liked the labs.",
    createdAt: "2026-10-02T14:20:00.000Z",
    updatedAt: "2026-10-09T18:05:00.000Z",
    university: {
      id: u.id,
      name: u.name,
      shortName: u.shortName,
      city: u.city,
      state: u.state,
      region: u.region,
      acceptanceRate: u.acceptanceRate,
      tuition: u.tuition,
    },
    ...over,
  };
}

export function student(over: Partial<StudentRecord> = {}): StudentRecord {
  return {
    id: "stu_1",
    name: "Jordan Rivera",
    gpa: 3.8,
    satScore: 1450,
    actScore: null,
    interestedMajors: ["CS"],
    extracurriculars: ["Robotics captain"],
    careerGoals: "Build medical devices.",
    financialNeed: "medium",
    preferredRegions: ["West"],
    createdAt: "2026-09-01T10:00:00.000Z",
    ...over,
  };
}

export function application(over: Partial<Application> = {}): Application {
  const u = university();
  return {
    id: "app_1",
    studentId: "stu_1",
    universityId: u.id,
    plan: "RD",
    status: "planning",
    deadline: "2027-01-05",
    deadlineIsTypical: true,
    checklist: {
      essay: false,
      supplements: false,
      recommendations: false,
      transcript: false,
      testScores: false,
      fee: false,
      aid: false,
    },
    notes: "",
    createdAt: "2026-09-01T10:00:00.000Z",
    university: {
      id: u.id,
      name: u.name,
      shortName: u.shortName,
      city: u.city,
      state: u.state,
      acceptanceRate: u.acceptanceRate,
    },
    ...over,
  };
}

export function applicationMeta(over: Partial<ApplicationMeta> = {}): ApplicationMeta {
  return {
    plans: [
      { key: "RD", label: "Regular Decision", binding: false, note: "The standard deadline." },
      { key: "EA", label: "Early Action", binding: false, note: "Early, non-binding." },
      { key: "ED", label: "Early Decision", binding: true, note: "Binding if admitted." },
      { key: "ED2", label: "Early Decision II", binding: true, note: "Binding, later round." },
    ],
    statuses: [
      "planning",
      "in-progress",
      "submitted",
      "accepted",
      "waitlisted",
      "denied",
      "withdrawn",
    ],
    checklist: [
      { key: "essay", label: "Personal essay" },
      { key: "supplements", label: "Supplements" },
      { key: "recommendations", label: "Recommendations" },
      { key: "transcript", label: "Transcript" },
      { key: "testScores", label: "Test scores" },
      { key: "fee", label: "Fee or waiver" },
      { key: "aid", label: "Financial aid" },
    ],
    cycleYear: 2026,
    ...over,
  };
}
