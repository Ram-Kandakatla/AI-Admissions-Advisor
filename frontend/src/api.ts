import type {
  Application,
  AuthState,
  AuthUser,
  ApplicationMeta,
  ApplicationsResponse,
  ChatMessage,
  ChatMode,
  LlmProvider,
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
  University,
} from "./types";

// All requests go through the Vite proxy to the backend Worker (/api -> :8787).
//
// Phase 7 puts the frontend and the API on one Cloudflare Pages origin, at
// which point /api resolves directly and the proxy goes away — this file needs
// no change either way, since every path here is already origin-relative.

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    // Every route that touches a profile is now behind a session cookie.
    // "include" rather than the default "same-origin" so this keeps working if
    // Phase 7 puts the API on its own origin (Option B) — at which point the
    // cookie also needs SameSite=None and the CORS middleware needs
    // credentials:true, which it already has.
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

  signup: (email: string, password: string) =>
    request<{ user: AuthUser; studentId: string | null }>("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  login: (email: string, password: string) =>
    request<{ user: AuthUser; studentId: string | null; discardedGuestProfile: boolean }>(
      "/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) }
    ),

  logout: () => request<void>("/auth/logout", { method: "POST" }),

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
