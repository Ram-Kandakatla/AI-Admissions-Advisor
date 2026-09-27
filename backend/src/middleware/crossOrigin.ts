// Refuses cross-origin writes. SameSite=Lax is not enough on its own: every
// preview deployment under workers.dev is the same *site* as production, and a
// text/plain POST skips CORS preflight. Same rule as Go's
// http.CrossOriginProtection. Not hono/csrf, which also 403s non-browser
// clients (curl, a body-less DELETE) that carry neither header.

import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { AppEnv, Env } from "../types.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Shared with the CORS middleware so the read and write allowlists cannot drift. */
export function allowedOrigins(env: Env): string[] {
  return (env.CORS_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/** The request's own origin always counts, so each preview can call its own API. */
function isTrusted(c: Context<AppEnv>, origin: string): boolean {
  return origin === new URL(c.req.url).origin || allowedOrigins(c.env).includes(origin);
}

export const crossOriginGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  // "none" means the user started it directly (typed URL, bookmark).
  const site = c.req.header("sec-fetch-site");
  if (site === "same-origin" || site === "none") return next();

  const origin = c.req.header("origin");
  if (origin !== undefined) {
    // `Origin: null` — a sandboxed frame, a data: URL — is never trusted.
    if (isTrusted(c, origin)) return next();
    return refuse(c);
  }

  if (site !== undefined) return refuse(c);

  // Neither header: not a browser, so not a CSRF vector.
  return next();
});

function refuse(c: Context<AppEnv>) {
  return c.json({ error: "Cross-origin request refused." }, 403);
}
