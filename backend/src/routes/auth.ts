// Account routes, mounted at /api/auth; see backend/README.md for the list.
//
// Signup claims the caller's existing guest row rather than creating a new
// user, so the profile they built as a guest stays theirs.

import { Hono } from "hono";
import {
  hashPassword,
  verifyPassword,
  fakeVerify,
  needsRehash,
  generateResetToken,
  hashResetToken,
} from "../auth/password.js";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "../auth/totp.js";
import {
  CLAIM_HOLD_MS,
  describeWait,
  waitAfter,
  type FirstFactor,
} from "../auth/secondFactorLimit.js";
import {
  clearSessionCookie,
  ensureSession,
  ownedStudent,
  rotateSession,
} from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { readJson } from "../http.js";
import type { Context } from "hono";
import type { AppEnv } from "../types.js";

const auth = new Hono<AppEnv>();

// Every route that checks a password shares the "auth" bucket.
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
// Deletion re-checks the password.
auth.use(
  "/account",
  rateLimit({
    bucket: "auth",
    limit: 15,
    windowMs: 15 * 60 * 1000,
    message: "Too many attempts. Please wait a few minutes and try again.",
  })
);

// Per network only. Guessing from many IPs is bounded by the per-account
// count in verifySecondFactor.
auth.use(
  "/2fa/*",
  rateLimit({
    bucket: "auth",
    limit: 15,
    windowMs: 15 * 60 * 1000,
    message: "Too many attempts. Please wait a few minutes and try again.",
  })
);

/** The max stops a megabyte-long password from burning PBKDF2 CPU. */
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const MAX_EMAIL = 254; // RFC 5321's limit on a forward path.

interface Credentials {
  email: string;
  password: string;
}

/** A shallow email check on purpose; the confirmation email is the real test. */
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

/**
 * Creates the account on the spot by filling in the caller's guest row, so
 * the profile they built as a guest stays theirs. A taken address gets a 409.
 */
auth.post("/signup", async (c) => {
  const store = c.get("store");
  const { errors, credentials } = validateCredentials(
    await readJson<Record<string, unknown>>(c)
  );
  if (errors.length) return c.json({ errors }, 400);

  // A member must sign out first rather than silently lose this session.
  const current = c.get("session");
  if (current) {
    const user = await store.getUser(current.userId);
    if (user && !user.guest) {
      return c.json({ error: "You're already signed in. Sign out first." }, 409);
    }
  }

  // The guest row this signup claims, minted now for a visitor who has none.
  const session = await ensureSession(c);
  const { email, password } = credentials;

  // Read before the session changes, so the UI can say if a draft is left behind.
  const guestDraft = await ownedStudent(c);

  const result = await store.claimGuestAccount(
    email,
    await hashPassword(password),
    session.userId
  );
  if (result.status === "email-taken") {
    return c.json({ error: "This email already has a Compass account. Sign in instead." }, 409);
  }

  await rotateSession(c, result.user.id);
  const student = await store.getStudentByUserId(result.user.id);

  return c.json({
    user: await store.getUser(result.user.id),
    studentId: student?.id ?? null,
    discardedGuestProfile: guestDraft != null && guestDraft.id !== student?.id,
  });
});

/**
 * Accepts a TOTP or a recovery code everywhere, so no caller can forget
 * recovery codes. A matched TOTP step is consumed against replay. Call only
 * through verifySecondFactor.
 */
async function checkCode(
  c: Context<AppEnv>,
  userId: number,
  secret: string,
  typed: string
): Promise<{ ok: boolean; usedRecoveryCode: boolean; remaining?: number }> {
  const store = c.get("store");

  if (/^[\d\s-]{6,10}$/.test(typed)) {
    const { valid, step } = await verifyTotp(secret, typed);
    if (!valid) return { ok: false, usedRecoveryCode: false };
    // A step already spent is a replay.
    const fresh = await store.consumeTotpStep(userId, step);
    return { ok: fresh, usedRecoveryCode: false };
  }

  const spent = await store.consumeRecoveryCode(userId, await hashRecoveryCode(typed));
  if (!spent) return { ok: false, usedRecoveryCode: false };
  const { remaining } = await store.countRecoveryCodesLeft(userId);
  return { ok: true, usedRecoveryCode: true, remaining };
}

