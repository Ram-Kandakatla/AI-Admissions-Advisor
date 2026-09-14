// Account routes.
//
//   POST /api/auth/signup   { email, password }  → "check your inbox", for every
//                                                  address alike
//   POST /api/auth/verify   { token, password? } → confirms it: claims the
//                                                  caller's guest row, signs in
//   POST /api/auth/login    { email, password }  → new session for that account
//   POST /api/auth/logout                        → revokes the session
//   GET  /api/auth/me                            → who the caller is, if anyone
//   DELETE /api/auth/account { password?, confirm } → erases the account and
//                                                     everything it owns
//   POST /api/auth/forgot   { email }               → mails a reset link
//   POST /api/auth/reset    { token, password, code? } → sets a new password
//   POST /api/auth/2fa/setup   { password }         → stages a TOTP secret
//   POST /api/auth/2fa/enable  { code }             → confirms it, issues codes
//   POST /api/auth/2fa/disable { password, code }   → turns it off
//   POST /api/auth/2fa/recovery-codes { password, code } → a fresh batch
//   POST /api/auth/2fa/verify  { challenge, code }  → finishes a login
//
// Signup is a *claim*, not a create — it just completes at /verify now, once
// the emailed link is opened. The caller almost always already has an anonymous
// user row holding the profile they just built, and confirming fills in that
// row's email and password rather than making a second one. That is what lets
// the product keep its no-account front door without leaving unowned profiles
// behind.

