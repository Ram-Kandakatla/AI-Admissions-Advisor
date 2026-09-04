// What gets logged when D1 is broken.
//
// WHY THIS IS ITS OWN FILE
//
// These tests break the database on purpose, by dropping a table. The Workers
// vitest pool rolls back *rows* between tests but not schema — a dropped table
// stays dropped for the rest of the file — so a destructive test sitting among
// ordinary ones would silently poison every test after it. Files, on the other
// hand, each get their own D1 instance, which is real isolation rather than
// isolation by convention. Hence a file whose entire premise is "the database
// is gone", and no comment anywhere asking future readers to preserve an order.
//
// Re-applying the migrations to repair the damage is not an option worth
// taking: applyD1Migrations skips anything its ledger already records as
// applied, so restoring one table means dropping the ledger too and reasoning
// about which migrations are idempotent. Cheaper to let the file end.
//
// What these cover that logging.test.ts cannot: the >= 500 half of the request
// logger's level mapping, and the rate limiter's fail-open path. Both are real
// error paths that no amount of well-formed traffic will reach.

import { env } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { get, newStudent, post } from "./helpers.js";

interface LogLine {
  level: string;
  msg: string;
  [field: string]: unknown;
}

let lines: LogLine[] = [];
let rawLines: string[] = [];

function captureAt(level: string): void {
  env.LOG_LEVEL = level;
  lines = [];
  rawLines = [];
  for (const method of ["debug", "log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      const raw = String(args[0]);
      rawLines.push(raw);
      try {
        lines.push(JSON.parse(raw) as LogLine);
      } catch {
        /* not one of ours */
      }
    });
  }
}

function withMsg(msg: string): LogLine[] {
  return lines.filter((l) => l.msg === msg);
}

afterEach(() => {
  vi.restoreAllMocks();
  env.LOG_LEVEL = "silent";
});

test("the rate limiter says so when it fails open", async () => {
  // Fail-open is the deliberate choice (see middleware/rateLimit.ts): every
  // route behind the limiter needs D1 for its own work anyway, so refusing the
  // request *as a rate limit* would report the wrong cause. The whole safety of
  // that choice rests on it being loud — a limiter that silently stops limiting
  // is indistinguishable from one that is working.
  await env.DB.prepare("DROP TABLE rate_limits").run();

  captureAt("info");
  const res = await post("/api/chat", { question: "When are applications due?" });

  expect(res.status).toBe(200); // failed open, not 429 and not 500

  const [line] = withMsg("rate limiter could not reach D1 — allowing the request");
  expect(line).toMatchObject({ level: "error", bucket: "chat" });
  expect(String(line!.detail)).toContain("rate_limits");
});

test("an unhandled failure logs at error level and keeps the id out of the line", async () => {
  // newStudent leaves its guest session in the jar, so the request below gets
  // past requireOwner rather than stopping at a 401 short of the failing query.
  const studentId = await newStudent();
  await env.DB.prepare("DROP TABLE students").run();

  captureAt("info");
  const res = await get(`/api/students/${studentId}`);
  expect(res.status).toBe(500);

  // The response itself says nothing about how the server is built.
  expect(await res.json()).toEqual({ error: "Internal server error" });

  // Both lines: the access log escalates to error on a 5xx, and the error log
  // carries the detail the access log deliberately does not.
  expect(withMsg("request")[0]).toMatchObject({
    level: "error",
    method: "GET",
    route: "/api/students/:id",
    status: 500,
  });

  const [failure] = withMsg("unhandled error");
  expect(failure).toMatchObject({
    level: "error",
    method: "GET",
    route: "/api/students/:id",
    status: 500,
  });
  expect(String(failure!.detail)).toContain("students");
  expect(failure!.stack).toBeTruthy();

  // Still true on the failure path, which is where a hastily added debug field
  // is most likely to appear.
  expect(rawLines.join("\n")).not.toContain(studentId);
});