/**
 * Charges each attempt to the account, since per-network limits don't stop a
 * pool of IPs; see auth/secondFactorLimit.ts. `retryAfterMs` means locked and
 * nothing was checked. Empty codes don't count.
 */
async function verifySecondFactor(
  c: Context<AppEnv>,
  userId: number,
  code: string,
  factor: FirstFactor
): Promise<{ ok: boolean; usedRecoveryCode: boolean; remaining?: number; retryAfterMs?: number }> {
  const store = c.get("store");
  const typed = code.trim();
  if (!typed) return { ok: false, usedRecoveryCode: false };

  const state = await store.getTotpState(userId);
  if (!state?.secret) return { ok: false, usedRecoveryCode: false };

  // Claim first: a locked attempt must not test a code or spend a recovery code.
  const claim = await store.claimSecondFactorAttempt(userId, factor, CLAIM_HOLD_MS);
  if (!claim.claimed) {
    return { ok: false, usedRecoveryCode: false, retryAfterMs: claim.retryAfterMs };
  }

  const result = await checkCode(c, userId, state.secret, typed);
  if (result.ok) await store.clearSecondFactorAttempts(userId);
  else await store.recordSecondFactorFailure(userId, factor, waitAfter(claim.failures + 1));
  return result;
}

function tooManyCodes(
  c: Context<AppEnv>,
  retryAfterMs: number,
  extra: Record<string, unknown> = {}
) {
  c.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  // Only shown to someone already past the password.
  return c.json(
    {
      error: `Too many incorrect codes. For this account's protection, try again in ${describeWait(retryAfterMs)}. If these weren't your attempts, someone may know your password.`,
      ...extra,
    },
    429
  );
}

/**
 * Carries "password already checked" to the code step. Not a half-signed-in
 * session: every ownership check would then need to know about that state.
 */
async function issueMfaChallenge(c: Context<AppEnv>, userId: number): Promise<string> {
  const token = generateResetToken();
  await c.get("store").createMfaChallenge(userId, await hashResetToken(token), "login");
  return token;
}

auth.post("/login", async (c) => {
  const store = c.get("store");
  const { errors, credentials } = validateCredentials(
    await readJson<Record<string, unknown>>(c)
  );
  if (errors.length) return c.json({ errors }, 400);

  const row = await store.findUserForLogin(credentials.email);

  // Same message and (via fakeVerify) same timing for unknown email and wrong
  // password, so neither reveals which emails are registered.
  const ok = row
    ? await verifyPassword(credentials.password, row.password_hash)
    : await fakeVerify(credentials.password);

  if (!ok || !row) {
    return c.json(
      { error: "That email and password don't match an account." },
      401
    );
  }

  // Upgrade an old-cost hash while the plaintext is in hand; see needsRehash.
  const previousHash = row.password_hash;
  if (previousHash && needsRehash(previousHash)) {
    const userId = row.id;
    c.executionCtx.waitUntil(
      hashPassword(credentials.password).then((upgraded) =>
        store.rehashPassword(userId, previousHash, upgraded)
      )
    );
  }

  // With 2FA on, stop before any session exists and hand back a challenge.
  // The guest draft stays untouched until the second factor succeeds.
  const totp = await store.getTotpState(row.id);
  if (totp?.enabled) {
    return c.json({ mfaRequired: true, challenge: await issueMfaChallenge(c, row.id) });
  }

  // The account's profile wins over a guest draft; the UI says so.
  const guestDraft = await ownedStudent(c);

  await rotateSession(c, row.id);
  const student = await store.getStudentByUserId(row.id);

  return c.json({
    // From the store, not built from `row`, so new UserRecord fields aren't missed.
    user: await store.getUser(row.id),
    studentId: student?.id ?? null,
    discardedGuestProfile: guestDraft != null && guestDraft.id !== student?.id,
  });
});

/**
 * The challenge is spent even on a wrong code, or its five-minute window
 * would be an unlimited guessing budget.
 */
