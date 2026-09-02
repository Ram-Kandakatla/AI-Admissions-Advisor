// Shared types for the Compass API.
//
// The domain shapes here are the JSON the client already consumes — they were
// implicit in the old JavaScript and are written down now because the sync→async
// D1 rewrite touches every one of them, and a mistyped column is the failure
// this migration is most likely to produce.

/**
 * The Worker's bindings and configuration.
 *
 * On Express these were all `process.env` reads resolved once at module load.
 * A Worker gets this object handed to it per request instead, which is the
 * reason `dataStore` and `llmService` became factories rather than modules
 * holding state.
 */
export interface Env {
  /** D1 binding, declared in wrangler.toml. */
  DB: D1Database;
  /** Comma-separated browser origins allowed to call this API. */
  CORS_ORIGIN?: string;
  /** Set as a secret. Absent = the chatbot runs its offline fallback. */
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  OPENAI_MODEL?: string;
}

/**
 * Hono's generic slot: `Bindings` types `c.env`, `Variables` types the
 * per-request values the wiring middleware puts on the context. Declaring
 * them here is what makes `c.get("store")` a typed Store rather than unknown.
 *
 * The two imports below are circular on paper — those modules import this one —
 * but they are type-only, so they vanish at build time and nothing cycles at
 * runtime.
 */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    store: import("./store/dataStore.js").Store;
    llm: import("./services/llmService.js").LlmService;
    /** Set by requireStudent; only present on routes behind it. */
    student: StudentRecord;
    /**
     * The caller's session, resolved from the cookie on every request.
     * Null when there is no cookie or it names an expired/deleted session —
     * which is the normal state for a first-time visitor, not an error.
     */
    session: SessionRecord | null;
  };
};

// ---- Reference data (data/*.json) ----

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
  setting: string;
  type: string;
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

/**
 * An account.
 *
 * `email` is null for a guest — see migrations/0003_auth.sql for why guests
 * get a row here at all rather than a separate anonymous identity. `guest` is
 * derived from that rather than stored, so the two can never disagree.
 */
export interface UserRecord {
  id: number;
  email: string | null;
  guest: boolean;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  userId: number;
  expiresAt: string;
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
  createdAt: string;
  updatedAt?: string;
}

export type Tier = "reach" | "target" | "safety";

/** The three-bucket shape both recommendation engines return. */
export type Tiered<T> = Record<Tier, T[]>;
