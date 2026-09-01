// Test helpers — the supertest replacement.
//
// supertest drives an in-process Node http.Server, which is exactly what a
// Worker isn't. `SELF` from cloudflare:test dispatches into the real Worker
// running in workerd, so these tests exercise the same code path a deployed
// request takes, including the middleware stack.

import { SELF, env } from "cloudflare:test";
import { expect } from "vitest";

const BASE = "https://compass.test";

export function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(BASE + path, init);
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

/** A fresh student, returning the id every downstream call needs. */
export async function newStudent(
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const res = await post("/api/students", {
    name: "Sam",
    gpa: 3.7,
    interestedMajors: ["CS"],
    ...overrides,
  });
  const record = await body<{ id: string }>(res, 201);
  return record.id;
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
