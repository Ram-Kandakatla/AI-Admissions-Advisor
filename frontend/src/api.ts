import type {
  Application,
  ApplicationMeta,
  ApplicationsResponse,
  AuthState,
  AuthUser,
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
  StudentRecord,
  TwoFactorStatus,
  University,
  VerifySignupResult,
} from "./types";

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
    throw new Error(message);
  }
  // DELETE replies 204 with no body — calling .json() on that throws.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  // ---- Accounts ----

  me: () => request<AuthState>("/auth/me"),

  /**
   * Start creating an account.
   *
   * Resolves the same way for every well-formed address and signs nobody in:
   * the account is created later, from the emailed link. Whether the address
   * already had an account is exactly what the server refuses to say, and a
   * caller must not try to infer it — the same rule as forgotPassword below.
   */
  signup: (email: string, password: string) =>
    request<{ message: string }>("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  /**
   * Redeem a signup link.
   *
   * Called first with no password. In the browser that signed up, that
   * finishes it; anywhere else the answer is `passwordRequired`, and the page
   * asks for the password chosen at signup and calls again.
   */
  verifySignup: (token: string, password?: string) =>
    request<VerifySignupResult>("/auth/verify", {
      method: "POST",
      body: JSON.stringify({ token, ...(password ? { password } : {}) }),
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
   * Ask for a reset link.
   *
   * Always resolves for any well-formed address, because the server always
   * answers 202 — telling the caller whether an account exists would turn this
   * into a way to test a list of addresses for membership. The client must not
   * reintroduce that distinction by, say, showing a different message when the
   * response is slow.
   */
  forgotPassword: (email: string) =>
    request<{ message: string }>("/auth/forgot", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),

  /**
   * Spend a reset token. On success the caller is signed in.
   *
   * `mfaRequired` comes back instead of a user when the account has a second
   * factor: a reset deliberately does not bypass it here, so the link alone is
   * not enough. The client cannot know in advance — the server will not say
   * whether an account has 2FA until a valid token is presented, since that
   * would be a fact about someone else's account.
   */
  resetPassword: (token: string, password: string, code?: string) =>
    request<
      | { mfaRequired: true }
      | { mfaRequired?: false; user: AuthUser; studentId: string | null }
    >("/auth/reset", {
      method: "POST",
      body: JSON.stringify({ token, password, ...(code ? { code } : {}) }),
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
