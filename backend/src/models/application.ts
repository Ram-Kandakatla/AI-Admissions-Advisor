// Application tracker shape + validation/normalization helpers.
//
// IMPORTANT — on deadlines:
// data/universities.json carries no per-school deadline dates, and we
// deliberately do not invent them. Publishing a made-up date for a real
// university in a tool students plan around is the one failure mode that
// actually costs someone an application. Instead we seed each application
// with the *convention* for its decision plan (ED/EA land on Nov 1, RD on
// Jan 1, and so on) flagged `deadlineIsTypical: true`. The UI labels those
// as unconfirmed until the student replaces them with the real date off the
// school's admissions page, which flips the flag to false.

import type { ApplicationInput, Checklist } from "../types.js";

export interface DecisionPlan {
  label: string;
  binding: boolean;
  typical: { month: number; day: number; offsetYears: number } | null;
  note: string;
}

export const DECISION_PLANS: Record<string, DecisionPlan> = {
  ED: {
    label: "Early Decision",
    binding: true,
    // month is 1-indexed here for readability; offsetYears is relative to the
    // cycle start (the autumn the student submits).
    typical: { month: 11, day: 1, offsetYears: 0 },
    note: "Binding — if admitted you must enroll and withdraw other applications.",
  },
  ED2: {
    label: "Early Decision II",
    binding: true,
    typical: { month: 1, day: 1, offsetYears: 1 },
    note: "Binding, with a later deadline than ED I. Often early-to-mid January.",
  },
  EA: {
    label: "Early Action",
    binding: false,
    typical: { month: 11, day: 1, offsetYears: 0 },
    note: "Non-binding — you get an early answer and can still compare offers.",
  },
  REA: {
    label: "Restrictive Early Action",
    binding: false,
    typical: { month: 11, day: 1, offsetYears: 0 },
    note: "Non-binding, but usually bars you from applying early elsewhere.",
  },
  RD: {
    label: "Regular Decision",
    binding: false,
    typical: { month: 1, day: 1, offsetYears: 1 },
    note: "The standard deadline. Commonly Jan 1, but Jan 5 and Jan 15 are widespread.",
  },
  PRIORITY: {
    label: "Priority",
    binding: false,
    typical: { month: 12, day: 1, offsetYears: 0 },
    note: "Not a hard cutoff — applying by it improves aid and housing odds.",
  },
  ROLLING: {
    label: "Rolling",
    binding: false,
    typical: null,
    note: "No fixed date — reviewed as they arrive, so earlier is genuinely better.",
  },
};

export const STATUSES = [
  "planning",
  "in-progress",
  "submitted",
  "accepted",
  "waitlisted",
  "denied",
  "withdrawn",
];

// The tasks common to essentially every US application. Kept generic on
// purpose — school-specific requirements vary too much to hard-code.
export const CHECKLIST = [
  { key: "essay", label: "Personal essay" },
  { key: "supplements", label: "Supplemental essays" },
  { key: "recommendations", label: "Recommendation letters" },
  { key: "transcript", label: "Transcript sent" },
  { key: "testScores", label: "Test scores sent" },
  { key: "fee", label: "Fee paid or waived" },
  { key: "aid", label: "Financial aid forms" },
];

export const CHECKLIST_KEYS = CHECKLIST.map((c) => c.key);

/**
 * Which application cycle are we in? A cycle is named for the autumn the
 * student submits: applying in Nov 2026 for entry in Sep 2027 is the "2026"
 * cycle. July is the changeover — by then the previous cycle's decisions are
 * long settled and rising seniors are starting their lists.
 */
export function currentCycleYear(now: Date = new Date()): number {
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

/**
 * The conventional deadline for a plan, as a plain YYYY-MM-DD string.
 * Date-only strings dodge the timezone trap where a UTC-midnight Date
 * renders as the previous day for anyone west of Greenwich.
 */
export function typicalDeadline(
  plan: string,
  cycleYear: number = currentCycleYear()
): string | null {
  const spec = DECISION_PLANS[plan];
  if (!spec || !spec.typical) return null;
  const { month, day, offsetYears } = spec.typical;
  const year = cycleYear + offsetYears;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isDateString(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Round-trip through UTC to reject things like 2026-02-30.
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export function emptyChecklist(): Checklist {
  return CHECKLIST_KEYS.reduce<Checklist>((acc, key) => ({ ...acc, [key]: false }), {});
}

export function normalizeChecklist(value: unknown): Checklist {
  const checklist = emptyChecklist();
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    for (const key of CHECKLIST_KEYS) {
      if (typeof source[key] === "boolean") checklist[key] = source[key];
    }
  }
  return checklist;
}

export interface ApplicationValidation {
  valid: boolean;
  errors: string[];
  application: ApplicationInput;
}

/**
 * Validate an incoming application payload.
 * `universityIds` is the set of ids that actually exist, so we reject
 * applications pointing at schools not in the dataset.
 */
export function validateApplication(
  payload: unknown = {},
  universityIds: Set<number> | null = null
): ApplicationValidation {
  const body = (payload ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  const application: Partial<ApplicationInput> = {};

  const universityId = Number(body.universityId);
  if (!Number.isInteger(universityId)) {
    errors.push("universityId must be an integer");
  } else if (universityIds && !universityIds.has(universityId)) {
    errors.push("universityId does not match a known university");
  } else {
    application.universityId = universityId;
  }

  const plan = typeof body.plan === "string" ? body.plan.toUpperCase() : "RD";
  if (!DECISION_PLANS[plan]) {
    errors.push(`plan must be one of: ${Object.keys(DECISION_PLANS).join(", ")}`);
  } else {
    application.plan = plan;
  }

  const status = typeof body.status === "string" ? body.status : "planning";
  if (!STATUSES.includes(status)) {
    errors.push(`status must be one of: ${STATUSES.join(", ")}`);
  } else {
    application.status = status;
  }

  // A deadline the student typed in is theirs — we keep it and stop calling
  // the date typical. Omitting it falls back to the plan's convention.
  if (body.deadline === null || body.deadline === undefined || body.deadline === "") {
    application.deadline = application.plan ? typicalDeadline(application.plan) : null;
    application.deadlineIsTypical = application.deadline !== null;
  } else if (!isDateString(body.deadline)) {
    errors.push("deadline must be a YYYY-MM-DD date");
  } else {
    application.deadline = body.deadline;
    application.deadlineIsTypical = false;
  }

  application.checklist = normalizeChecklist(body.checklist);
  application.notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 1000) : "";

  return {
    valid: errors.length === 0,
    errors,
    application: application as ApplicationInput,
  };
}
