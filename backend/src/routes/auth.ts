// Account routes.
//
//   POST /api/auth/signup   { email, password }  → claims the caller's guest
//                                                  row, or makes a new account
//   POST /api/auth/login    { email, password }  → new session for that account
//   POST /api/auth/logout                        → revokes the session
//   GET  /api/auth/me                            → who the caller is, if anyone
//
// Signup is a *claim*, not a create: the caller almost always already has an
// anonymous user row holding the profile they just built, and signing up fills
// in that row's email and password rather than making a second one. That is
// what lets the product keep its no-account front door without leaving
// unowned profiles behind.

import { Hono } from "hono";
import { hashPassword, verifyPassword, fakeVerify } from "../auth/password.js";
import {
  clearSessionCookie,
  ensureSession,
  ownedStudent,
  rotateSession,
} from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { readJson } from "../http.js";
import type { AppEnv } from "../types.js";

const auth = new Hono<AppEnv>();

// Passwords are the one thing here worth guessing at scale, so both routes
// that check one are limited. This is stricter than /api/chat's budget because
// a human signing in needs a handful of attempts, not thirty.
auth.use(
  "/login",
  rateLimit({
    bucket: "auth",
    limit: 15,
    windowMs: 15 * 60 * 1000,
    message: "Too many sign-in attempts. Please wait a few minutes and try again.",
  })
);
auth.use(
  "/signup",
  rateLimit({
    bucket: "auth",
    limit: 15,
    windowMs: 15 * 60 * 1000,
    message: "Too many attempts. Please wait a few minutes and try again.",
  })
);

/** Long enough to be a real password, capped so nobody can hand PBKDF2 a
 *  megabyte of input and bill us the CPU for hashing it. */
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const MAX_EMAIL = 254; // RFC 5321's limit on a forward path.

interface Credentials {
  email: string;
  password: string;
}

/**
 * Validate a submitted email/password pair.
 *
 * The email check is deliberately shallow — one @, something either side, no
 * spaces. Stricter regexes reject valid addresses far more often than they
 * catch invalid ones, and the only real proof an address works is sending to
 * it, which this app does not do yet.
 */
function validateCredentials(body: Record<string, unknown>): {
  errors: string[];
  credentials: Credentials;
} {
  const errors: string[] = [];
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email) errors.push("Email is required.");
  else if (email.length > MAX_EMAIL) errors.push("That email address is too long.");
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("Enter a valid email address.");
  }

  if (!password) errors.push("Password is required.");
  else if (password.length < MIN_PASSWORD) {
    errors.push(`Password must be at least ${MIN_PASSWORD} characters.`);
  } else if (password.length > MAX_PASSWORD) {
    errors.push(`Password must be under ${MAX_PASSWORD} characters.`);
  }

  return { errors, credentials: { email, password } };
}

auth.post("/signup", async (c) => {
  const store = c.get("store");
  const { errors, credentials } = validateCredentials(
    await readJson<Record<string, unknown>>(c)
  );
  if (errors.length) return c.json({ errors }, 400);

  // Already signed in as a real account. Creating a second account from this
  // session would orphan the first one's session silently; making the caller
  // sign out first is the honest response.
  const current = c.get("session");
  if (current) {
    const user = await store.getUser(current.userId);
    if (user && !user.guest) {
      return c.json({ error: "You're already signed in. Sign out first." }, 409);
    }
  }

  if (await store.emailTaken(credentials.email)) {
    return c.json({ error: "An account with that email already exists." }, 409);
  }

  // Creates the anonymous row if this is a cold visitor; returns the row
  // already holding their guest profile if it isn't.
  const session = await ensureSession(c);
  const passwordHash = await hashPassword(credentials.password);
  const user = await store.claimUser(session.userId, credentials.email, passwordHash);

  // Null means the row stopped being a guest between the check above and the
  // write — two signups racing on one session. Reporting it as the conflict it
  // is beats overwriting whichever one lost.
  if (!user) {
    return c.json({ error: "That account was just created. Try signing in." }, 409);
  }

  await rotateSession(c, user.id);
  const student = await ownedStudent(c);
  return c.json({ user, studentId: student?.id ?? null }, 201);
});

auth.post("/login", async (c) => {
  const store = c.get("store");
  const { errors, credentials } = validateCredentials(
    await readJson<Record<string, unknown>>(c)
  );
  if (errors.length) return c.json({ errors }, 400);

  const row = await store.findUserForLogin(credentials.email);

  // One message for both "no such account" and "wrong password", and — via
  // fakeVerify — one timing profile too. Either half alone is an account
  // enumeration oracle: a stopwatch tells you which emails are registered just
  // as well as a distinct error message does.
  const ok = row
    ? await verifyPassword(credentials.password, row.password_hash)
    : await fakeVerify(credentials.password);

  if (!ok || !row) {
    return c.json({ error: "That email and password don't match an account." }, 401);
  }

  // Whether the guest draft this session was carrying is about to be left
  // behind. The account's own profile wins — it is the one the person has
  // deliberately saved — but the UI should be able to say so rather than
  // appearing to lose work silently.
  const guestDraft = await ownedStudent(c);

  await rotateSession(c, row.id);
  const student = await store.getStudentByUserId(row.id);

  return c.json({
    user: { id: row.id, email: row.email, guest: false, createdAt: row.created_at },
    studentId: student?.id ?? null,
    discardedGuestProfile: guestDraft != null && guestDraft.id !== student?.id,
  });
});

auth.post("/logout", async (c) => {
  const session = c.get("session");
  if (session) await c.get("store").deleteSession(session.id);
  // Cleared even with no session, so a stale or unparseable cookie is disposed
  // of rather than being re-sent on every subsequent request forever.
  clearSessionCookie(c);
  c.set("session", null);
  return c.body(null, 204);
});

auth.get("/me", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ user: null, studentId: null });

  const store = c.get("store");
  const user = await store.getUser(session.userId);
  if (!user) {
    // The session outlived its user row. Nothing to authenticate as.
    clearSessionCookie(c);
    return c.json({ user: null, studentId: null });
  }

  const student = await store.getStudentByUserId(user.id);
  return c.json({ user, studentId: student?.id ?? null });
});

export default auth;
