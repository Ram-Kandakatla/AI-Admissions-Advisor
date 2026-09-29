import type {
  Application,
  ApplicationMeta,
  ApplicationsResponse,
  AuthState,
  ChatMessage,
  ChatMode,
  LlmProvider,
  LoginResult,
  MajorInsights,
  Meta,
  NotesResponse,
  ProfileInput,
  RecommendationResponse,
  ScholarshipResponse,
  SchoolNote,
  SharedPlan,
  ShareLink,
  SignupResult,
  StudentRecord,
  TwoFactorStatus,
  University,
} from "./types";

/**
 * A failed API call: the server's message, and the status it came with.
 *
 * Still an Error, so every caller that only shows the message is unchanged.
 * The status is for the few that act on the kind of failure — TwoFactorPanel
 * treats a 409 from starting enrollment differently from every other error.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// Every path here is origin-relative, which is what let this file survive
// Phase 7 unchanged. In local development the Vite proxy forwards /api to the
// backend Worker on :8787; deployed, Compass is one Cloudflare Pages origin
// and /api resolves straight to the Function. Same strings either way.

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    // Every route that touches a profile is behind a session cookie.
    // "include" rather than the default "same-origin". Phase 7 chose Option A,
    // one origin, so "same-origin" would now be enough — this is kept because
    // it is also correct under Option A and would be the thing forgotten if the
    // API were ever split onto its own origin. (That split would additionally
    // need SameSite=None on the cookie; the CORS middleware already sends
    // credentials:true.)
    credentials: "include",
    ...options,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body.errors) message = body.errors.join(", ");
      else if (body.error) message = body.error;
    } catch {
      /* ignore parse errors */
    }
    throw new ApiError(message, res.status);
  }
  // DELETE replies 204 with no body — calling .json() on that throws.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  // ---- Accounts ----

  me: () => request<AuthState>("/auth/me"),

  /**
   * Create an account and sign in, on the spot.
   *
   * Fills in the caller's guest row rather than minting a new one, so a
   * profile built anonymously carries straight over — see
   * `discardedGuestProfile` on the result for the one case where it doesn't.
   * A 409 (thrown as an ApiError) means the address already has an account.
   */
  signup: (email: string, password: string) =>
    request<SignupResult>("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  login: (email: string, password: string) =>
    request<LoginResult>(
      "/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) }
    ),

  logout: () => request<void>("/auth/logout", { method: "POST" }),

  // ---- Two-factor ----

  /** Whether it's on, and how many recovery codes are left. */
  twoFactorStatus: () => request<TwoFactorStatus>("/auth/2fa"),

  /**
   * Stage a secret. Nothing is switched on until a code confirms it, which is
   * what stops a mistyped setup key from locking someone out.
   *
   * A 409 means two-factor is already on. Setting it up again then takes a
   * current code as well, which this never sends: the account page's way to a
   * new phone is turning it off and on again.
   */
  startTwoFactor: (password: string) =>
    request<{ secret: string; otpauthUri: string }>("/auth/2fa/setup", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  /** Confirm with a real code. The recovery codes come back exactly once. */
  enableTwoFactor: (code: string) =>
    request<{ enabled: true; recoveryCodes: string[] }>("/auth/2fa/enable", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),

  disableTwoFactor: (password: string, code: string) =>
    request<{ enabled: false }>("/auth/2fa/disable", {
      method: "POST",
      body: JSON.stringify({ password, code }),
    }),

  regenerateRecoveryCodes: (password: string, code: string) =>
    request<{ recoveryCodes: string[] }>("/auth/2fa/recovery-codes", {
      method: "POST",
      body: JSON.stringify({ password, code }),
    }),

  /** The second half of a login, redeeming the challenge from `login`. */
  verifyTwoFactor: (challenge: string, code: string) =>
    request<Extract<LoginResult, { mfaRequired?: false }>>("/auth/2fa/verify", {
      method: "POST",
      body: JSON.stringify({ challenge, code }),
    }),

  /**
   * Erase the account and everything attached to it. There is no undo.
   *
   * `password` is required for a signed-in account and meaningless for a
   * guest, which has none — the caller decides which it is from `user.guest`
   * rather than this function guessing. The confirm phrase is sent by this
   * client rather than surfaced as a parameter: it exists to stop a stray or
   * mis-wired request reaching the one endpoint that destroys data, and a
   * caller who could get it wrong is exactly who it is guarding against.
   */
  deleteAccount: (password?: string) =>
    request<{ deleted: true; hadProfile: boolean }>("/auth/account", {
      method: "DELETE",
      body: JSON.stringify({ confirm: "DELETE", ...(password ? { password } : {}) }),
    }),

  health: () => request<{ status: string; llm: LlmProvider }>("/health"),

  meta: () => request<Meta>("/meta"),

  universities: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request<University[]>(`/universities${qs ? `?${qs}` : ""}`);
  },

  student: (studentId: string) => request<StudentRecord>(`/students/${studentId}`),

  createStudent: (profile: ProfileInput) =>
    request<StudentRecord>("/students", {
      method: "POST",
      body: JSON.stringify(profile),
    }),

  // An account holds one profile, so editing is a PUT to the existing row.
  // Before Phase 2 the form re-POSTed every time and left the old row orphaned
  // — invisible then, because nothing owned rows at all.
  updateStudent: (studentId: string, profile: ProfileInput) =>
    request<StudentRecord>(`/students/${studentId}`, {
      method: "PUT",
      body: JSON.stringify(profile),
    }),

  recommendations: (studentId: string) =>
    request<RecommendationResponse>(`/students/${studentId}/recommendations`),

  scholarships: (studentId: string) =>
    request<ScholarshipResponse>(`/students/${studentId}/scholarships`),

  notes: (studentId: string) => request<NotesResponse>(`/students/${studentId}/notes`),

  // Every field is optional and only what's sent is changed — starring a
  // school from a card must not wipe the note or the contact recorded on it.
  saveNote: (
    studentId: string,
    universityId: number,
    body: {
      starred?: boolean;
      note?: string;
      contactName?: string;
      contactRole?: string;
      contactLastAt?: string;
    }
  ) =>
    request<SchoolNote>(`/students/${studentId}/notes/${universityId}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  forgetNote: (studentId: string, universityId: number) =>
    request<void>(`/students/${studentId}/notes/${universityId}`, { method: "DELETE" }),

  // `mode` picks the assistant: the admissions advisor or the essay
  // brainstorm partner. Omitted means advising, which is what the server
  // defaults to — the two threads are stored separately.
  chat: (question: string, studentId?: string, mode: ChatMode = "advising") =>
    request<{ answer: string; source: LlmProvider; mode: ChatMode }>("/chat", {
      method: "POST",
      body: JSON.stringify({ question, studentId, mode }),
    }),

  chatHistory: (studentId: string, mode: ChatMode = "advising") =>
    request<{ mode: ChatMode; messages: ChatMessage[] }>(
      `/students/${studentId}/chat?mode=${mode}`
    ),

  majors: () => request<{ majors: { major: string; schoolCount: number }[] }>("/majors"),

  majorInsights: (major: string, studentId?: string) =>
    request<MajorInsights>(
      `/majors/${encodeURIComponent(major)}${studentId ? `?studentId=${studentId}` : ""}`
    ),

  applicationMeta: () => request<ApplicationMeta>("/application-meta"),

  // ---- Sharing ----
  //
  // The first three are owner-only. The fourth takes a token instead of a
  // session and is the only call in this file that works signed out.

  shareLink: (studentId: string) =>
    request<{ link: ShareLink | null }>(`/students/${studentId}/share`),

  createShareLink: (studentId: string, rotate = false) =>
    request<{ link: ShareLink }>(`/students/${studentId}/share`, {
      method: "POST",
      body: JSON.stringify({ rotate }),
    }),

  revokeShareLink: (studentId: string) =>
    request<void>(`/students/${studentId}/share`, { method: "DELETE" }),

  sharedPlan: (token: string) =>
    request<SharedPlan>(`/shared/${encodeURIComponent(token)}`),

  applications: (studentId: string) =>
    request<ApplicationsResponse>(`/students/${studentId}/applications`),

  trackApplication: (
    studentId: string,
    body: { universityId: number; plan?: string; deadline?: string | null }
  ) =>
    request<Application>(`/students/${studentId}/applications`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  updateApplication: (
    studentId: string,
    applicationId: string,
    patch: Partial<Pick<Application, "plan" | "status" | "deadline" | "notes">> & {
      checklist?: Partial<Application["checklist"]>;
    }
  ) =>
    request<Application>(`/students/${studentId}/applications/${applicationId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  untrackApplication: (studentId: string, applicationId: string) =>
    request<void>(`/students/${studentId}/applications/${applicationId}`, {
      method: "DELETE",
    }),
};
