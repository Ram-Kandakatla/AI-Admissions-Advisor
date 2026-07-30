import type {
  LlmProvider,
  Meta,
  ProfileInput,
  RecommendationResponse,
  StudentRecord,
  University,
} from "./types";

// All requests go through the Vite proxy to the Express backend (/api -> :4000).

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
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
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<{ status: string; llm: LlmProvider }>("/health"),

  meta: () => request<Meta>("/meta"),

  universities: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request<University[]>(`/universities${qs ? `?${qs}` : ""}`);
  },

  createStudent: (profile: ProfileInput) =>
    request<StudentRecord>("/students", {
      method: "POST",
      body: JSON.stringify(profile),
    }),

  recommendations: (studentId: string) =>
    request<RecommendationResponse>(`/students/${studentId}/recommendations`),

  chat: (question: string, studentId?: string) =>
    request<{ answer: string; source: LlmProvider }>("/chat", {
      method: "POST",
      body: JSON.stringify({ question, studentId }),
    }),
};
