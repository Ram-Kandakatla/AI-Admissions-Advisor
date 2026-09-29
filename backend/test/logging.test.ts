// Structured logging — the logger itself, and the line it writes per request.
//
// The tests that matter most here are not the ones checking that a log line
// appears. They are the ones checking what is *not* in it: a student id, an
// email, a password. Those are the properties that quietly stop being true
// when someone adds a field to a log call, and nothing else in the suite would
// notice.
//
// The suite runs at LOG_LEVEL=silent (vitest.config.ts) so several hundred
// request lines don't bury the results. These tests raise it per-test and put
// it back afterwards.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { createLogger, errorFields, resolveLevel } from "../src/log.js";
import { body, currentCookie, get, newStudent, post } from "./helpers.js";

interface LogLine {
  level: string;
  msg: string;
  [field: string]: unknown;
}

type ConsoleMethod = "debug" | "log" | "warn" | "error";

let lines: LogLine[] = [];
let rawLines: string[] = [];
let spies: Record<ConsoleMethod, MockInstance>;

/**
 * Capture everything the Worker logs at `level`.
 *
 * Both the parsed objects (to assert on fields) and the raw strings (to assert
 * a value is absent from the line *anywhere*, including inside a nested field
 * or a stack trace — a substring check catches leaks a field-by-field check
 * would walk straight past).
 */
function captureAt(level: string): void {
  env.LOG_LEVEL = level;
  lines = [];
  rawLines = [];
  // The spy objects are kept rather than read back off `console` later:
  // workerd's console methods come back as freshly bound functions on every
  // access, so `vi.mocked(console.debug)` inspects something that is not the
  // spy even while the spy is installed and capturing.
  spies = {} as Record<ConsoleMethod, MockInstance>;
  for (const method of ["debug", "log", "warn", "error"] as const) {
    spies[method] = vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      const raw = String(args[0]);
      rawLines.push(raw);
      try {
        lines.push(JSON.parse(raw) as LogLine);
      } catch {
        /* not one of ours — wrangler writes plain text too */
      }
    });
  }
}

/** The captured lines with this `msg`, which is the stable grouping key. */
function withMsg(msg: string): LogLine[] {
  return lines.filter((l) => l.msg === msg);
}

afterEach(() => {
  vi.restoreAllMocks();
  env.LOG_LEVEL = "silent";
});

describe("resolveLevel", () => {
  test("accepts the five settings", () => {
    for (const level of ["debug", "info", "warn", "error", "silent"]) {
      expect(resolveLevel(level)).toBe(level);
    }
  });

  test("tolerates casing and stray whitespace from a hand-edited var", () => {
    expect(resolveLevel("  WARN ")).toBe("warn");
  });

  test("falls back to info rather than throwing or going silent", () => {
    // The failure mode this guards against is a typo in wrangler.toml taking
    // logging away entirely — precisely when you'd want it. Nothing typechecks
    // a toml var, so the fallback is the only thing standing there.
    expect(resolveLevel("verbose")).toBe("info");
    expect(resolveLevel(undefined)).toBe("info");
    expect(resolveLevel(42)).toBe("info");
  });
});

