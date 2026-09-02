export type FinancialNeed = "high" | "medium" | "low";

export interface ProfileInput {
  name: string;
  gpa: number | "";
  satScore: number | "";
  actScore: number | "";
  interestedMajors: string[];
  extracurriculars: string[];
  careerGoals: string;
  financialNeed: FinancialNeed;
  preferredRegions: string[];
}

export interface StudentRecord extends Omit<ProfileInput, "gpa" | "satScore" | "actScore"> {
  id: string;
  gpa: number;
  satScore: number | null;
  actScore: number | null;
  createdAt: string;
}

/**
 * The signed-in account, or the anonymous one standing in for it.
 *
 * A guest is a real account server-side with no email or password yet — which
 * is what lets a profile built before signing up simply carry over rather than
 * being migrated. `guest` is the flag the UI branches on.
 */
export interface AuthUser {
  id: number;
  email: string | null;
  guest: boolean;
  createdAt: string;
}

export interface AuthState {
  user: AuthUser | null;
  studentId: string | null;
}

export interface University {
  id: number;
  name: string;
  shortName: string;
  avgGPA: number;
  avgSAT: number;
  majors: string[];
  acceptanceRate: number;
  tuition: number;
  region: string;
  city: string;
  state: string;
  setting?: string;
  type?: string;
}

export type Tier = "reach" | "target" | "safety";

export interface Recommendation extends University {
  tier: Tier;
  matchScore: number;
  matchedMajors: string[];
  gpaGap: number;
  affordable: boolean;
  regionFit: boolean;
  reasons: string[];
}

export interface RecommendationResponse {
  studentId: string;
  counts: Record<Tier, number>;
  recommendations: Record<Tier, Recommendation[]>;
}

export interface Meta {
  majors: string[];
  regions: string[];
  financialNeed: FinancialNeed[];
}

// ---- Major deep dive ----

export interface Spread {
  min: number;
  median: number;
  max: number;
}

export interface MajorSchool {
  id: number;
  name: string;
  shortName: string;
  city: string;
  state: string;
  region: string;
  setting: string;
  type: string;
  avgGPA: number;
  avgSAT: number;
  acceptanceRate: number;
  tuition: number;
  /** Which of the student's other intended majors this school also offers. */
  alsoCovers: string[];
  tier: Tier | null;
}

export interface MajorInsights {
  major: string;
  schoolCount: number;
  shareOfDataset: number;
  selectivity: Spread;
  tuition: Spread;
  avgGPA: Spread;
  avgSAT: Spread;
  regions: { key: string; count: number }[];
  settings: { key: string; count: number }[];
  types: { key: string; count: number }[];
  /** Majors commonly offered alongside this one, with the share of schools. */
  adjacent: { key: string; count: number; share: number }[];
  position: {
    tiers: Record<Tier, number>;
    gpa: number;
    medianGPA: number;
    gpaGapToMedian: number;
    satScore: number | null;
    medianSAT: number | null;
    affordable: number;
  } | null;
  combinations: { major: string; count: number; schools: number[] }[] | null;
  researchQuestions: string[];
  schools: MajorSchool[];
}

// ---- School notes ----

export interface SchoolNote {
  universityId: number;
  starred: boolean;
  note: string;
  createdAt?: string;
  updatedAt?: string;
  university: {
    id: number;
    name: string;
    shortName: string;
    city: string;
    state: string;
    region: string;
    acceptanceRate: number;
    tuition: number;
  } | null;
  /** Set when the write emptied and unstarred the note, deleting the record. */
  removed?: boolean;
}

export interface NotesResponse {
  studentId: string;
  notes: SchoolNote[];
}

// ---- Scholarships ----

export type AwardTerm = "total" | "per-year" | "full-ride" | "full-need" | "full-tuition";

export type Competitiveness = "elite" | "high" | "moderate" | "broad" | "entitlement";

export type Effort = "short" | "essay" | "multi-stage";

/** A month/year window, never an asserted date — see scholarshipEngine.js. */
export interface DeadlineWindow {
  month: number | null;
  year: number | null;
  label: string;
  sortKey: string;
  isTypical: true;
  note: string;
}

export interface Scholarship {
  id: string;
  name: string;
  sponsor: string;
  url: string;
  summary: string;
  award: { min: number; max: number; term: AwardTerm; renewable: boolean };
  awardsPerYear: number | null;
  minGPA: number | null;
  minSAT?: number | null;
  need: "required" | "considered" | "none";
  forMajors: string[];
  audience: string[];
  effort: Effort;
  competitiveness: Competitiveness;
  deadlineNote: string;
  tags: string[];
  // Added by the engine:
  tier: Tier;
  matchScore: number;
  matchedMajors: string[];
  gpaHeadroom: number | null;
  expectedValue: number;
  amountLabel: string;
  deadline: DeadlineWindow;
  /** Conditions Compass cannot check against the profile, in plain words. */
  eligibilityToConfirm: string[];
  reasons: string[];
}

export interface ScholarshipResponse {
  studentId: string;
  cycleYear: number;
  counts: Record<Tier, number>;
  scholarships: Record<Tier, Scholarship[]>;
}

// ---- Application tracker ----

export type DecisionPlan = "ED" | "ED2" | "EA" | "REA" | "RD" | "PRIORITY" | "ROLLING";

export type ApplicationStatus =
  | "planning"
  | "in-progress"
  | "submitted"
  | "accepted"
  | "waitlisted"
  | "denied"
  | "withdrawn";

export type ChecklistKey =
  | "essay"
  | "supplements"
  | "recommendations"
  | "transcript"
  | "testScores"
  | "fee"
  | "aid";

export type Checklist = Record<ChecklistKey, boolean>;

export interface Application {
  id: string;
  studentId: string;
  universityId: number;
  plan: DecisionPlan;
  status: ApplicationStatus;
  /** YYYY-MM-DD, or null for rolling admission. */
  deadline: string | null;
  /** True while the date is only the convention for the plan, not the school's own. */
  deadlineIsTypical: boolean;
  checklist: Checklist;
  notes: string;
  createdAt: string;
  updatedAt?: string;
  university: {
    id: number;
    name: string;
    shortName: string;
    city: string;
    state: string;
    acceptanceRate: number;
  } | null;
}

export interface ApplicationsResponse {
  studentId: string;
  cycleYear: number;
  applications: Application[];
}

export interface ApplicationMeta {
  plans: { key: DecisionPlan; label: string; binding: boolean; note: string }[];
  statuses: ApplicationStatus[];
  checklist: { key: ChecklistKey; label: string }[];
  cycleYear: number;
}

export type LlmProvider = "claude" | "openai" | "fallback";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  source?: LlmProvider;
}