auth.post("/2fa/verify", async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const challenge = typeof body.challenge === "string" ? body.challenge.trim() : "";
  const code = typeof body.code === "string" ? body.code : "";

  const store = c.get("store");
  const found = challenge
    ? await store.findMfaChallenge(await hashResetToken(challenge), "login")
    : null;
  if (!found) {
    return c.json({ error: "This sign-in attempt has expired. Please sign in again." }, 400);
  }

  await store.deleteMfaChallenge(await hashResetToken(challenge));

  const result = await verifySecondFactor(c, found.userId, code, "password");
  if (result.retryAfterMs !== undefined) return tooManyCodes(c, result.retryAfterMs);
  if (!result.ok) {
    return c.json(
      { error: "That code isn't right. Please sign in again to get a new attempt." },
      401
    );
  }

  const guestDraft = await ownedStudent(c);
  await rotateSession(c, found.userId);
  const student = await store.getStudentByUserId(found.userId);

  return c.json({
    user: await store.getUser(found.userId),
    studentId: student?.id ?? null,
    discardedGuestProfile: guestDraft != null && guestDraft.id !== student?.id,
    usedRecoveryCode: result.usedRecoveryCode,
    recoveryCodesRemaining: result.remaining,
  });
});

auth.post("/logout", async (c) => {
  const session = c.get("session");
  if (session) await c.get("store").deleteSession(session.id);
  // Cleared even with no session, so a stale cookie isn't re-sent forever.
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

/** Guards against a stray or retried request from a buggy client, not CSRF. */
const CONFIRM_PHRASE = "DELETE";

/**
 * Members retype their password: a session alone (a borrowed laptop) is not
 * enough to destroy everything. Guests have no password, and their cookie is
 * already the whole credential. A wrong password is 403, since a 401 would
 * make the frontend sign them out over a typo.
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
    // Already deleted (another tab); the caller's goal is met.
    clearSessionCookie(c);
    c.set("session", null);
    return c.body(null, 204);
  }

  if (!user.guest) {
    const row = user.email ? await store.findUserForLogin(user.email) : null;
    const password = typeof body.password === "string" ? body.password : "";

    const ok = row
      ? await verifyPassword(password, row.password_hash)
      : await fakeVerify(password);

    if (!ok || !row) {
      return c.json({ error: "That password is not correct." }, 403);
    }
  }

  const { hadProfile } = await store.deleteAccount(user.id);

  clearSessionCookie(c);
  c.set("session", null);

  // `hadProfile` lets the confirmation mention the profile only if there was one.
  return c.json({ deleted: true, hadProfile });
});

/* ------------------------------------------------- Enrollment and teardown */

/**
 * Re-checks the password: a session alone can't change how the account is
 * protected. Returns a Response on failure.
 */
async function requirePasswordReauth(
  c: Context<AppEnv>,
  password: unknown
): Promise<{ userId: number } | Response> {
  const session = c.get("session");
  if (!session) return c.json({ error: "You need to be signed in." }, 401);

  const store = c.get("store");
  const user = await store.getUser(session.userId);
  if (!user || user.guest || !user.email) {
    return c.json({ error: "Create an account first." }, 403);
  }

  const row = await store.findUserForLogin(user.email);
  const typed = typeof password === "string" ? password : "";
  const ok = row ? await verifyPassword(typed, row.password_hash) : await fakeVerify(typed);
  if (!ok || !row) return c.json({ error: "That password is not correct." }, 403);

  return { userId: user.id };
}

/**
 * Stages an unconfirmed secret; 2FA stays off until /2fa/enable sees a working
 * code, so a mistyped key can't lock anyone out. With 2FA already on, this
 * replaces the factor, so like /2fa/disable it also needs a current code (a
 * recovery code works, for a lost phone).
 */
auth.post("/2fa/setup", async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const auth_ = await requirePasswordReauth(c, body.password);
  if (auth_ instanceof Response) return auth_;

  const store = c.get("store");
  const user = await store.getUser(auth_.userId);
  const secret = generateTotpSecret();
  const alreadyOn = () =>
    c.json(
      {
        error:
          "Two-factor authentication is already on. Setting it up again needs a current code as well as your password.",
      },
      409
    );

  const state = await store.getTotpState(auth_.userId);
  if (state?.enabled) {
    const code = typeof body.code === "string" ? body.code : "";
    // A missing code isn't a guess, so it isn't counted.
    if (!code.trim()) return alreadyOn();
    const result = await verifySecondFactor(c, auth_.userId, code, "password");
    if (result.retryAfterMs !== undefined) return tooManyCodes(c, result.retryAfterMs);
    if (!result.ok) return c.json({ error: "That code isn't right." }, 403);
    await store.replaceTotpSecret(auth_.userId, secret);
  } else if (!(await store.stageTotpSecret(auth_.userId, secret))) {
    // Enabled in another tab since the read above.
    return alreadyOn();
  }

  // No QR code: on a phone the otpauth URI is a tappable link.
  return c.json({
    secret,
    otpauthUri: otpauthUri(secret, user?.email ?? "account"),
  });
});

/** Recovery codes are stored hashed, so this response is their only readable copy. */
auth.post("/2fa/enable", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "You need to be signed in." }, 401);

  const body = await readJson<Record<string, unknown>>(c);
  const code = typeof body.code === "string" ? body.code : "";

  const store = c.get("store");
  const state = await store.getTotpState(session.userId);
  if (!state?.secret) {
    return c.json({ error: "Start the setup again — there's no pending secret." }, 400);
  }
  if (state.enabled) {
    return c.json({ error: "Two-factor authentication is already on." }, 409);
  }

  const { valid, step } = await verifyTotp(state.secret, code);
  if (!valid) {
    return c.json(
      { error: "That code isn't right. Check your authenticator app and try the current code." },
      400
    );
  }

  const codes = generateRecoveryCodes();
  const hashes = await Promise.all(codes.map(hashRecoveryCode));
  const enabled = await store.enableTotp(session.userId, step, hashes);
  if (!enabled) {
    return c.json({ error: "Two-factor authentication is already on." }, 409);
  }

  return c.json({ enabled: true, recoveryCodes: codes });
});

