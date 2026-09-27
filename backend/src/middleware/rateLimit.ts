// Rate limits counted in D1. Not in memory: each request may land in a
// different isolate, so a Map would reset whenever the caller is rerouted.
//
// Only routes where one caller can do outsized damage are limited here (chat,
// auth, guest profile creation). A global per-IP limit belongs in a Cloudflare
// rate limiting rule at the edge, not in code; see PHASE-7.md.

import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { sha256Hex } from "../crypto.js";
import { createLogger, errorFields } from "../log.js";
import type { AppEnv } from "../types.js";

export interface RateLimitOptions {
  /** Routes sharing a bucket name share one budget. */
  bucket: string;
  limit: number;
  windowMs: number;
  /** Body of the 429 response. */
  message: string;
  /** Key the caller by something other than IP; null falls back to the IP. */
  key?: (c: Context<AppEnv>) => Promise<string | null> | string | null;
}

/**
 * Anything that could identify a person is hashed before it is stored, as the
 * privacy page promises. An unkeyed hash of an IP or email is reversible by
 * brute force, so this keeps values out of plain sight; it does not anonymise.
 */
export async function hashedKey(label: string, value: string): Promise<string> {
  return `${label}:${await sha256Hex(value)}`;
}

/**
 * CF-Connecting-IP is set by Cloudflare and cannot be forged by the client. A
 * request without it shares one "unknown" bucket rather than going uncounted.
 */
async function clientKey(headers: Headers): Promise<string> {
  const ip = headers.get("CF-Connecting-IP");
  return ip ? hashedKey("ip", ip) : "unknown";
}

/**
 * Also used directly to cap sign-up emails per address. Throws if D1 does;
 * each caller decides whether that fails open or closed.
 */
export async function countHit(
  c: Context<AppEnv>,
  bucket: string,
  client: string,
  windowMs: number
): Promise<{ count: number; resetAt: number }> {
  const db = c.env.DB;
  // Fixed windows: the window id is in the primary key, so a new window is a
  // new row and nothing needs expiring for the count to reset.
  const windowStart = Math.floor(Date.now() / windowMs);

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

  // Occasional sweep of old windows. It must stay scoped to this bucket:
  // window_start is in units of this bucket's window, so comparing it against
  // a bucket with a longer window would delete that bucket's live counters.
  if (Math.random() < 0.02) {
    c.executionCtx.waitUntil(
      db
        .prepare("DELETE FROM rate_limits WHERE bucket = ? AND window_start < ?")
        .bind(bucket, windowStart - 1)
        .run()
        .catch(() => {}) // best-effort housekeeping
    );
  }

  return { count: row?.count ?? 1, resetAt: (windowStart + 1) * windowMs };
}

export function rateLimit({ bucket, limit, windowMs, message, key }: RateLimitOptions) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const client = (key ? await key(c) : null) ?? (await clientKey(c.req.raw.headers));

    let hit: { count: number; resetAt: number };
    try {
      hit = await countHit(c, bucket, client, windowMs);
    } catch (err) {
      // Fail open: the route needs D1 too, so it will fail with the real cause.
      createLogger(c.env).error("rate limiter could not reach D1 — allowing the request", {
        bucket,
        ...errorFields(err),
      });
      return next();
    }

    const secondsLeft = String(Math.ceil((hit.resetAt - Date.now()) / 1000));
    c.header("RateLimit-Limit", String(limit));
    c.header("RateLimit-Remaining", String(Math.max(0, limit - hit.count)));
    c.header("RateLimit-Reset", secondsLeft);

    if (hit.count > limit) {
      c.header("Retry-After", secondsLeft);
      return c.json({ error: message }, 429);
    }

    return next();
  });
}