import { Hono } from "hono";
import {
  hashPassword,
  verifyPassword,
  fakeVerify,
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
// Opening a signup link can ask for the password chosen at signup, which makes
// it one more place a password can be guessed. Only by someone already holding
// the inbox, so unlikely — but pooling it with the others costs nothing.
auth.use(
  "/verify",
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

// Requesting a reset sends mail to an address the caller names, so an
// unlimited version of it is a spam cannon pointed at other people's inboxes
// and a fast way to burn a provider quota. Tighter than login: nobody needs
// five reset emails in a quarter of an hour.
//
// Its own bucket, unlike every other route in this file. Sharing "auth" meant
// this limit of 5 was drawn down by sign-in attempts too, so the fifth wrong
// password locked the caller out of the reset request — refusing the way out
// at exactly the moment someone needs it. Nothing here checks a password, so
// nothing is gained by pooling it with the routes that do.
auth.use(
  "/forgot",
  rateLimit({
    bucket: "forgot",
    limit: 5,
    windowMs: 15 * 60 * 1000,
    message: "Too many reset requests. Please wait a few minutes and try again.",
  })
);
// Submitting a token is a guess at a 256-bit secret, which is hopeless, but
// the limit costs nothing and keeps this off the list of endpoints anyone can
// hammer for free.
auth.use(
  "/reset",
  rateLimit({
    bucket: "auth",
    limit: 15,
    windowMs: 15 * 60 * 1000,
    message: "Too many attempts. Please wait a few minutes and try again.",
  })
);

// Every route under /2fa either checks a password or guesses at a six-digit
// code. This is the cheap first line against both, and it counts per network,
// so it stops one machine rather than many: what bounds code guessing from a
// pool of addresses is the per-account count in verifySecondFactor.
// Hono matches this prefix for the nested paths too.
auth.use(
  "/2fa/*",
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
 * it — which signup now does, and is where a mistyped address is caught.
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

/**
 * How long a signup link lives: a day. Longer than a reset link's hour
 * because nothing is at stake while it waits — no account exists yet to take
 * over — and a link that dies before a student checks their school inbox after
 * last period is a signup that quietly never happened.
 */
const SIGNUP_TTL_HOURS = 24;

/**
 * At most this many signup emails to one address an hour, however many
 * networks the requests come from. /signup mails whatever address it is given,
 * so the per-network limit alone would let a pool of IPs fill a stranger's
 * inbox through Compass.
 */
const SIGNUP_MAIL_PER_ADDRESS = 3;
const SIGNUP_MAIL_WINDOW_MS = 60 * 60 * 1000;

/**
 * An absolute link into the app, for an email.
 *
 * Built from configuration, never from a request header. Building it out of
 * the Host or Origin the caller sent is host-header poisoning: an attacker
 * requests a reset — or a signup — for someone else's address and points the
 * link that lands in that person's inbox at a server they control.
 */
function linkTo(env: Env, path: string): string {
  return `${(env.APP_ORIGIN ?? "").replace(/\/+$/, "")}${path}`;
}

/**
 * Local development only: write emailed links to the log, so the flows can be
 * finished with no email provider. Gated on an explicit opt-in rather than on
 * "no provider configured" — a deployment that lost its API key must not start
 * writing live credentials to a log it did not before. See the binding's note
 * in types.ts.
 */
function devLogsEmailLinks(env: Env): boolean {
  return env.DEV_LOG_EMAIL_LINKS === "true";
}

/**
 * Start creating an account. Nothing is created here.
 *
 * WHY EVERY ADDRESS GETS THE SAME ANSWER
 *
 * This route used to create the account on the spot, so an address with an
 * account answered 409 and a new one answered 201 — the membership oracle
 * /forgot refuses to be, one route over. The only answer that can be the same
 * for both is "check your inbox", so that is the answer, and the difference
 * moves into the inbox, where only its owner sees it:
 *
 *   - a new address gets a link, and the account is created when it is opened
 *     (POST /verify);
 *   - an address that already has an account gets a note saying someone tried,
 *     with the way to sign in or reset. No link, so nothing can be created.
 *
 * Everything that differs between those two happens after the response, in
 * waitUntil, for the stopwatch reason /forgot gives: a password hash and a row
 * write that only one branch performs would otherwise show up as latency.
 */
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

  // The guest row the confirmed account will claim, minted now for a visitor
  // who has none. It keeps a guest's profile, and it is how /verify recognises
  // the browser that asked. Done for every address alike and before the
  // response, which is why it says nothing about any of them.
  const session = await ensureSession(c);
  const { email, password } = credentials;
  const log = createLogger(c.env);
  const mail = createEmailService(c.env);

  c.executionCtx.waitUntil(
    (async () => {
      try {
        // A cap per recipient, on top of the per-network limit on the route.
        // Past it the send is skipped silently: the response was identical
        // either way, so there is nobody to tell.
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
          // The person has already been told to check their inbox, so this
          // line is the only place the failure surfaces. No address in it.
          log.error("signup confirmation requested but not delivered", {
            provider: sent.provider,
          });
        }
      } catch (err) {
        log.error("signup request failed", errorFields(err));
      }
    })()
  );

  // One in a hundred requests also tidies expired signups, as /forgot does
  // for resets.
  if (Math.random() < 0.01) {
    c.executionCtx.waitUntil(
      store.sweepPendingSignups().catch(() => {
        /* housekeeping — never worth failing a request over */
      })
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
 * Confirm a signup and create the account.
 *
 * WHEN THE LINK IS ENOUGH, AND WHEN IT IS NOT
 *
 * Holding the link proves someone controls the inbox. It does not prove they
 * filled in the form, and that gap is an attack with a name — account
 * pre-hijacking. Request a signup for someone else's address with a password
 * you chose; if they open the link and are signed straight in, they are now
 * building a college list inside an account you can sign in to.
 *
 * So the link finishes by itself only for the session that asked — the one
 * whose guest row the pending signup names, where the person clicking is the
 * person who chose the password. Anywhere else (a phone's mail app, another
 * computer, a stranger's browser) it asks for that password, which the owner of
 * an inbox someone else typed in does not have. The page cannot know in advance
 * which case it is in, so its first call carries no password and
 * `passwordRequired` is the answer that asks for one. That answer is only ever
 * given for a live token, so it reveals nothing about anyone else.
 *
 * A wrong password does not spend the link. The only people able to guess
 * against it already hold the inbox, and the auth limiter caps them regardless.
 */
auth.post("/verify", async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const token = typeof body.token === "string" ? body.token.trim() : "";

  // One message for expired, already-used, and never-existed, for the reason
  // /reset gives: telling them apart confirms that a link was once real.
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

  // Read before the session changes hands, for the reason login reads it: a
  // different unsaved list in this browser is about to be left behind.
  const guestDraft = await ownedStudent(c);

  const result = await store.completeSignup(pending);
  if (result.status === "email-taken") {
    // Safe to say here, and nowhere before this point: the caller has just
    // redeemed a link that only that inbox was sent.
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
 * Check a second factor: a TOTP code, or a recovery code.
 *
 * One function because every place that needs a second factor needs both
 * kinds. Splitting them would mean each caller decides which to accept, and
 * the first one to forget recovery codes turns a lost phone into a lost
 * account — which is the failure this whole feature has to avoid, given that
 * password reset here does not bypass 2FA.
 *
 * A TOTP code is tried first and, if it verifies, its time-step is consumed.
 * That consumption is the replay guard: a code is valid across a ±1 step
 * window, so without it a code read off someone's shoulder stays usable for up
 * to 90 seconds. `consumeTotpStep` is a conditional UPDATE, so two requests
 * presenting the same code at the same instant cannot both succeed.
 *
 * A six-digit string is never tried as a recovery code and vice versa: the
 * formats do not overlap, and attempting both would double the work and let a
 * failed TOTP attempt silently consume a recovery code.
 *
 * Only ever called through verifySecondFactor, which decides whether this
 * account may have a code checked at all.
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
    // Valid, but possibly already spent — see the replay note above.
    const fresh = await store.consumeTotpStep(userId, step);
    return { ok: fresh, usedRecoveryCode: false };
  }

  const spent = await store.consumeRecoveryCode(userId, await hashRecoveryCode(typed));
  if (!spent) return { ok: false, usedRecoveryCode: false };
  const { remaining } = await store.countRecoveryCodesLeft(userId);
  return { ok: true, usedRecoveryCode: true, remaining };
}

/**
 * Check a second factor, within the account's budget of wrong codes.
 *
 * WHY THE ACCOUNT HAS A BUDGET
 *
 * Every route that takes a code is also rate limited per network, and that
 * stops one machine, not a pool of them. So each attempt is charged to the
 * account as well: five wrong codes free, then a wait that doubles up to a day
 * (auth/secondFactorLimit.ts; the full reasoning is in
 * migrations/0011_mfa_attempts.sql).
 *
 * The charge goes to one of two counts, named for the first factor that got
 * the caller to the code prompt. `factor` is required rather than defaulted so
 * that a new call site has to choose: with one shared count, someone holding
 * only the password could keep the owner locked out of the reset that takes
 * it back.
 *
 * `retryAfterMs` means the account was locked and nothing was checked. An
 * empty code, or an account with no second factor, is not an attempt: nothing
 * was guessed, so nothing is counted.
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

  // Claimed before anything is checked or consumed: a locked attempt must not
  // test a TOTP code, and must not spend a recovery code.
  const claim = await store.claimSecondFactorAttempt(userId, factor, CLAIM_HOLD_MS);
  if (!claim.claimed) {
    return { ok: false, usedRecoveryCode: false, retryAfterMs: claim.retryAfterMs };
  }

  const result = await checkCode(c, userId, state.secret, typed);
  if (result.ok) await store.clearSecondFactorAttempts(userId);
  else await store.recordSecondFactorFailure(userId, factor, waitAfter(claim.failures + 1));
  return result;
}

/**
 * The answer when an account's wrong-code budget is spent. The same on every
 * route that takes a code, apart from what a route adds to keep its page on
 * the right step.
 */
function tooManyCodes(
  c: Context<AppEnv>,
  retryAfterMs: number,
  factor: FirstFactor,
  extra: Record<string, unknown> = {}
) {
  c.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  // Only ever shown to someone past the password, so it tells an attacker
  // nothing they do not already know.
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
 * Mint the token that carries "the password was already checked" between the
 * two halves of a flow.
 *
 * Deliberately not a session cookie. A half-authenticated session is still a
 * session, and every ownership check in this app would have to learn about a
 * state that does not exist today — one forgotten check and the second factor
 * is optional. A separate short-lived row keeps `sessions` meaning exactly one
 * thing: fully authenticated.
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

  // One message for both "no such account" and "wrong password", and — via
  // fakeVerify — one timing profile too. Either half alone is an account
  // enumeration oracle: a stopwatch tells you which emails are registered just
  // as well as a distinct error message does.
  const ok = row
    ? await verifyPassword(credentials.password, row.password_hash)
    : await fakeVerify(credentials.password);

  if (!ok || !row) {
    // The second sentence is for someone who signed up minutes ago and has
    // not opened the link yet — the one person certain to land here with the
    // right password. Everyone gets it, so it says nothing about anyone.
    return c.json(
      {
        error:
          "That email and password don't match an account. If you've just signed up, open the link we emailed you first.",
      },
      401
    );
  }

  // WHERE 2FA INTERRUPTS THE LOGIN
  //
  // Here, before any session exists. The password was right, and that is now
  // only half of what is required — so nothing is minted, no cookie is set,
  // and the caller gets a challenge to redeem at /2fa/verify instead. The
  // guest draft is deliberately left alone until the second factor lands:
  // discarding it now would let a stranger with a stolen password destroy
  // work by getting halfway through a login.
  const totp = await store.getTotpState(row.id);
  if (totp?.enabled) {
    return c.json({ mfaRequired: true, challenge: await issueMfaChallenge(c, row.id, "login") });
  }

  // Whether the guest draft this session was carrying is about to be left
  // behind. The account's own profile wins — it is the one the person has
  // deliberately saved — but the UI should be able to say so rather than
  // appearing to lose work silently.
  const guestDraft = await ownedStudent(c);

  await rotateSession(c, row.id);
  const student = await store.getStudentByUserId(row.id);

  return c.json({
    // From the store rather than hand-built from `row`: UserRecord has gained
    // a field twice now, and an object assembled here silently omits it.
    user: await store.getUser(row.id),
    studentId: student?.id ?? null,
    discardedGuestProfile: guestDraft != null && guestDraft.id !== student?.id,
  });
});

/**
 * The second half of a login.
 *
 * The challenge is spent whether or not the code was right. A challenge that
 * survived a wrong code would turn the five-minute window into an unlimited
 * guessing budget against six digits — the rate limiter would still be there,
 * but relying on it alone to hold the line on a factor that is supposed to be
 * independent is not a trade worth making. Getting it wrong costs a password
 * retype, which is the correct price for a failed second factor.
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
  // The challenge above is already spent, as it is for a wrong code, so the
  // person signs in again once the wait is over.
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
 * How long a reset link lives.
 *
 * An hour is the usual number and the reasoning is worth stating: the window
 * is how long a link sitting in an inbox — or in a mail server's logs, or on a
 * shared computer someone walked away from — remains a working key to the
 * account. Short enough that a stale link is rarely useful to anyone, long
 * enough that "check your email" survives a distracted teenager.
 */
const RESET_TTL_MINUTES = 60;

auth.post("/forgot", async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  const store = c.get("store");
  const log = createLogger(c.env);
  const email_service = createEmailService(c.env);

  // Everything below happens behind one unconditional 202. The response says
  // "if that address has an account, a link is on the way" and says exactly
  // that for an address with no account, a guest row, a send failure, and an
  // unconfigured deployment alike.
  //
  // WHY THE RESPONSE CANNOT DEPEND ON WHETHER THE ACCOUNT EXISTS
  //
  // Anything that varies — the status, the wording, the shape of the body —
  // turns this endpoint into a membership oracle: paste in a list of ten
  // thousand addresses and learn which of them belong to teenagers with a
  // college-planning account. That inference is worth more to the wrong person
  // than the account itself, and it is why every "did you mean to sign up?"
  // refinement of this message has to be refused.
  const respond = () =>
    c.json(
      {
        message:
          "If an account exists for that address, a reset link is on its way. Check your spam folder if it doesn't arrive in a few minutes.",
      },
      202
    );

  // A shallow shape check only. Reporting "that isn't a valid email" is a
  // usability win and not an enumeration risk — it says nothing about who has
  // an account — but anything past this point must be silent.
  //
  // The length test comes first, and the order is the fix, not a tidiness
  // choice. This pattern backtracks quadratically on a long run of dots, and
  // the body cap still lets through ~100k characters of them: measured in V8,
  // 40k took 0.7s, so a full-size body is seconds of CPU per request.
  // validateCredentials already checks length before shape; this route did not.
  if (!email || email.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "Enter a valid email address." }, 400);
  }

  const row = await store.findUserForLogin(email);

  // WHY THE WORK HAPPENS AFTER THE RESPONSE
  //
  // The timing is the other half of the oracle. Hashing a token, writing a
  // row and making an HTTPS call to Resend is a few hundred milliseconds that
  // a non-existent address would not spend, and a stopwatch reads that
  // difference as reliably as a different error message would. waitUntil hands
  // the work to the runtime and returns immediately, so both paths answer at
  // the same speed — and the person waiting gets a faster page either way.
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

          // Configuration, never a request header — see linkTo.
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
            // The user has already been told to check their inbox, so this
            // log line is the only place the failure surfaces. No address in
            // it — see log.ts on what a log line may hold.
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

  // One in a hundred requests also tidies expired tokens, matching the session
  // sweep. Housekeeping does not belong on the hot path of every request.
  if (Math.random() < 0.01) {
    c.executionCtx.waitUntil(
      store.sweepPasswordResets().catch(() => {
        /* housekeeping — never worth failing a request over */
      })
    );
  }

  return respond();
});

/**
 * Spend a reset token and set a new password.
 *
 * On success the caller is signed in immediately. That is safe and it is the
 * humane option: they have just proved control of the mailbox *and* chosen a
 * password, which is strictly more than a login asks for, and bouncing them to
 * a sign-in form to retype what they typed ten seconds ago is friction with no
 * security to show for it.
 *
 * Every other session is destroyed first (see store.resetPassword). If this
 * reset was prompted by a compromise, the attacker is holding a session cookie,
 * and a password change that leaves them signed in has not recovered anything.
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
  // Validated before the token is looked up, so a caller who typed a short
  // password is told so without spending their one-use link on the attempt.
  if (errors.length) return c.json({ errors }, 400);

  const store = c.get("store");
  const reset = await store.findPasswordReset(await hashResetToken(token));

  // One message for expired, already-used, and never-existed. Distinguishing
  // them would confirm that a token was real, and the useful next step is the
  // same in all three cases anyway.
  const invalid = () =>
    c.json(
      { error: "This reset link has expired or has already been used. Request a new one." },
      400
    );

  if (!reset) return invalid();

  // WHY A RESET DOES NOT BYPASS THE SECOND FACTOR
  //
  // The user's call, and the secure one. The alternative — email alone is
  // enough to set a new password — makes 2FA protect against a stolen password
  // and nothing else, while leaving the inbox as a complete account-takeover
  // path. Since email is *already* the recovery channel, that would reduce the
  // second factor to decoration for the threat it most needs to cover.
  //
  // The cost is real and is why recovery codes are issued at enrollment and
  // shown once: someone who loses their phone and their codes cannot get back
  // in, and there is no support desk here to override it. Both the enrollment
  // screen and the Security page say so in as many words.
  //
  // Checked *before* the password is hashed and the token spent, so a missing
  // code costs neither the link nor 60ms of PBKDF2.
  const totp = await store.getTotpState(reset.userId);
  if (totp?.enabled) {
    const code = typeof body.code === "string" ? body.code : "";
    if (!code) {
      // Not an error: the client cannot know a second factor is needed until
      // it presents a valid token, so this is the flow telling it to ask.
      // Deliberately reached only for a token that verified — an invalid one
      // is refused above, so this reveals nothing about anybody else.
      return c.json({ mfaRequired: true }, 200);
    }
    const result = await verifySecondFactor(c, reset.userId, code, "reset");
    if (result.retryAfterMs !== undefined) {
      // mfaRequired keeps the page on the code step for when the wait is over.
      return tooManyCodes(c, result.retryAfterMs, "reset", { mfaRequired: true });
    }
    if (!result.ok) {
      // The link survives a wrong code, deliberately. The per-account count is
      // what bounds guessing; burning the link would add a trip to the inbox to
      // every typo without bounding anything, since whoever holds the inbox can
      // simply ask for another.
      return c.json({ error: "That code isn't right.", mfaRequired: true }, 401);
    }
  }

  const passwordHash = await hashPassword(password);
  const spent = await store.resetPassword(
    await hashResetToken(token),
    reset.userId,
    passwordHash
  );
  // Lost a race with a simultaneous submission of the same link. The other
  // one set the password; this one must not report success.
  if (!spent) return invalid();

  // A brand-new session, minted after every old one was destroyed.
  await rotateSession(c, reset.userId);
  const user = await store.getUser(reset.userId);
  const student = await store.getStudentByUserId(reset.userId);

  return c.json({ user, studentId: student?.id ?? null });
});

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

/* ------------------------------------------------- Enrollment and teardown */

/**
 * The signed-in, non-guest account behind this request, after re-checking its
 * password.
 *
 * Every route below either switches a second factor on or off, and all of them
 * ask for the password again for the same reason DELETE /account does: a valid
 * session is not enough authority to change how the account is protected. A
 * borrowed laptop has a session; it does not have the password.
 *
 * Returns a Response on failure so each caller is one `if` rather than five
 * lines of the same branching.
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
    // A guest has no password to re-check and nothing to protect with a second
    // factor — there is no account to sign in to.
    return c.json({ error: "Create an account first." }, 403);
  }

  const row = await store.findUserForLogin(user.email);
  const typed = typeof password === "string" ? password : "";
  const ok = row ? await verifyPassword(typed, row.password_hash) : await fakeVerify(typed);
  if (!ok || !row) return c.json({ error: "That password is not correct." }, 403);

  return { userId: user.id };
}

/**
 * Stage a secret and hand back what the user needs to enrol.
 *
 * Nothing is switched on here. The secret is stored unconfirmed and 2FA stays
 * off until a code generated from it comes back at /2fa/enable — which is what
 * stops a mistyped setup key from locking someone out of their own account,
 * the single likeliest way to get this wrong.
 *
 * Calling it again replaces the staged secret, so an abandoned enrollment (or
 * a new phone) is just a fresh start rather than a state to clean up.
 */
auth.post("/2fa/setup", async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const auth_ = await requirePasswordReauth(c, body.password);
  if (auth_ instanceof Response) return auth_;

  const store = c.get("store");
  const user = await store.getUser(auth_.userId);
  const secret = generateTotpSecret();
  await store.stageTotpSecret(auth_.userId, secret);

  // The secret leaves the server exactly here, to the person enrolling, over
  // an authenticated request they just re-proved a password for. The otpauth
  // URI is the same secret in the form an app can consume — a tappable link on
  // a phone, and the fallback for anyone whose app scans nothing.
  return c.json({
    secret,
    otpauthUri: otpauthUri(secret, user?.email ?? "account"),
  });
});

