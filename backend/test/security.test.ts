// Security hardening tests, carried over from the Express build.
//
// These cover settings rather than features, which is exactly why they are
// worth writing: nothing in the app's behaviour changes if the header
// middleware or the body cap quietly disappears in a future refactor, so no
// other test would notice.
//
// One assertion genuinely changed shape in the Workers port, and it is called
// out where it lives: the global 300/15min limiter no longer exists in code.

import { beforeEach, describe, expect, test } from "vitest";
import { api, body, get, post, resetRateLimits, send } from "./helpers.js";
import { inspectApiKey } from "../src/services/llmService.js";

const ALLOWED_ORIGIN = "http://localhost:5173";

describe("security headers", () => {
  test("the hardening header set is mounted on API responses", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBeTruthy();
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("strict-transport-security")).toBeTruthy();
  });

  test("no framework version is advertised", async () => {
    const res = await get("/api/health");
    // Express needed helmet to strip X-Powered-By. Hono never sends one, so
    // this now asserts a property of the platform rather than of a middleware
    // — kept because the header reappearing would still be a regression.
    expect(res.headers.get("x-powered-by")).toBeNull();
  });
});

describe("CORS allowlist", () => {
  test("the configured frontend origin is allowed", async () => {
    const res = await get("/api/health", { Origin: ALLOWED_ORIGIN });
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
  });

  test("an unknown origin is not granted access", async () => {
    const res = await get("/api/health", { Origin: "https://evil.example.com" });
    // The request still executes — CORS is enforced in the browser, not here —
    // but without this header the browser refuses to hand the body to that page.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a preflight from an unknown origin is not approved", async () => {
    const res = await api("/api/students", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("rate limiting", () => {
  beforeEach(resetRateLimits);

  // WHAT CHANGED FROM EXPRESS
  //
  // There were two limiters: a global 300/15min and a stricter 30/15min on
  // /api/chat. Only the chat one is reimplemented here. The global limiter
  // moved to a Cloudflare Rate Limiting Rule, which runs at the edge in front
  // of the Worker — there is no code in this repo to test, and no local
  // equivalent to assert against. See PHASE-1.md for the rule to create.
  //
  // The one worth keeping in code is the chat limiter, because it is the cap
  // on real LLM spend per caller.

  test("the chat limiter is mounted and reports its budget", async () => {
    const res = await post("/api/chat", { question: "hello" });
    expect(res.headers.get("ratelimit-limit")).toBe("30");
    expect(res.headers.get("ratelimit-remaining")).toBe("29");
    expect(res.headers.get("ratelimit-reset")).toBeTruthy();
    // legacyHeaders: false was the Express setting — the deprecated X-
    // spellings should still be absent.
    expect(res.headers.get("x-ratelimit-limit")).toBeNull();
  });

  test("exceeding the budget is a 429 with Retry-After", async () => {
    for (let i = 0; i < 30; i++) await post("/api/chat", { question: "q" });
    const over = await post("/api/chat", { question: "one too many" });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBeTruthy();
    expect((await over.json<{ error: string }>()).error).toMatch(/Too many questions/);
  });

  test("the counter survives across requests, since no isolate does", async () => {
    // The point of putting the counter in D1: a Worker keeps nothing in memory
    // between requests, so an in-process counter would silently reset.
    await post("/api/chat", { question: "one" });
    const second = await post("/api/chat", { question: "two" });
    expect(second.headers.get("ratelimit-remaining")).toBe("28");
  });

  test("other routes do not draw on the chat budget", async () => {
    for (let i = 0; i < 31; i++) await post("/api/chat", { question: "q" });
    expect((await get("/api/universities")).status).toBe(200);
    expect((await post("/api/students", { name: "Ok", gpa: 3.1, interestedMajors: ["CS"] })).status).toBe(201);
  });
});

describe("student-scoped routes are gated", () => {
  // The middleware in app.ts only covers routes registered after it, so a route
  // added in the wrong place would silently skip the check. Enumerating every
  // student-scoped route here is what turns that from a comment into a failure.
  // Phase 2 replaces `requireStudent` with an ownership check on these same
  // paths, at which point this test is guarding authorization, not just a 404.
  const routes: [string, string][] = [
    ["GET", "/api/students/ghost"],
    ["PUT", "/api/students/ghost"],
    ["GET", "/api/students/ghost/recommendations"],
    ["GET", "/api/students/ghost/scholarships"],
    ["GET", "/api/students/ghost/notes"],
    ["PUT", "/api/students/ghost/notes/1"],
    ["DELETE", "/api/students/ghost/notes/1"],
    ["GET", "/api/students/ghost/applications"],
    ["POST", "/api/students/ghost/applications"],
    ["PATCH", "/api/students/ghost/applications/any"],
    ["DELETE", "/api/students/ghost/applications/any"],
    ["GET", "/api/students/ghost/chat"],
  ];

  test.each(routes)("%s %s rejects an unknown student", async (method, path) => {
    const res =
      method === "GET" || method === "DELETE"
        ? await api(path, { method })
        : await send(method as "POST" | "PUT" | "PATCH", path, {
            name: "Ghost",
            gpa: 3.0,
            interestedMajors: ["CS"],
            universityId: 1,
            note: "x",
          });
    expect(res.status, `${method} ${path}`).toBe(404);
  });
});

describe("request body limits", () => {
  test("a body over the cap is rejected as 413, not 500", async () => {
    const oversized = { name: "x".repeat(200 * 1024) }; // ~200kb, double the cap
    const res = await post("/api/students", oversized);
    expect(res.status).toBe(413);
    expect((await res.json<{ error: string }>()).error).toBe("Request body is too large.");
  });

  test("a body under the cap still reaches the route", async () => {
    const res = await post("/api/students", {
      name: "Ana",
      gpa: 3.8,
      satScore: 1450,
      interestedMajors: ["Computer Science"],
    });
    expect(res.status).toBe(201);
  });

  test("malformed JSON is a 400, not a 500", async () => {
    const res = await send("POST", "/api/students", '{"name": "Ana"');
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe("Malformed request.");
  });
});

describe("error responses do not leak internals", () => {
  test("no stack trace, file path, or framework detail reaches the client", async () => {
    const res = await send("POST", "/api/students", "{broken");
    const parsed = await res.json<Record<string, unknown>>();
    const text = JSON.stringify(parsed);
    expect(text).not.toMatch(/\bat \w+.*\(/); // stack frame
    expect(text).not.toMatch(/node_modules|\/Users\/|workerd|hono/i);
    expect(Object.keys(parsed)).toEqual(["error"]);
  });

  test("an unknown route stays a plain 404", async () => {
    const res = await get("/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});

describe("API key validation", () => {
  test("an absent or blank key is not a misconfiguration", () => {
    for (const value of [undefined, "", "   "]) {
      const result = inspectApiKey("ANTHROPIC_API_KEY", value);
      expect(result.present).toBe(false);
      expect(result.problems).toEqual([]);
    }
  });

  test("a well-formed key passes", () => {
    expect(inspectApiKey("ANTHROPIC_API_KEY", `sk-ant-${"a".repeat(60)}`).valid).toBe(true);
    expect(inspectApiKey("OPENAI_API_KEY", `sk-${"a".repeat(60)}`).valid).toBe(true);
  });

  test("a truncated key is caught", () => {
    const result = inspectApiKey("ANTHROPIC_API_KEY", "sk-ant-abc");
    expect(result.present).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.problems.join(" ")).toMatch(/truncated/);
  });

  test("a key with the wrong prefix is caught", () => {
    const result = inspectApiKey("ANTHROPIC_API_KEY", `sk-${"a".repeat(60)}`);
    expect(result.valid).toBe(false);
    expect(result.problems.join(" ")).toMatch(/sk-ant-/);
  });

  test("an Anthropic key pasted into the OpenAI slot is caught", () => {
    const result = inspectApiKey("OPENAI_API_KEY", `sk-ant-${"a".repeat(60)}`);
    expect(result.valid).toBe(false);
    expect(result.problems.join(" ")).toMatch(/Anthropic key/);
  });

  test("a key broken across a line is caught", () => {
    const result = inspectApiKey("ANTHROPIC_API_KEY", `sk-ant-${"a".repeat(30)}\n${"b".repeat(30)}`);
    expect(result.valid).toBe(false);
    expect(result.problems.join(" ")).toMatch(/space or line break/);
  });
});
