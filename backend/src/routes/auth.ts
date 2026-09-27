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
import { createEmailService } from "../services/emailService.js";
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
import { countHit, hashedKey, rateLimit } from "../middleware/rateLimit.js";
import { readJson } from "../http.js";
import { createLogger, errorFields } from "../log.js";
import type { Context } from "hono";
import type { AppEnv, Env } from "../types.js";

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
// /verify can ask for the signup password.
auth.use(
  "/verify",
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

// Mails an address the caller names, so it's limited against spam. Its own
// bucket: sharing "auth" would let failed logins block the way to reset.
auth.use(
  "/forgot",
  rateLimit({
    bucket: "forgot",
    limit: 5,
    windowMs: 15 * 60 * 1000,
    message: "Too many reset requests. Please wait a few minutes and try again.",
  })
);
auth.use(
  "/reset",
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

/** Longer than a reset link's hour: no account exists yet to take over. */
const SIGNUP_TTL_HOURS = 24;

/** Per address per hour, from any number of networks. */
const SIGNUP_MAIL_PER_ADDRESS = 3;
const SIGNUP_MAIL_WINDOW_MS = 60 * 60 * 1000;

/** From APP_ORIGIN, never a request header (host-header poisoning). */
function linkTo(env: Env, path: string): string {
  return `${(env.APP_ORIGIN ?? "").replace(/\/+$/, "")}${path}`;
}

/**
 * Explicit opt-in, not "no provider configured", so a deployment that loses
 * its key doesn't start logging live links.
 */
function devLogsEmailLinks(env: Env): boolean {
  return env.DEV_LOG_EMAIL_LINKS === "true";
}

/**
 * Creates nothing, and answers every address identically so signup can't
 * reveal which emails have accounts. A new address gets a confirmation link;
 * an existing one gets a "someone tried to sign up" notice. The differing work
 * runs in waitUntil so response time doesn't leak it either.
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

  // The guest row the account will claim; also how /verify recognises this browser.
  const session = await ensureSession(c);
  const { email, password } = credentials;
  const log = createLogger(c.env);
  const mail = createEmailService(c.env);

  c.executionCtx.waitUntil(
    (async () => {
      try {
        // Over the per-recipient cap the send is skipped silently.
        const { count } = await countHit(
          c,
          "signup-mail",
          await hashedKey("email", email),
          SIGNUP_MAIL_WINDOW_MS
        );
        if (count > SIGNUP_MAIL_PER_ADDRESS) {
          log.warn("signup email skipped — that address has had its share this hour");
          return;
        }

        if (await store.emailTaken(email)) {
          if (devLogsEmailLinks(c.env)) {
            log.warn("DEV_LOG_EMAIL_LINKS is on — address already has an account, notice sent");
          }
          const sent = await mail.sendSignupNotice(
            email,
            linkTo(c.env, "/signin"),
            linkTo(c.env, "/forgot")
          );
          if (!sent.delivered) {
            log.error("signup notice requested but not delivered", { provider: sent.provider });
          }
          return;
        }

        const token = generateResetToken();
        await store.createPendingSignup(
          await hashResetToken(token),
          email,
          await hashPassword(password),
          session.userId,
          SIGNUP_TTL_HOURS * 60
        );
        const confirmUrl = linkTo(c.env, `/verify?token=${token}`);

        if (devLogsEmailLinks(c.env)) {
          log.warn("DEV_LOG_EMAIL_LINKS is on — signup link written to the log", { confirmUrl });
        }

        const sent = await mail.sendSignupConfirmation(email, confirmUrl, SIGNUP_TTL_HOURS);
        if (!sent.delivered) {
          // The only place this failure surfaces. No address in it.
          log.error("signup confirmation requested but not delivered", {
            provider: sent.provider,
          });
        }
      } catch (err) {
        log.error("signup request failed", errorFields(err));
      }
    })()
  );

  if (Math.random() < 0.01) {
    c.executionCtx.waitUntil(
      store.sweepPendingSignups().catch(() => {}) // best-effort housekeeping
    );
  }

  return c.json(
    {
      message:
        "Check your inbox to finish creating your account. If that address already has an account, a note saying so is on its way instead.",
    },
    202
  );
});

/**
 * Against account pre-hijacking (signing up with someone else's address and
 * waiting for them to click): the link completes on its own only in the
 * browser that asked. Anywhere else it answers `passwordRequired` and needs
 * the signup password. A wrong password doesn't spend the link.
 */
auth.post("/verify", async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const token = typeof body.token === "string" ? body.token.trim() : "";

  // One message for expired, used and unknown links.
  const invalid = () =>
    c.json(
      { error: "This link has expired or has already been used. Sign up again to get a new one." },
      400
    );
  if (!token) return invalid();

  const store = c.get("store");
  const pending = await store.findPendingSignup(await hashResetToken(token));
  if (!pending) return invalid();

  if (c.get("session")?.userId !== pending.guestUserId) {
    const password = typeof body.password === "string" ? body.password : "";
    if (!password) return c.json({ passwordRequired: true });
    if (!(await verifyPassword(password, pending.passwordHash))) {
      return c.json(
        { error: "That isn't the password this account was set up with.", passwordRequired: true },
        401
      );
    }
  }

  // Read before the session changes, so the UI can say if a draft is left behind.
  const guestDraft = await ownedStudent(c);

  const result = await store.completeSignup(pending);
  if (result.status === "email-taken") {
    // Safe to reveal only now: the caller has proved they hold the inbox.
    return c.json({ error: "This email already has a Compass account. Sign in instead." }, 409);
  }
  if (result.status === "stale") return invalid();

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
 * recovery codes (reset doesn't bypass 2FA). A matched TOTP step is consumed
 * against replay. Call only through verifySecondFactor.
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
 * pool of IPs; see auth/secondFactorLimit.ts. `factor` has no default: with
 * one shared count, a password thief could lock the owner out of reset.
 * `retryAfterMs` means locked and nothing was checked. Empty codes don't count.
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
  factor: FirstFactor,
  extra: Record<string, unknown> = {}
) {
  c.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  // Only shown to someone already past the password.
  const hint =
    factor === "password"
      ? " If these weren't your attempts, someone may know your password — reset it from the sign-in page."
      : "";
  return c.json(
    {
      error: `Too many incorrect codes. For this account's protection, try again in ${describeWait(retryAfterMs)}.${hint}`,
      ...extra,
    },
    429
  );
}

/**
 * Carries "password already checked" to the code step. Not a half-signed-in
 * session: every ownership check would then need to know about that state.
 */
async function issueMfaChallenge(
  c: Context<AppEnv>,
  userId: number,
  purpose: "login" | "reset"
): Promise<string> {
  const token = generateResetToken();
  await c.get("store").createMfaChallenge(userId, await hashResetToken(token), purpose);
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
    // Everyone gets the "open the link" hint, so it reveals nothing.
    return c.json(
      {
        error:
          "That email and password don't match an account. If you've just signed up, open the link we emailed you first.",
      },
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
    return c.json({ mfaRequired: true, challenge: await issueMfaChallenge(c, row.id, "login") });
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
  if (result.retryAfterMs !== undefined) return tooManyCodes(c, result.retryAfterMs, "password");
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

const RESET_TTL_MINUTES = 60;

auth.post("/forgot", async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  const store = c.get("store");
  const log = createLogger(c.env);
  const email_service = createEmailService(c.env);

  // One identical 202 whether or not the account exists, so this can't be used
  // to check which addresses have accounts. Don't add a "did you mean to sign
  // up?" variant.
  const respond = () =>
    c.json(
      {
        message:
          "If an account exists for that address, a reset link is on its way. Check your spam folder if it doesn't arrive in a few minutes.",
      },
      202
    );

  // Length before the regex: it backtracks quadratically on a long run of dots.
  if (!email || email.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "Enter a valid email address." }, 400);
  }

  const row = await store.findUserForLogin(email);

  // After the response, in waitUntil, so timing doesn't reveal the account either.
  if (row) {
    c.executionCtx.waitUntil(
      (async () => {
        try {
          const token = generateResetToken();
          await store.createPasswordReset(
            row.id,
            await hashResetToken(token),
            RESET_TTL_MINUTES
          );

          const resetUrl = linkTo(c.env, `/reset?token=${token}`);

          if (devLogsEmailLinks(c.env)) {
            log.warn("DEV_LOG_EMAIL_LINKS is on — reset link written to the log", { resetUrl });
          }

          const sent = await email_service.sendPasswordReset(
            email,
            resetUrl,
            RESET_TTL_MINUTES
          );
          if (!sent.delivered) {
            // The only place this failure surfaces. No address in it.
            log.error("password reset requested but not delivered", {
              provider: sent.provider,
            });
          }
        } catch (err) {
          log.error("password reset request failed", errorFields(err));
        }
      })()
    );
  }

  if (Math.random() < 0.01) {
    c.executionCtx.waitUntil(
      store.sweepPasswordResets().catch(() => {}) // best-effort housekeeping
    );
  }

  return respond();
});

/**
 * Signs the caller in on success; they have proved more than a login asks.
 * Every other session is revoked first, in case an attacker holds one.
 */
auth.post("/reset", async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  const errors: string[] = [];
  if (!token) errors.push("This reset link is missing its token.");
  if (!password) errors.push("Password is required.");
  else if (password.length < MIN_PASSWORD) {
    errors.push(`Password must be at least ${MIN_PASSWORD} characters.`);
  } else if (password.length > MAX_PASSWORD) {
    errors.push(`Password must be under ${MAX_PASSWORD} characters.`);
  }
  // Before the token lookup, so a too-short password doesn't spend the link.
  if (errors.length) return c.json({ errors }, 400);

  const store = c.get("store");
  const reset = await store.findPasswordReset(await hashResetToken(token));

  // One message for expired, used and unknown tokens.
  const invalid = () =>
    c.json(
      { error: "This reset link has expired or has already been used. Request a new one." },
      400
    );

  if (!reset) return invalid();

  // Reset does not bypass 2FA, or a hijacked inbox would be a full takeover.
  // Recovery codes are the way back from a lost phone. Checked before hashing
  // and spending the token, so a missing code costs neither.
  const totp = await store.getTotpState(reset.userId);
  if (totp?.enabled) {
    const code = typeof body.code === "string" ? body.code : "";
    if (!code) {
      // Tells the client to ask for a code. Only reachable with a valid token.
      return c.json({ mfaRequired: true }, 200);
    }
    const result = await verifySecondFactor(c, reset.userId, code, "reset");
    if (result.retryAfterMs !== undefined) {
      return tooManyCodes(c, result.retryAfterMs, "reset", { mfaRequired: true });
    }
    if (!result.ok) {
      // The link survives a wrong code; the per-account count bounds guessing.
      return c.json({ error: "That code isn't right.", mfaRequired: true }, 401);
    }
  }

  const passwordHash = await hashPassword(password);
  const spent = await store.resetPassword(
    await hashResetToken(token),
    reset.userId,
    passwordHash
  );
  // Lost a race with a concurrent submit of the same link.
  if (!spent) return invalid();

  await rotateSession(c, reset.userId);
  const user = await store.getUser(reset.userId);
  const student = await store.getStudentByUserId(reset.userId);

  return c.json({ user, studentId: student?.id ?? null });
});

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
    if (result.retryAfterMs !== undefined) return tooManyCodes(c, result.retryAfterMs, "password");
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
  if (result.retryAfterMs !== undefined) return tooManyCodes(c, result.retryAfterMs, "password");
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
  if (result.retryAfterMs !== undefined) return tooManyCodes(c, result.retryAfterMs, "password");
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