/**
 * Confirm enrollment with a real code, and issue recovery codes.
 *
 * The recovery codes are returned once and never again — they are stored
 * hashed, so this response is the only time they exist in readable form. That
 * is deliberate and it is also why they are issued *here*, in the same
 * transaction that switches 2FA on: password reset does not bypass the second
 * factor in this app, so an account that had 2FA enabled without codes would
 * be one lost phone away from being unrecoverable.
 */
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
  // `step` is banked as spent in the same write, so the code just used to
  // prove the app works cannot also be used to sign in.
  const enabled = await store.enableTotp(session.userId, step, hashes);
  if (!enabled) {
    return c.json({ error: "Two-factor authentication is already on." }, 409);
  }

  return c.json({ enabled: true, recoveryCodes: codes });
});

/**
 * Turn it off. Needs the password *and* a current second factor.
 *
 * Both, because either alone is exactly the situation 2FA exists to survive: a
 * stolen password should not be able to remove the factor that is blocking it,
 * and neither should a borrowed phone.
 */
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

/**
 * A fresh batch of recovery codes, replacing every existing one.
 *
 * Same two proofs as disabling, for the same reason: a new batch silently
 * invalidates the printout someone is relying on, so it must not be something
 * a stolen session can do.
 */
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

/** How many recovery codes are left, for the account page. */
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
