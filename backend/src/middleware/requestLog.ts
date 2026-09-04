// One log line per request.
//
// Before this, a successful request left no trace at all — and neither did a
// 403, a 429, or a 404. The only things that logged were four scattered
// failure paths, so the log answered "what broke" and could not answer "what
// happened", which is the question you actually have when a student reports
// that something did not work and nothing threw.
//
// REGISTERED FIRST, ON PURPOSE
//
// This is the outermost middleware in app.ts. Timing that excludes CORS and the
// body-size check would be timing a different request than the one the client
// made, and — more importantly — a 413 from bodyLimit or a rejected CORS
// preflight are responses this must be able to see. Anything registered above
// it is invisible to it.

import { createMiddleware } from "hono/factory";
import { routePath } from "hono/route";
import type { Context } from "hono";
import { createLogger } from "../log.js";
import type { AppEnv } from "../types.js";

/**
 * The route pattern this request matched — `/api/students/:id`, never
 * `/api/students/2f1c-…`.
 *
 * This is the whole reason the log records a pattern rather than `c.req.path`.
 * A student id is a pseudonymous identifier for a real teenager, Cloudflare
 * retains logs, and the pattern carries every bit of the operational signal
 * (which endpoint, how often, how slow, what status) with none of the
 * identifier. It also groups: "p95 of /api/students/:id/recommendations" is a
 * query you can write against patterns and cannot write against raw paths.
 *
 * `routePath(c, -1)` reads the *last* matched route rather than the currently
 * executing one, which is what makes this work from the outermost middleware.
 * It also stays correct when a guard short-circuits: requireOwner answering 403
 * before the handler runs still reports the route the caller was reaching for,
 * because the match happened whether or not the handler executed.
 *
 * Null when nothing concrete matched. Hono's match includes the `*` middleware
 * entries, so an unrouted path resolves to one of those (or to "" when it falls
 * outside /api entirely) — neither is a route, and reporting "/api/*" as though
 * it were would quietly turn every 404 into a phantom endpoint.
 */
export function matchedRoute(c: Context<AppEnv>): string | null {
  const path = routePath(c, -1);
  if (!path || path.endsWith("*")) return null;
  return path;
}

/**
 * Level by status: below 500 is information, 500 and up is an error.
 *
 * The tempting mapping is 4xx → warn. It is wrong for this API. A 401 on
 * /api/auth/me is what *every* first-time visitor gets — it is the mechanism by
 * which the frontend learns to show a signed-out state — and a 404 is a bot
 * trying paths. Making routine traffic warn costs the warn level its meaning,
 * and then a real warning is one line among thousands. The status is its own
 * field; filter on it directly.
 */
function levelFor(status: number): "info" | "error" {
  return status >= 500 ? "error" : "info";
}

export const requestLog = createMiddleware<AppEnv>(async (c, next) => {
  const started = Date.now();

  try {
    await next();
  } finally {
    // `finally` rather than logging after `next()`: Hono's compose catches a
    // thrown Error at the frame that threw and converts it via onError, so this
    // normally resumes with c.res already set to the 500. A non-Error throw is
    // the exception it re-raises, and that is the request most worth having a
    // line for. Nothing is caught here — the throw continues on its way.
    const status = c.finalized ? c.res.status : 500;
    const route = matchedRoute(c);

    // Health checks are the one route a monitor hits on a fixed interval
    // forever (Phase 8 puts UptimeRobot on it every few minutes). At info they
    // would eventually be most of the log by volume while saying the same thing
    // every time, so they drop to debug — still there when LOG_LEVEL=debug,
    // and out of the way of the traffic you are actually reading the log for.
    // A failing health check is a 503, which is >= 500 and logs as an error
    // regardless of this.
    const level = route === "/api/health" && status < 500 ? "debug" : levelFor(status);

    createLogger(c.env)[level]("request", {
      method: c.req.method,
      route,
      status,
      // Wall-clock, which on Workers means time spent in I/O: the runtime
      // freezes Date.now() between I/O operations, so a purely computational
      // request reads 0ms. That is the right measure here anyway — every slow
      // request in this app is slow because of D1 or an LLM call.
      ms: Date.now() - started,
      // Cloudflare's per-request id, and the join key between this line and any
      // error line from the same request. Absent under `wrangler dev` and in
      // tests; JSON.stringify drops the undefined rather than logging a null.
      ray: c.req.header("cf-ray"),
    });
  }
});
