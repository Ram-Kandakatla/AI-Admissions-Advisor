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
