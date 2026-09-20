// Refusing cross-origin writes.
//
// WHY THIS EXISTS WHEN THE COOKIE IS ALREADY SameSite=Lax
//
// SameSite is decided by *site*, not by origin, and on Cloudflare the site is
// the deployed hostname under `workers.dev` (`pages.dev` before the 2026-09-18
// migration — the reasoning is unchanged because both are on the public suffix
// list). That means every preview deployment and every branch alias is the same
// site as production. A page on any of them can POST to the production API and
// the browser attaches the session cookie. wrangler.toml already calls previews
// what they are — unreviewed code.
//
// Non-production builds are currently disabled, so no such sibling host exists
// right now. That is a dashboard setting and one checkbox away from being
// untrue, which is exactly why this guard is in code rather than in the deploy
// configuration.
//
// CORS does not stop that. It decides whether a page may *read* a response,
// not whether the request is sent, and a `text/plain` POST is a "simple"
// request that goes out with no preflight at all. readJson parses a body
// whatever its Content-Type, so such a request is served in full.
//
// THE RULE
//
// A state-changing request that a browser marks as coming from another origin
// must come from an allowlisted one. Browsers attach `Origin` to every non-GET
// request, and current ones attach `Sec-Fetch-Site` to everything, so a
// browser-made cross-origin write always carries at least one of the two —
// neither can be set by page script. A request with *neither* did not come from
// a browser (curl, a health check, a server), and CSRF is by definition an
// attack carried out through a victim's browser, so it is let through. This is
// the same rule as Go's http.CrossOriginProtection.
//
// WHY NOT hono/csrf
//
// It is close, but it refuses a request that has neither header whenever the
// body is form-typed or absent, so every curl DELETE and every non-browser
// client would get a 403 for no security gain.

import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { AppEnv, Env } from "../types.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The origins allowed to call this API from a browser, from CORS_ORIGIN.
 *
 * Shared with the CORS middleware in app.ts, so the list that decides who may
 * read a response and the list that decides who may send a write can never
 * drift apart.
 */
export function allowedOrigins(env: Env): string[] {
  return (env.CORS_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * The request's own origin always counts, which is what keeps preview
 * deployments working: each serves its frontend and its API from the same
 * host, and no static list could name those in advance. What a preview cannot
 * do is write to *another* host's API.
 */
function isTrusted(c: Context<AppEnv>, origin: string): boolean {
  return origin === new URL(c.req.url).origin || allowedOrigins(c.env).includes(origin);
}

export const crossOriginGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  // The browser's own verdict. "none" is a request the user started directly
  // (a typed URL, a bookmark), which no other page can have caused.
  const site = c.req.header("sec-fetch-site");
  if (site === "same-origin" || site === "none") return next();

  const origin = c.req.header("origin");
  if (origin !== undefined) {
    // `Origin: null` — a sandboxed frame, a data: URL — is never trusted.
    if (isTrusted(c, origin)) return next();
    return refuse(c);
  }

  // A browser that calls a write cross-site but sends no Origin should not
  // exist. Refuse rather than guess.
  if (site !== undefined) return refuse(c);

  // Neither header: not a browser, so not a CSRF vector.
  return next();
});

function refuse(c: Context<AppEnv>) {
  return c.json({ error: "Cross-origin request refused." }, 403);
}