/** Needs the password and a current code: neither a stolen password nor a borrowed phone suffices. */
auth.post("/2fa/disable", async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const auth_ = await requirePasswordReauth(c, body.password);
  if (auth_ instanceof Response) return auth_;

  const store = c.get("store");
  const state = await store.getTotpState(auth_.userId);
  if (!state?.enabled) return c.json({ error: "Two-factor authentication is not on." }, 409);

  const code = typeof body.code === "string" ? body.code : "";
  const result = await verifySecondFactor(c, auth_.userId, code, "password");
  if (result.retryAfterMs !== undefined) return tooManyCodes(c, result.retryAfterMs);
  if (!result.ok) return c.json({ error: "That code isn't right." }, 403);

  await store.disableTotp(auth_.userId);
  return c.json({ enabled: false });
});

/** Same proofs as disabling: a new batch invalidates the codes someone printed. */
auth.post("/2fa/recovery-codes", async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const auth_ = await requirePasswordReauth(c, body.password);
  if (auth_ instanceof Response) return auth_;

  const store = c.get("store");
  const state = await store.getTotpState(auth_.userId);
  if (!state?.enabled) return c.json({ error: "Two-factor authentication is not on." }, 409);

  const code = typeof body.code === "string" ? body.code : "";
  const result = await verifySecondFactor(c, auth_.userId, code, "password");
  if (result.retryAfterMs !== undefined) return tooManyCodes(c, result.retryAfterMs);
  if (!result.ok) return c.json({ error: "That code isn't right." }, 403);

  const codes = generateRecoveryCodes();
  await store.replaceRecoveryCodes(auth_.userId, await Promise.all(codes.map(hashRecoveryCode)));
  return c.json({ recoveryCodes: codes });
});

auth.get("/2fa", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "You need to be signed in." }, 401);
  const store = c.get("store");
  const state = await store.getTotpState(session.userId);
  const counts = await store.countRecoveryCodesLeft(session.userId);
  return c.json({
    enabled: state?.enabled ?? false,
    recoveryCodesRemaining: counts.remaining,
    recoveryCodesTotal: counts.total,
  });
});

export default auth;
