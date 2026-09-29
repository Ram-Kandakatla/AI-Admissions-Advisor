// One log line per request. Registered first in app.ts so it also sees
// responses from CORS and bodyLimit (a 413, a refused preflight).

import { createMiddleware } from "hono/factory";
import { routePath } from "hono/route";
import type { Context } from "hono";
import { createLogger } from "../log.js";
import type { AppEnv } from "../types.js";

/**
 * The matched pattern (`/api/students/:id`), never the concrete path: a
 * student id identifies a real teenager and Cloudflare retains logs.
 *
 * `routePath(c, -1)` reads the last matched route, so it works from the
 * outermost middleware and still names the route when a guard answers 403.
 * Null for a 404, where the only match is a `*` middleware entry.
 */
export function matchedRoute(c: Context<AppEnv>): string | null {
  const path = routePath(c, -1);
  if (!path || path.endsWith("*")) return null;
  return path;
}

/**
 * Not 4xx → warn: every signed-out visitor gets a 401 from /auth/me, and
 * routine traffic at warn would drown real warnings.
 */
function levelFor(status: number): "info" | "error" {
  return status >= 500 ? "error" : "info";
}

export const requestLog = createMiddleware<AppEnv>(async (c, next) => {
  const started = Date.now();

  try {
    await next();
  } finally {
    // `finally` so a non-Error throw, which Hono re-raises instead of routing
    // through onError, still gets a line.
    const status = c.finalized ? c.res.status : 500;
    const route = matchedRoute(c);

    // An uptime monitor polls /api/health forever; healthy checks drop to debug.
    const level = route === "/api/health" && status < 500 ? "debug" : levelFor(status);

    createLogger(c.env)[level]("request", {
      method: c.req.method,
      route,
      status,
      // Workers freezes Date.now() between I/O, so this measures I/O time only.
      ms: Date.now() - started,
      ray: c.req.header("cf-ray"),
    });
  }
});
