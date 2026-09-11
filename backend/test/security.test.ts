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
import { SELF, env } from "cloudflare:test";
import {
  api,
  body,
  currentCookie,
  get,
  newStudent,
  post,
  resetRateLimits,
  resetSession,
  send,
  useSession,
} from "./helpers.js";
import { inspectApiKey } from "../src/services/llmService.js";
import { MAX_ACTIVITIES, MAX_ACTIVITY_LENGTH } from "../src/models/studentProfile.js";

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

  test("minting guest profiles is limited per network; a session is not counted", async () => {
    // The one write that needs no account. Unlimited, it is a loop that fills
    // the database for everybody.
    const profile = { name: "G", gpa: 3, interestedMajors: ["CS"] };
    let lastGuest: string | null = null;
    for (let i = 0; i < 50; i++) {
      resetSession();
      expect((await post("/api/students", profile)).status).toBe(201);
      lastGuest = currentCookie();
    }
    resetSession();
    const over = await post("/api/students", profile);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBeTruthy();

    // Someone who already has a session is not creating an account, so the
    // spent budget does not apply: they get the route's own answer.
    useSession(lastGuest);
    expect((await post("/api/students", profile)).status).toBe(409);
  });

  test("a client address is stored hashed, never as sent", async () => {
    resetSession();
    const ip = "203.0.113.7";
    await api("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ question: "hello" }),
    });
    const { results } = await env.DB.prepare("SELECT client FROM rate_limits").all<{
      client: string;
    }>();
    const clients = results.map((r) => r.client);
    expect(clients).toContainEqual(expect.stringMatching(/^ip:[0-9a-f]{64}$/));
    for (const client of clients) expect(client).not.toContain(ip);
  });
});

describe("cross-origin writes are refused", () => {
  // The test Worker answers as https://compass.test, so a subdomain of it
  // stands in for a Pages preview deployment: another origin on the same site,
  // which is exactly what the SameSite=Lax cookie does not keep out.
  const PREVIEW = "https://preview.compass.test";

  // text/plain is the point. It makes this a "simple" request, which a browser
  // sends with no preflight, so CORS never gets a say — and readJson parses it
  // anyway, as the allowed cases below show.
  const write = (headers: Record<string, string>) =>
    api("/api/students", {
      method: "POST",
      headers: { "Content-Type": "text/plain", ...headers },
      body: JSON.stringify({ name: "X", gpa: 3, interestedMajors: ["CS"] }),
    });

  test("a same-site page on another origin cannot write", async () => {
    resetSession();
    const res = await write({ Origin: PREVIEW, "Sec-Fetch-Site": "same-site" });
    expect(res.status).toBe(403);
    // Refused before the route ran: no guest account was minted.
    expect(currentCookie()).toBeNull();
  });

  test("an opaque origin is refused", async () => {
    resetSession();
    expect((await write({ Origin: "null" })).status).toBe(403);
  });

  test("a write the browser marks cross-site is refused even without an Origin", async () => {
    resetSession();
    expect((await write({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  });

  test("the request's own origin and the configured frontend may write", async () => {
    resetSession();
    const same = await write({ Origin: "https://compass.test", "Sec-Fetch-Site": "same-origin" });
    expect(same.status).toBe(201);
    resetSession();
    const frontend = await write({ Origin: ALLOWED_ORIGIN, "Sec-Fetch-Site": "cross-site" });
    expect(frontend.status).toBe(201);
  });

  test("a request with neither header is not from a browser, and is let through", async () => {
    resetSession();
    expect((await write({})).status).toBe(201);
  });

  test("reads are not the guard's business", async () => {
    const res = await get("/api/health", { Origin: PREVIEW, "Sec-Fetch-Site": "same-site" });
    expect(res.status).toBe(200);
  });
});

describe("the session cookie", () => {
  test("over https it is __Host- prefixed, Secure, HttpOnly, and host-only", async () => {
    resetSession();
    const res = await post("/api/students", { name: "C", gpa: 3, interestedMajors: ["CS"] });
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^__Host-compass_session=/);
    expect(set).toMatch(/;\s*Secure/i);
    expect(set).toMatch(/;\s*HttpOnly/i);
    expect(set).toMatch(/;\s*Path=\//i);
    expect(set).not.toMatch(/Domain=/i);
  });

  test("the same session id under the bare name is ignored over https", async () => {
    // What a sibling subdomain can plant with Domain= on the parent host. The
    // id here is real and live; only the name is wrong, and that is enough.
    await newStudent();
    const id = currentCookie()!.split("=")[1];
    const me = await body<{ user: unknown }>(
      await get("/api/auth/me", { Cookie: `compass_session=${id}` }),
      200
    );
    expect(me.user).toBeNull();
  });

  test("over plain http, as in local dev, it keeps the bare name", async () => {
    const res = await SELF.fetch("http://compass.test/api/students", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "L", gpa: 3, interestedMajors: ["CS"] }),
    });
    expect(res.status).toBe(201);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^compass_session=/);
    expect(set).not.toMatch(/Secure/i);
  });

  test("signing out clears the prefixed cookie", async () => {
    await newStudent();
    const res = await post("/api/auth/logout", {});
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-compass_session=;.*Max-Age=0/i);
  });
});

