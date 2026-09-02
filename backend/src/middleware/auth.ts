// Sessions and ownership.
//
// WHY SESSIONS RATHER THAN A JWT
//
// A JWT is a claim the server cannot take back: once signed, it is valid until
// it expires, so "log out everywhere" and "this account was compromised" have
// no server-side answer short of rotating the signing key for everyone. A
// session id is a row — logout is a DELETE, and it takes effect on the next
// request. The cost is one indexed primary-key read per request, which is the
// cheapest thing D1 does.
//
// The cookie is httpOnly, so no injected script can read it, and SameSite=Lax,
// so another site cannot make an authenticated request on the visitor's behalf
// while still allowing an ordinary top-level link into the app to work.

import { createMiddleware } from "hono/factory";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnv, SessionRecord, StudentRecord } from "../types.js";

export const SESSION_COOKIE = "compass_session";

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

/**
 * Cookie attributes.
 *
 * `secure` is derived from the request rather than hard-coded. A Secure cookie
 * is dropped outright over plain http, which is what `wrangler dev` serves on
 * localhost — hard-coding it true would make local development silently
 * sessionless, and hard-coding it false would ship an insecure cookie. Reading
 * the scheme gets both right with no environment flag to set wrong.
 *
 * SameSite: Lax suits Phase 7's Option A, where the frontend and API share one
 * Pages origin. If Option B ever splits them across origins this must become
 * `None` (which additionally requires `secure`), and the CORS middleware's
 * `credentials` must stay true — noted here because those two settings have to
 * change together or the cookie simply stops being sent.
 */
function cookieOptions(c: Context<AppEnv>) {
  return {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax" as const,
    path: "/",
    maxAge: THIRTY_DAYS_SECONDS,
  };
}

export function issueSessionCookie(c: Context<AppEnv>, session: SessionRecord): void {
  setCookie(c, SESSION_COOKIE, session.id, cookieOptions(c));
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/**
 * Resolve the caller's session onto the context, for every request.
 *
 * Deliberately does NOT create one. A crawler hitting the homepage, a health
 * check, a bot scraping /api/universities — none of those own anything, and
 * minting a users row plus a sessions row for each would turn read-only
 * traffic into two writes. The session is created lazily by ensureSession(),
 * at the first moment the caller actually needs to own something.
 */
export const sessionContext = createMiddleware<AppEnv>(async (c, next) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  const store = c.get("store");
  c.set("session", sessionId ? await store.getSession(sessionId) : null);

  // Expired rows are already unreadable — getSession filters on expires_at —
  // so this reclaims space rather than enforcing anything. Same one-in-many
  // approach the rate-limit sweep uses, and for the same reason: housekeeping
  // does not belong on the hot path of every request.
  if (Math.random() < 0.01) {
    c.executionCtx.waitUntil(
      store.sweepSessions().catch(() => {
        /* housekeeping — never worth failing a request over */
      })
    );
  }

  await next();
});

/**
 * Get the caller's session, creating an anonymous one if they have none.
 *
 * This is what keeps the product's "no account needed" front door open without
 * reopening the ownership hole: a guest is a real user row with a real session,
 * so their profile is owned and ownership-checked from the first write. The
 * only thing they lack is an email and a password, which signup fills in later
 * on the very same row.
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

/**
 * Replace the caller's session with a fresh one for `userId`.
 *
 * Called on both login and signup, and the reason is session fixation: if an
 * attacker can get a victim to browse with a session id the attacker already
 * knows, then without rotation that same id becomes an authenticated session
 * the moment the victim logs in. A new id at the privilege boundary makes the
 * pre-login value worthless.
 */
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

/** The profile this session may touch, or null if it has none yet. */
export async function ownedStudent(c: Context<AppEnv>): Promise<StudentRecord | null> {
  const session = c.get("session");
  if (!session) return null;
  return c.get("store").getStudentByUserId(session.userId);
}

/**
 * True only if the caller owns `studentId`.
 *
 * Exported because two routes take a student id somewhere other than the path
 * — `GET /majors/:major?studentId=` and `POST /chat`'s body — and both hand
 * back profile-derived output. A path-only ownership check would leave those
 * two reading any profile whose id a caller could produce.
 */
export async function ownsStudent(
  c: Context<AppEnv>,
  studentId: unknown
): Promise<boolean> {
  if (typeof studentId !== "string" || studentId === "") return false;
  const student = await ownedStudent(c);
  return student != null && student.id === studentId;
}

/**
 * Gate every /students/:id route on ownership.
 *
 * 401 and 403 say different things on purpose: 401 means "no usable session,
 * sign in", which the client turns into a login screen; 403 means "you are
 * someone, just not this someone", which it must not. Collapsing them into one
 * status would make a signed-in user poking at another id look identical to a
 * signed-out user, and the frontend would bounce them to a login form they
 * have already completed.
 *
 * The student is put on the context so routes behind this do not re-read it —
 * and so requireStudent's existence check becomes redundant here: a profile
 * the session owns necessarily exists.
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
