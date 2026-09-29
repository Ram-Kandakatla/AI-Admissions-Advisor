// Sessions and ownership. Sessions are D1 rows rather than JWTs so that
// logout and "revoke everywhere" take effect on the next request.

import { createMiddleware } from "hono/factory";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnv, SessionRecord, StudentRecord } from "../types.js";

/** Sent as `__Host-compass_session` over https; see cookiePrefix. */
export const SESSION_COOKIE = "compass_session";

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

function isHttps(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === "https:";
}

/**
 * `__Host-` pins the cookie to this exact host, so a preview deployment on a
 * sibling subdomain cannot plant a session id. Browsers reject the prefix
 * without Secure, so plain-http local dev uses the bare name.
 */
function cookiePrefix(c: Context<AppEnv>): "host" | undefined {
  return isHttps(c) ? "host" : undefined;
}

/**
 * `secure` follows the request scheme so local http dev still gets a cookie.
 * If the frontend and API are ever split across origins, SameSite must become
 * None and CORS `credentials` must stay true, together.
 */
function cookieOptions(c: Context<AppEnv>) {
  return {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: "Lax" as const,
    path: "/",
    maxAge: THIRTY_DAYS_SECONDS,
    prefix: cookiePrefix(c),
  };
}

export function issueSessionCookie(c: Context<AppEnv>, session: SessionRecord): void {
  setCookie(c, SESSION_COOKIE, session.id, cookieOptions(c));
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, {
    path: "/",
    secure: isHttps(c),
    prefix: cookiePrefix(c),
  });
}

/**
 * Reads the session but never creates one, so crawlers and read-only traffic
 * cost no writes. See ensureSession.
 */
export const sessionContext = createMiddleware<AppEnv>(async (c, next) => {
  // Over https only the prefixed name is read; a bare-name fallback would
  // reopen the hole the prefix closes.
  const sessionId = getCookie(c, SESSION_COOKIE, cookiePrefix(c));
  const store = c.get("store");
  c.set("session", sessionId ? await store.getSession(sessionId) : null);

  // Space reclamation only; getSession already ignores expired rows.
  if (Math.random() < 0.01) {
    c.executionCtx.waitUntil(
      store.sweepSessions().catch(() => {}) // best-effort housekeeping
    );
  }

  await next();
});

/**
 * Creates a guest user and session on first need. A guest is a real user row,
 * so their profile is ownership-checked from the first write; signup later
 * fills in the same row.
 */
export async function ensureSession(c: Context<AppEnv>): Promise<SessionRecord> {
  const existing = c.get("session");
  if (existing) return existing;

  const store = c.get("store");
  const user = await store.createAnonymousUser();
  const session = await store.createSession(user.id);
  issueSessionCookie(c, session);
  c.set("session", session);
  return session;
}

/** A new session id at login and signup, against session fixation. */
export async function rotateSession(
  c: Context<AppEnv>,
  userId: number
): Promise<SessionRecord> {
  const store = c.get("store");
  const previous = c.get("session");
  if (previous) await store.deleteSession(previous.id);

  const session = await store.createSession(userId);
  issueSessionCookie(c, session);
  c.set("session", session);
  return session;
}

export async function ownedStudent(c: Context<AppEnv>): Promise<StudentRecord | null> {
  const session = c.get("session");
  if (!session) return null;
  return c.get("store").getStudentByUserId(session.userId);
}

/** For routes that take a student id outside the path (a query or a body). */
export async function ownsStudent(
  c: Context<AppEnv>,
  studentId: unknown
): Promise<boolean> {
  if (typeof studentId !== "string" || studentId === "") return false;
  const student = await ownedStudent(c);
  return student != null && student.id === studentId;
}

/**
 * 401 and 403 are distinct on purpose: the frontend sends a 401 to the sign-in
 * form, which would be wrong for a signed-in user asking for someone else's id.
 */
export const requireOwner = createMiddleware<AppEnv>(async (c, next) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "Not signed in" }, 401);

  const student = await c.get("store").getStudentByUserId(session.userId);
  if (!student || student.id !== c.req.param("id")) {
    return c.json({ error: "Forbidden" }, 403);
  }

  c.set("student", student);
  await next();
});
