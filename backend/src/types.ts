/** The Worker's bindings, handed over per request. */
export interface Env {
  DB: D1Database;
  /** Comma-separated browser origins allowed to call this API. */
  CORS_ORIGIN?: string;
  /** debug | info | warn | error | silent; validated by resolveLevel in log.ts. */
  LOG_LEVEL?: string;
  /** Absent = the chatbot runs its offline fallback. */
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  OPENAI_MODEL?: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    store: import("./store/dataStore.js").Store;
    llm: import("./services/llmService.js").LlmService;
    /** Set by requireOwner; only present on routes behind it. */
    student: StudentRecord;
    /** Null for a visitor with no (live) session cookie; not an error. */
    session: SessionRecord | null;
  };
};

// ---- Reference data (data/*.json) ----

export interface University {
  id: number;
  name: string;
  shortName: string;
  avgGPA: number;
  /** Null means test-blind, not missing data. Skip it; never coerce to 0. */
  avgSAT: number | null;
  majors: string[];
  acceptanceRate: number;
  tuition: number;
  region: string;
  city: string;
  state: string;
  setting: string;
  type: string;
  /** College Scorecard id; the importer matches on it so re-imports keep ids stable. */
  unitid?: number;
  /**
   * No federal dataset publishes admit GPA, so most are estimated:
   * "estimated-sat" from the SAT average (RMSE 0.090), "estimated-profile"
   * from admission rate plus first-year retention for test-blind schools.
   * The UI labels estimates so they don't read as reported figures.
   */
  gpaSource?: "curated" | "estimated-sat" | "estimated-profile";
  /** avgSAT counts submitters only, so it overstates a test-optional class. */
  testPolicy?: "required" | "recommended" | "optional" | "not-used" | null;
  enrollment?: number;
}

export interface ScholarshipAward {
  min: number;
  max: number;
  term: string;
  renewable: boolean;
}

export interface Scholarship {
  id: string;
  name: string;
  sponsor: string;
  url: string;
  summary: string;
  award: ScholarshipAward;
  awardsPerYear: number | null;
  minGPA: number | null;
  minSAT?: number | null;
  need: string;
  maxHouseholdIncome: number | null;
  citizenship: string;
  forMajors: string[];
  audience: string[];
  effort: string;
  competitiveness: string;
  deadlineMonth: number | null;
  deadlineNote: string;
  tags: string[];
}

// ---- Student data (D1) ----

export type FinancialNeed = "high" | "medium" | "low";

export interface StudentProfile {
  name: string;
  gpa: number;
  satScore: number | null;
  actScore: number | null;
  interestedMajors: string[];
  extracurriculars: string[];
  careerGoals: string;
  financialNeed: FinancialNeed;
  preferredRegions: string[];
}

export interface StudentRecord extends StudentProfile {
  id: string;
  createdAt: string;
  updatedAt?: string;
}

/** `email` is null for a guest; `guest` is derived from it, never stored. */
export interface UserRecord {
  id: number;
  email: string | null;
  guest: boolean;
  createdAt: string;
  /**
   * Never the secret itself: /auth/me sends this record to the browser. False
   * until enrollment is confirmed with a code.
   */
  twoFactorEnabled: boolean;
}

export interface SessionRecord {
  id: string;
  userId: number;
  expiresAt: string;
}

/**
 * The token is a bearer credential for the read-only view. Revoking deletes
 * the row, so "revoked" and "never existed" are indistinguishable.
 */
export interface ShareLinkRecord {
  token: string;
  studentId: string;
  createdAt: string;
}

export interface ChatMessage {
  role: string;
  content: string;
  at: string;
}

export type Checklist = Record<string, boolean>;

export interface ApplicationInput {
  universityId: number;
  plan: string;
  status: string;
  deadline: string | null;
  deadlineIsTypical: boolean;
  checklist: Checklist;
  notes: string;
}

export interface ApplicationRecord extends ApplicationInput {
  id: string;
  studentId: string;
  createdAt: string;
  updatedAt?: string;
}

export interface SchoolNoteRecord {
  universityId: number;
  starred: boolean;
  note: string;
  /** "" for not recorded. Name and role only; see migration 0005 for why. */
  contactName: string;
  contactRole: string;
  /** YYYY-MM-DD or "". Never pass to `new Date()`; see frontend/src/dates.ts. */
  contactLastAt: string;
  createdAt: string;
  updatedAt?: string;
}

export type Tier = "reach" | "target" | "safety";

export type Tiered<T> = Record<Tier, T[]>;
