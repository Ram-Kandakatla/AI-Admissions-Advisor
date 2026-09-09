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
  /**
   * Lowest level that reaches the log: debug | info | warn | error | silent.
   * Unset or unrecognised means "info". Typed as a plain string because that
   * is what a wrangler var is — see resolveLevel() in src/log.ts, which is
   * where the value is actually validated.
   */
  LOG_LEVEL?: string;
  /** Set as a secret. Absent = the chatbot runs its offline fallback. */
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  OPENAI_MODEL?: string;
  /**
   * Resend credentials, both set as secrets. Absent = password reset reports
   * itself unavailable rather than silently failing to deliver.
   */
  RESEND_API_KEY?: string;
  /** The From address, e.g. "Compass <noreply@yourdomain>". Must be a sender
   *  Resend has verified for your domain, or every send is rejected. */
  EMAIL_FROM?: string;
  /**
   * Origin the reset link points at, e.g. "https://compass.example.com". The
   * API has no reliable way to know the origin the *frontend* is served from —
   * the Origin header is absent on some requests and attacker-controlled on
   * others, and building a password-reset URL out of either is how host-header
   * poisoning turns a reset into an account takeover. So it is configuration.
   */
  APP_ORIGIN?: string;
  /**
   * Development escape hatch: writes the reset link to the log so the flow can
   * be exercised with no email provider. NEVER set this in production — a
   * reset link in a log is a valid credential sitting in Cloudflare's log
   * retention. Off unless it is exactly the string "true".
   */
  DEV_LOG_RESET_LINKS?: string;
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
  /**
   * Whether a second factor is switched on and confirmed.
   *
   * A boolean, never the secret. This record is what /auth/me returns, so
   * anything on it reaches the browser — and the secret is the second factor,
   * not a description of it. A half-finished enrollment (secret generated, no
   * code verified yet) reports false here, because from every caller's point
   * of view it is not on.
   */
  twoFactorEnabled: boolean;
}

export interface SessionRecord {
  id: string;
  userId: number;
  expiresAt: string;
}

/**
 * A read-only link to one student's plan.
 *
 * The token is a bearer credential: whoever holds the URL can read the shared
 * view, with no account and no sign-in. There is no expiry and no revoked
 * flag — revoking deletes the row, so "revoked" and "never existed" are one
 * state the server could not tell apart even if a future handler wanted to.
 * See migrations/0006_share_links.sql.
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
  /**
   * The admissions officer handling this school, if the student knows who.
   *
   * Empty string rather than null for "not recorded", so there is one absent
   * value rather than two. Deliberately only a name and a job title — see
   * migrations/0005_school_contacts.sql for why there is no email or phone.
   */
  contactName: string;
  contactRole: string;
  /**
   * When the student last spoke to them: YYYY-MM-DD, or "" for never.
   *
   * The field that makes this a tracker rather than an address book — "you
   * have not contacted this school since August" is the thing worth knowing.
   * Date-only because that is the granularity a student remembers; see
   * frontend/src/dates.ts for why it must never meet `new Date(iso)`.
   */
  contactLastAt: string;
  createdAt: string;
  updatedAt?: string;
}

export type Tier = "reach" | "target" | "safety";

/** The three-bucket shape both recommendation engines return. */
export type Tiered<T> = Record<Tier, T[]>;
