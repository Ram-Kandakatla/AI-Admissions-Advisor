// Phase 1 hardening tests.
//
// These cover settings rather than features, which is exactly why they are
// worth writing: nothing in the app's behaviour changes if helmet or the body
// cap quietly disappears in a future refactor, so no other test would notice.

const request = require("supertest");
const app = require("../server");
const { inspectApiKey } = require("../services/llmService");

const ALLOWED_ORIGIN = "http://localhost:5173";

describe("security headers", () => {
  test("helmet is mounted on API responses", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBeDefined();
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  test("Express's version-advertising header is gone", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("CORS allowlist", () => {
  test("the configured frontend origin is allowed", async () => {
    const res = await request(app).get("/api/health").set("Origin", ALLOWED_ORIGIN);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
  });

  test("an unknown origin is not granted access", async () => {
    const res = await request(app).get("/api/health").set("Origin", "https://evil.example.com");
    // The request still executes — CORS is enforced in the browser, not here —
    // but without this header the browser refuses to hand the body to that page.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("a preflight from an unknown origin is not approved", async () => {
    const res = await request(app)
      .options("/api/students")
      .set("Origin", "https://evil.example.com")
      .set("Access-Control-Request-Method", "POST");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("global rate limiting", () => {
  test("the limiter covers routes beyond /api/chat", async () => {
    // Asserting the standard headers proves the limiter is mounted app-wide
    // without firing 300 requests to prove it the slow way.
    const res = await request(app).get("/api/universities");
    expect(res.headers["ratelimit-limit"]).toBeDefined();
    expect(res.headers["ratelimit-remaining"]).toBeDefined();
    // legacyHeaders: false — the deprecated X- spellings should be gone.
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
  });

  test("write endpoints are covered too", async () => {
    const res = await request(app).post("/api/students").send({ name: "" });
    expect(res.status).toBe(400); // validation, not the limiter
    expect(res.headers["ratelimit-limit"]).toBeDefined();
  });
});

describe("request body limits", () => {
  test("a body over the cap is rejected as 413, not 500", async () => {
    const oversized = { name: "x".repeat(200 * 1024) }; // ~200kb, double the cap
    const res = await request(app).post("/api/students").send(oversized);

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("Request body is too large.");
  });

  test("a body under the cap still reaches the route", async () => {
    const res = await request(app)
      .post("/api/students")
      .send({ name: "Ana", gpa: 3.8, satScore: 1450, interestedMajors: ["Computer Science"] });
    expect(res.status).toBe(201);
  });

  test("malformed JSON is a 400, not a 500", async () => {
    const res = await request(app)
      .post("/api/students")
      .set("Content-Type", "application/json")
      .send('{"name": "Ana"');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Malformed request.");
  });
});

describe("error responses do not leak internals", () => {
  test("no stack trace, file path, or express detail reaches the client", async () => {
    const res = await request(app)
      .post("/api/students")
      .set("Content-Type", "application/json")
      .send("{broken");

    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/\bat \w+.*\(/); // stack frame
    expect(body).not.toMatch(/node_modules|\/Users\/|body-parser/);
    expect(Object.keys(res.body)).toEqual(["error"]);
  });

  test("an unknown route stays a plain 404", async () => {
    const res = await request(app).get("/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });
});

describe("API key validation at boot", () => {
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