describe("createLogger", () => {
  test("writes one JSON line with level and msg first", () => {
    captureAt("silent"); // spies only; this logger reads its own env below
    createLogger({ LOG_LEVEL: "info" }).info("hello", { route: "/api/meta" });

    expect(rawLines).toHaveLength(1);
    expect(JSON.parse(rawLines[0]!)).toEqual({
      level: "info",
      msg: "hello",
      route: "/api/meta",
    });
  });

  test("drops everything below the configured level", () => {
    captureAt("silent");
    const log = createLogger({ LOG_LEVEL: "warn" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(lines.map((l) => l.msg)).toEqual(["w", "e"]);
  });

  test("silent drops everything, including errors", () => {
    captureAt("silent");
    const log = createLogger({ LOG_LEVEL: "silent" });
    log.error("this must not appear");

    expect(rawLines).toEqual([]);
  });

  test("routes each level to its matching console method", () => {
    // Workers Logs reads the console method to set its own level, so this is
    // what makes "errors only" work in the dashboard without parsing our JSON.
    captureAt("silent");
    const log = createLogger({ LOG_LEVEL: "debug" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(spies.debug).toHaveBeenCalledTimes(1);
    expect(spies.log).toHaveBeenCalledTimes(1);
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.error).toHaveBeenCalledTimes(1);
  });

  test("an unserializable field cannot throw out of a logging call", () => {
    // Losing the log context is bad; losing the response because logging threw
    // is worse. The line still arrives, saying what happened to it.
    captureAt("silent");
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => createLogger({ LOG_LEVEL: "info" }).error("boom", { circular })).not.toThrow();
    expect(lines[0]).toMatchObject({
      level: "error",
      msg: "boom",
      detail: "log fields were not serializable",
    });
  });
});

describe("errorFields", () => {
  test("an Error contributes its message and stack", () => {
    const fields = errorFields(new Error("d1 timed out"));
    expect(fields.detail).toBe("d1 timed out");
    expect(String(fields.stack)).toContain("d1 timed out");
  });

  test("a non-Error throw is still logged rather than dropped", () => {
    // `catch` binds unknown — a throw is not obliged to be an Error, and the
    // one that isn't is exactly the one you want a line for.
    expect(errorFields("just a string")).toEqual({ detail: "just a string" });
    expect(errorFields(null)).toEqual({ detail: "null" });
  });
});

describe("request logging", () => {
  test("a successful request logs method, route, status and duration", async () => {
    captureAt("info");
    await get("/api/meta");

    const [line, ...rest] = withMsg("request");
    expect(rest).toEqual([]); // exactly one line per request, not one per middleware
    expect(line).toMatchObject({
      level: "info",
      method: "GET",
      route: "/api/meta",
      status: 200,
    });
    expect(typeof line!.ms).toBe("number");
    expect(line!.ms as number).toBeGreaterThanOrEqual(0);
  });

  test("logs the route pattern, never the student id in the path", async () => {
    // The reason this file exists. A student id identifies a real teenager and
    // Cloudflare retains logs; the pattern carries the whole operational signal
    // without it.
    const studentId = await newStudent();
    captureAt("info");
    await get(`/api/students/${studentId}`);

    expect(withMsg("request")[0]).toMatchObject({
      route: "/api/students/:id",
      status: 200,
    });
    expect(rawLines.join("\n")).not.toContain(studentId);
  });

  test("a 403 is attributed to the route the caller was reaching for", async () => {
    // requireOwner short-circuits before the handler runs. The match still
    // happened, so the line names the real route rather than degrading to null
    // — which is what makes "who is probing /api/students/:id" answerable.
    const victimId = await newStudent();
    await newStudent(); // a second person, whose session is now the current one

    captureAt("info");
    const res = await get(`/api/students/${victimId}`);
    expect(res.status).toBe(403);

    expect(withMsg("request")[0]).toMatchObject({
      route: "/api/students/:id",
      status: 403,
    });
    expect(rawLines.join("\n")).not.toContain(victimId);
  });

  test("an unrouted path logs a null route, not the wildcard middleware's", async () => {
    captureAt("info");
    const res = await get("/api/no-such-endpoint");
    expect(res.status).toBe(404);

    const line = withMsg("request")[0]!;
    expect(line.route).toBeNull();
    expect(line.status).toBe(404);
    // Hono's match includes the `*` middleware entries. Reporting one of those
    // as the route would invent an endpoint that does not exist.
    expect(rawLines.join("\n")).not.toContain("/api/*");
  });

  test("4xx logs at info, not warn", async () => {
    // Deliberate. A 401 here is what a returning student gets whenever their
    // 30-day session has expired — it is how the frontend learns to show the
    // signed-out state — and 404s are mostly bots trying paths. If routine
    // traffic were warn, a real warning would be one line among thousands.
    // The status is its own field; filter on that instead.
    captureAt("info");
    const res = await get("/api/students/anyone");
    expect(res.status).toBe(401);

    expect(withMsg("request")[0]).toMatchObject({
      level: "info",
      route: "/api/students/:id",
      status: 401,
    });
  });

  test("health checks drop to debug so a monitor cannot flood the log", async () => {
    // Phase 8 puts uptime monitoring on this route every few minutes forever.
    captureAt("info");
    await get("/api/health");
    expect(withMsg("request")).toEqual([]);

    captureAt("debug");
    await get("/api/health");
    expect(withMsg("request")[0]).toMatchObject({
      level: "debug",
      route: "/api/health",
      status: 200,
    });
  });

  test("silent suppresses request logging entirely", async () => {
    captureAt("silent");
    await get("/api/meta");
    expect(rawLines).toEqual([]);
  });

  test("no credential from an auth request reaches the log", async () => {
    const email = "logging-probe@example.com";
    const password = "correct horse battery staple";

    captureAt("debug"); // the most verbose setting, so nothing is hidden by level
    await post("/api/auth/signup", { email, password });

    const everything = rawLines.join("\n");
    expect(everything).not.toContain(email);
    expect(everything).not.toContain(password);
    // Confirms the assertions above are meaningful rather than passing because
    // nothing was logged at all.
    expect(withMsg("request")[0]).toMatchObject({ route: "/api/auth/signup", status: 200 });
  });

  test("a malformed body logs a client error and keeps its 400", async () => {
    captureAt("info");
    const res = await post("/api/students", "{ not json");
    expect(res.status).toBe(400);

    // warn, not error: something is wrong with the request and nothing is
    // wrong with the Worker.
    expect(withMsg("client error")[0]).toMatchObject({
      level: "warn",
      method: "POST",
      route: "/api/students",
      status: 400,
    });
    expect(withMsg("request")[0]).toMatchObject({ level: "info", status: 400 });
  });

  test("logs the route a signed-in caller hit without logging who they are", async () => {
    const studentId = await newStudent();
    // newStudent leaves this session in the jar; read it so the assertion below
    // can name the exact credential that must not appear.
    const cookie = currentCookie()!;

    captureAt("info");
    await body(await get(`/api/students/${studentId}/recommendations`), 200);

    expect(withMsg("request")[0]).toMatchObject({
      route: "/api/students/:id/recommendations",
      status: 200,
    });
    const everything = rawLines.join("\n");
    expect(everything).not.toContain(studentId);
    // The session id is a bearer credential — anything holding it can act as
    // this student until it expires. It must never be written down.
    expect(everything).not.toContain(cookie.split("=")[1]);
  });
});
