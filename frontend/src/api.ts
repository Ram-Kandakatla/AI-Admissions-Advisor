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

/** Carries the HTTP status for the few callers that branch on it. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// Origin-relative paths: the Vite proxy serves /api locally, and the deployed
// Worker serves the frontend and API on one origin.

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    // "include" still works if the API ever moves to its own origin (which
    // would also need SameSite=None on the cookie).
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
   * Identical for every address and signs nobody in; the emailed link creates
   * the account. Never infer from it whether an account exists.
   */
  signup: (email: string, password: string) =>
    request<{ message: string }>("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  /** Call without a password first; retry with it on `passwordRequired`. */
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
   * 409 means 2FA is already on. This never sends a code; the UI's path to a
   * new phone is turning 2FA off and on again.
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

  /** Always resolves the same way; the UI must not reveal whether an account exists. */
  forgotPassword: (email: string) =>
    request<{ message: string }>("/auth/forgot", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),

  /** Signs in on success. `mfaRequired` means call again with a code. */
  resetPassword: (token: string, password: string, code?: string) =>
    request<
      | { mfaRequired: true }
      | { mfaRequired?: false; user: AuthUser; studentId: string | null }
    >("/auth/reset", {
      method: "POST",
      body: JSON.stringify({ token, password, ...(code ? { code } : {}) }),
    }),

  /** `password` is required for members and omitted for guests. */
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

  updateStudent: (studentId: string, profile: ProfileInput) =>
    request<StudentRecord>(`/students/${studentId}`, {
      method: "PUT",
      body: JSON.stringify(profile),
    }),

  /** `full` skips the per-tier cap; only Compare needs it. */
  recommendations: (studentId: string, opts?: { full?: boolean }) =>
    request<RecommendationResponse>(
      `/students/${studentId}/recommendations${opts?.full ? "?full=1" : ""}`
    ),

  scholarships: (studentId: string) =>
    request<ScholarshipResponse>(`/students/${studentId}/scholarships`),

  notes: (studentId: string) => request<NotesResponse>(`/students/${studentId}/notes`),

  // Partial update: only the fields sent are changed.
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
  // `sharedPlan` takes a token, not a session, and works signed out.

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
