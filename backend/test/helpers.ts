// Test helpers — the supertest replacement.
//
// supertest drives an in-process Node http.Server, which is exactly what a
// Worker isn't. `SELF` from cloudflare:test dispatches into the real Worker
// running in workerd, so these tests exercise the same code path a deployed
// request takes, including the middleware stack.

import { SELF, env } from "cloudflare:test";
import { expect } from "vitest";

const BASE = "https://compass.test";

/**
 * A one-slot cookie jar.
 *
 * Phase 2 made almost every route session-dependent, and `SELF.fetch` is not a
 * browser — it neither stores nor resends cookies. Without this, every request
 * a test makes arrives anonymous and 401s, and the alternative is threading a
 * Cookie header through several hundred existing call sites.
 *
 * Module-level state is safe here because each test file runs in its own
 * isolate and the pool rolls storage back between tests: a session id captured
 * in one test names a row that no longer exists in the next, which is why
 * newStudent() and signUp() clear the jar rather than appending to it.
 */
let jar: string | null = null;

/** Forget the current session — the test equivalent of a fresh browser. */
export function resetSession(): void {
  jar = null;
}

/** Snapshot the current cookie, for tests that need to act as two people. */
export function currentCookie(): string | null {
  return jar;
}

/** Act as a previously captured identity. */
export function useSession(cookie: string | null): void {
  jar = cookie;
}

function captureCookies(res: Response): void {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const set = headers.getSetCookie ? headers.getSetCookie() : [];
  const raw = set.length ? set : ([res.headers.get("set-cookie")].filter(Boolean) as string[]);

  for (const cookie of raw) {
    const pair = cookie.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name !== "compass_session") continue;
    // An empty value is the delete-cookie form the logout route sends.
    jar = value === "" ? null : `${name}=${value}`;
  }
}

export async function api(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  // An explicit Cookie header wins, so a test can impersonate another session
  // without disturbing the jar.
  if (jar && !headers.has("Cookie")) headers.set("Cookie", jar);

  const res = await SELF.fetch(BASE + path, { ...init, headers });
  captureCookies(res);
  return res;
}

export function get(path: string, headers?: Record<string, string>): Promise<Response> {
  return api(path, { headers });
}

export function send(
  method: "POST" | "PUT" | "PATCH",
  path: string,
  body: unknown
): Promise<Response> {
  return api(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export const post = (path: string, body: unknown) => send("POST", path, body);
export const put = (path: string, body: unknown) => send("PUT", path, body);
export const patch = (path: string, body: unknown) => send("PATCH", path, body);
export const del = (path: string) => api(path, { method: "DELETE" });

/** Parse a JSON response, failing loudly on a status the caller didn't expect. */
export async function body<T = any>(res: Response, expectedStatus?: number): Promise<T> {
  if (expectedStatus !== undefined) expect(res.status).toBe(expectedStatus);
  return (await res.json()) as T;
}

/**
 * A fresh student, returning the id every downstream call needs.
 *
 * Also establishes the guest session that owns it — POST /api/students mints
 * an anonymous account for a caller who has none, and the jar picks up the
 * cookie. The reset first is what makes each call a genuinely new person
 * rather than the previous one hitting the one-profile-per-account rule.
 */
export async function newStudent(
  overrides: Record<string, unknown> = {}
): Promise<string> {
  resetSession();
  const res = await post("/api/students", {
    name: "Sam",
    gpa: 3.7,
    interestedMajors: ["CS"],
    ...overrides,
  });
  const record = await body<{ id: string }>(res, 201);
  return record.id;
}

/** Sign up as a brand-new account, returning the session cookie it issues. */
export async function signUp(
  email: string,
  password = "correct horse battery"
): Promise<{ userId: number; studentId: string | null; cookie: string | null }> {
  const res = await post("/api/auth/signup", { email, password });
  const b = await body<{ user: { id: number }; studentId: string | null }>(res, 201);
  return { userId: b.user.id, studentId: b.studentId, cookie: currentCookie() };
}

/**
 * Clear the rate-limit counters.
 *
 * Every test in a run shares one D1 database and one client key, so the 30
 * chat requests allowed per window are a budget shared across suites. Tests
 * that call /api/chat reset it first rather than depending on how many other
 * tests ran before them.
 */
export async function resetRateLimits(): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limits").run();
}
