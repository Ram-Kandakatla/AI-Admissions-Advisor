// Account routes.
//
//   POST /api/auth/signup   { email, password }  → claims the caller's guest
//                                                  row, or makes a new account
//   POST /api/auth/login    { email, password }  → new session for that account
//   POST /api/auth/logout                        → revokes the session
//   GET  /api/auth/me                            → who the caller is, if anyone
//   DELETE /api/auth/account { password?, confirm } → erases the account and
//                                                     everything it owns
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
// Deletion re-checks the password, which makes it a third place a password can
// be guessed against — and the only one where a correct guess destroys data
// instead of merely reading it. Same budget as the other two.
auth.use(
  "/account",
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

/**
 * The word a caller has to send to prove they mean it.
 *
 * Not a CSRF defence — the session cookie is SameSite=Lax, so a cross-site
 * DELETE never carries it, and this would be a poor defence anyway since any
 * attacker who can read the docs can send the string. What it defends against
 * is a mis-wired client: a stray or retried request to the one endpoint in
 * this app that destroys data should not succeed by accident, and requiring a
 * body that cannot be produced without intent is a cheap way to say so. It
 * also gives the UI a natural type-to-confirm to bind to.
 */
const CONFIRM_PHRASE = "DELETE";

/**
 * Erase the caller's account and everything attached to it.
 *
 * WHY THIS EXISTS
 *
 * The privacy policy used to admit that it did not. Every self-serve right the
 * page claims — see, correct, export — was true, and the one that matters most
 * to a person who has changed their mind was a request to an inbox. For an app
 * whose users are mostly minors, "email us and we will do it by hand" is the
 * weakest possible answer, and it is the answer this route removes.
 *
 * WHY A MEMBER HAS TO RETYPE THEIR PASSWORD
 *
 * The session alone is not enough authority for an irreversible destruction of
 * everything the person has built. A borrowed laptop, an unlocked phone, or a
 * shared library machine is a realistic way for someone else to be holding a
 * valid session, and every one of those is a case where a second factor the
 * attacker does not have is exactly the right barrier. This is the same reason
 * GitHub, Google and everyone else re-prompt here.
 *
 * WHY A GUEST DOES NOT
 *
 * Because there is no password to retype — an anonymous account has a NULL
 * password_hash by construction, and asking for one would be asking for
 * something that cannot exist. For a guest the session cookie *is* the whole
 * of the credential, so it is also the whole of what can be checked. That is
 * not a weakening: a guest's data is already reachable by exactly whoever
 * holds that cookie, and letting them wipe it is strictly better than making
 * them leave it behind on a shared computer.
 *
 * A wrong password is 403, not 401. The session is valid — 401 would tell the
 * frontend the caller had been signed out and send them to a login screen,
 * which is both untrue and a confusing answer to a typo.
 */
auth.delete("/account", async (c) => {
  const session = c.get("session");
  if (!session) {
    return c.json({ error: "You need to be signed in to delete an account." }, 401);
  }

  const body = await readJson<Record<string, unknown>>(c);
  if (body.confirm !== CONFIRM_PHRASE) {
    return c.json(
      { error: `Send "confirm": "${CONFIRM_PHRASE}" to delete this account.` },
      400
    );
  }

  const store = c.get("store");
  const user = await store.getUser(session.userId);
  if (!user) {
    // The session outlived its user row — already gone, by another tab or a
    // previous half-finished attempt. Treat it as done rather than as an
    // error: the caller wanted this account gone, and it is.
    clearSessionCookie(c);
    c.set("session", null);
    return c.body(null, 204);
  }

  if (!user.guest) {
    // A real account. Re-authenticate before destroying anything.
    const row = user.email ? await store.findUserForLogin(user.email) : null;
    const password = typeof body.password === "string" ? body.password : "";

    // fakeVerify on the missing-row path for the same reason login does it:
    // never let the shape of a failure be inferred from how long it took.
    const ok = row
      ? await verifyPassword(password, row.password_hash)
      : await fakeVerify(password);

    if (!ok || !row) {
      return c.json({ error: "That password is not correct." }, 403);
    }
  }

  const { hadProfile } = await store.deleteAccount(user.id);

  // The session row went with the user (sessions cascade), so the cookie now
  // names nothing. Clearing it stops the browser re-sending a dead id forever,
  // and unsetting it on the context keeps this request's own later middleware
  // from reading a session that no longer exists.
  clearSessionCookie(c);
  c.set("session", null);

  // 200 rather than 204: the client shows a short confirmation afterwards and
  // `hadProfile` is what lets it say "your profile and everything in it" only
  // when that is true. A body of nothing would make that a guess.
  return c.json({ deleted: true, hadProfile });
});

export default auth;
