// Rate limiting, rebuilt on D1.
//
// `express-rate-limit` kept its counters in the Node process's memory. A
// Worker has no process: each request may run in a different isolate, and any
// isolate can be discarded between requests, so an in-memory Map would let a
// caller reset their own limit just by being routed somewhere else. The count
// has to live in storage both requests can reach, and D1 is already bound.
//
// WHAT IS AND ISN'T LIMITED HERE
//
// Only /api/chat. That is the route that spends real money per call, and the
// one worth paying a D1 write to protect. The old global 300/15min limiter is
// deliberately NOT reimplemented in code — as a Cloudflare Rate Limiting Rule
// it runs at the edge, in front of the Worker, costs nothing per request, and
// needs no counter of its own. See PHASE-1.md for the rule to create at deploy
// time; until then the global limit genuinely does not exist locally, which is
// fine on a laptop and is the reason it is written down rather than assumed.

import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types.js";

export interface RateLimitOptions {
  /** Names the counter, so two limited routes never share a budget. */
  bucket: string;
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Body of the 429 response. */
  message: string;
}

/**
 * Identify the caller.
 *
 * `CF-Connecting-IP` is set by Cloudflare itself and cannot be forged by the
 * client — which is why this needs none of the `trust proxy` / X-Forwarded-For
 * hop counting the Express build had to get right. That whole class of
 * misconfiguration disappears on this platform.
 *
 * `wrangler dev` does set the header locally. The fallback exists only so a
 * request that somehow arrives without one is still counted — as a single
 * shared bucket, which is stricter than letting it through uncounted.
 */
function clientKey(headers: Headers): string {
  return headers.get("CF-Connecting-IP") ?? "unknown";
}

export function rateLimit({ bucket, limit, windowMs, message }: RateLimitOptions) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const db = c.env.DB;
    const client = clientKey(c.req.raw.headers);
    // Fixed windows rather than a sliding log: the window id is part of the
    // primary key, so a new window is a new row and nothing has to be expired
    // on a timer for the count to reset.
    const windowStart = Math.floor(Date.now() / windowMs);
    const resetAt = (windowStart + 1) * windowMs;

    let count: number;
    try {
      const row = await db
        .prepare(
          `INSERT INTO rate_limits (bucket, client, window_start, count)
           VALUES (?, ?, ?, 1)
           ON CONFLICT (bucket, client, window_start)
           DO UPDATE SET count = count + 1
           RETURNING count`
        )
        .bind(bucket, client, windowStart)
        .first<{ count: number }>();
      count = row?.count ?? 1;
    } catch (err) {
      // Fail open, loudly. Every route behind this limiter needs D1 for its
      // own work, so a D1 failure here means the request is about to fail
      // anyway — refusing it *as a rate limit* would report the wrong cause.
      console.error(
        JSON.stringify({
          level: "error",
          message: "rate limiter could not reach D1 — allowing the request",
          bucket,
          detail: err instanceof Error ? err.message : String(err),
        })
      );
      return next();
    }

    // Sweep old windows occasionally rather than on every write: this is
    // housekeeping, and making one in fifty callers pay for it keeps it off
    // the hot path. Rows only pile up for clients that stopped calling.
    if (Math.random() < 0.02) {
      c.executionCtx.waitUntil(
        db
          .prepare("DELETE FROM rate_limits WHERE window_start < ?")
          .bind(windowStart - 1)
          .run()
          .catch(() => {
            /* housekeeping — never worth failing a request over */
          })
      );
    }

    // The same header set express-rate-limit emitted with standardHeaders:true
    // and legacyHeaders:false, so any client already reading them is unaffected.
    c.header("RateLimit-Limit", String(limit));
    c.header("RateLimit-Remaining", String(Math.max(0, limit - count)));
    c.header("RateLimit-Reset", String(Math.ceil((resetAt - Date.now()) / 1000)));

    if (count > limit) {
      c.header("Retry-After", String(Math.ceil((resetAt - Date.now()) / 1000)));
      return c.json({ error: message }, 429);
    }

    return next();
  });
}
