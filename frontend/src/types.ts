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

export type LlmProvider = "claude" | "openai" | "fallback";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  source?: LlmProvider;
}