describe("profile fields are bounded", () => {
  const create = (overrides: Record<string, unknown>) => {
    resetSession();
    return post("/api/students", { name: "B", gpa: 3.2, interestedMajors: ["CS"], ...overrides });
  };

  test("a major no school offers is dropped, and none at all is refused", async () => {
    const kept = await body(await create({ interestedMajors: ["CS", "Underwater Basketry"] }), 201);
    expect(kept.interestedMajors).toEqual(["CS"]);
    expect((await create({ interestedMajors: ["Underwater Basketry"] })).status).toBe(400);
  });

  test("repeating a valid value cannot inflate a list", async () => {
    // The allowlist alone would pass five thousand copies of "CS" — and
    // majors are joined into the chatbot's prompt, so that was billed per
    // question.
    const b = await body(
      await create({
        interestedMajors: Array(5000).fill("CS"),
        preferredRegions: Array(5000).fill("West"),
      }),
      201
    );
    expect(b.interestedMajors).toEqual(["CS"]);
    expect(b.preferredRegions).toEqual(["West"]);
  });

  test("activities are capped in count and in length", async () => {
    const many = Array.from({ length: 100 }, (_, i) => `Club ${i} ${"x".repeat(300)}`);
    const b = await body<{ extracurriculars: string[] }>(
      await create({ extracurriculars: many }),
      201
    );
    expect(b.extracurriculars).toHaveLength(MAX_ACTIVITIES);
    for (const e of b.extracurriculars) expect(e.length).toBeLessThanOrEqual(MAX_ACTIVITY_LENGTH);
  });

  test("every major the form is offered is one the API accepts", async () => {
    const { majors } = await body<{ majors: string[] }>(await get("/api/meta"), 200);
    const b = await body(await create({ interestedMajors: majors }), 201);
    expect(b.interestedMajors).toEqual(majors);
  });
});

describe("student-scoped routes are gated", () => {
  // The middleware in app.ts only covers routes registered after it, so a route
  // added in the wrong place would silently skip the check. Enumerating every
  // student-scoped route here is what turns that from a comment into a failure.
  //
  // Phase 2 did replace `requireStudent` with `requireOwner`, so this now
  // guards authorization rather than existence — and the expected status moved
  // from 404 to 403 with it. That is the point: a caller who does not own an
  // id gets the same answer whether or not it exists, so the API cannot be
  // walked to discover which student ids are real.
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

  const call = (method: string, path: string) =>
    method === "GET" || method === "DELETE"
      ? api(path, { method })
      : send(method as "POST" | "PUT" | "PATCH", path, {
          name: "Ghost",
          gpa: 3.0,
          interestedMajors: ["CS"],
          universityId: 1,
          note: "x",
        });

  test.each(routes)("%s %s refuses a caller with no session", async (method, path) => {
    const res = await call(method, path);
    expect(res.status, `${method} ${path}`).toBe(401);
  });

  test.each(routes)("%s %s refuses a signed-in caller who owns a different profile",
    async (method, path) => {
      // The stronger half of the check. A 401 only proves the route wants a
      // session; this proves it compares that session against the id in the
      // path, which is the actual authorization bug this suite exists to catch.
      await newStudent();
      const res = await call(method, path);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  );
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
      // The dataset's own spelling. "Computer Science" used to pass because
      // majors were not checked at all; see the profile-caps tests below.
      interestedMajors: ["CS"],
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
