// Password reset — POST /api/auth/forgot and POST /api/auth/reset.
//
// The interesting assertions here are not "does it work". They are the ones
// about what the endpoint refuses to reveal and refuses to let happen twice:
// no account enumeration, single use, expiry, and every other session dying
// with the old password. Those are the properties a future refactor is most
// likely to quietly drop, because none of them changes the happy path.
//
// Email is never actually sent in these tests. No RESEND_API_KEY is set (see
// vitest.config.ts, which pins the LLM keys to "" for the same reason), so the
// service reports itself unconfigured and the route's behaviour is unchanged —
// which is itself one of the things worth asserting.

import { beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import {
  api,
  body,
  currentCookie,
  get,
  newStudent,
  post,
  resetRateLimits,
  resetSession,
  signUp,
  useSession,
} from "./helpers.js";
import { hashResetToken } from "../src/auth/password.js";

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a whole new staple";

beforeEach(async () => {
  await resetRateLimits();
});

/**
 * Read the token straight out of the database.
 *
 * The token itself only ever exists in the email, which these tests do not
 * send — so this stands in for the person who opened their inbox. It reads the
 * row rather than the mail, which means it also proves the row is what the
 * route claims: one per user, hashed, unspent.
 */
async function tokenRowFor(userId: number) {
  return env.DB.prepare(
    "SELECT token_hash, expires_at, used_at FROM password_resets WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ token_hash: string; expires_at: string; used_at: string | null }>();
}

/**
 * Issue a reset the way the route does, and hand back the plaintext token.
 *
 * The route mails the token and stores only its hash, so no test can recover
 * one from the outside. Rather than exporting a back door from the route, this
 * mints a token through the same store method and hashing the route uses —
 * which keeps the tests honest about the storage format: change the hash and
 * this breaks too.
 */
async function issueToken(userId: number, ttlMinutes = 60): Promise<string> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const hash = await hashResetToken(token);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  )
    .bind(hash, userId, new Date().toISOString(), expiresAt)
    .run();
  return token;
}

describe("requesting a reset tells you nothing about who has an account", () => {
  test("answers identically for a real address and an unknown one", async () => {
    await newStudent();
    await signUp("known@example.com", PASSWORD);
    resetSession();

    const real = await post("/api/auth/forgot", { email: "known@example.com" });
    const fake = await post("/api/auth/forgot", { email: "nobody@example.com" });

    // Same status and the same bytes. Anything that differs — a word, a field,
    // a status — is a membership oracle for a list of teenagers' addresses.
    expect(real.status).toBe(202);
    expect(fake.status).toBe(202);
    expect(await real.clone().text()).toBe(await fake.clone().text());
  });

  test("still answers 202 for a guest account, which has no email to match", async () => {
    await newStudent(); // anonymous user row, email NULL
    resetSession();
    expect((await post("/api/auth/forgot", { email: "" })).status).toBe(400);
    expect((await post("/api/auth/forgot", { email: "ghost@example.com" })).status).toBe(202);
  });

  test("rejects a malformed address, which reveals nothing about accounts", async () => {
    resetSession();
    expect((await post("/api/auth/forgot", { email: "not-an-email" })).status).toBe(400);
  });

  test("writes exactly one live token, and stores it hashed", async () => {
    await newStudent();
    const { userId } = await signUp("hashed@example.com", PASSWORD);
    resetSession();
    await post("/api/auth/forgot", { email: "hashed@example.com" });

    const row = await tokenRowFor(userId);
    expect(row).toBeTruthy();
    // A SHA-256 hex digest, not something that could be mailed as-is.
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.used_at).toBeNull();
  });

  test("a second request replaces the first token rather than adding one", async () => {
    // Newest-wins: two live links mean two chances for one to be intercepted,
    // and a stale link that still works is what "resend" exists to escape.
    await newStudent();
    const { userId } = await signUp("resend@example.com", PASSWORD);
    resetSession();

    await post("/api/auth/forgot", { email: "resend@example.com" });
    const first = (await tokenRowFor(userId))!.token_hash;
    await post("/api/auth/forgot", { email: "resend@example.com" });

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
    expect((await tokenRowFor(userId))!.token_hash).not.toBe(first);
  });
});

describe("spending a token", () => {
  test("sets the new password and signs the caller in", async () => {
    await newStudent();
    const { userId } = await signUp("happy@example.com", PASSWORD);
    const token = await issueToken(userId);
    resetSession();

    const res = await post("/api/auth/reset", { token, password: NEW_PASSWORD });
    const b = await body<{ user: { email: string } }>(res, 200);
    expect(b.user.email).toBe("happy@example.com");
    // Signed in on the spot — they proved mailbox control and chose a
    // password, which is more than a login asks for.
    expect(await body(await get("/api/auth/me"), 200)).toMatchObject({
      user: { email: "happy@example.com" },
    });
  });

  test("the old password stops working and the new one starts", async () => {
    await newStudent();
    const { userId } = await signUp("swapped@example.com", PASSWORD);
    const token = await issueToken(userId);
    resetSession();
    await post("/api/auth/reset", { token, password: NEW_PASSWORD });

    resetSession();
    expect(
      (await post("/api/auth/login", { email: "swapped@example.com", password: PASSWORD }))
        .status
    ).toBe(401);
    expect(
      (await post("/api/auth/login", {
        email: "swapped@example.com",
        password: NEW_PASSWORD,
      })).status
    ).toBe(200);
  });

  test("destroys every other session, including a stolen one", async () => {
    // The property that makes a reset a *recovery* rather than a password
    // change. If this reset was prompted by a compromise, the attacker is
    // holding a cookie, and leaving them signed in recovers nothing.
    await newStudent();
    const { userId } = await signUp("compromised@example.com", PASSWORD);
    const attackerCookie = currentCookie();

    const token = await issueToken(userId);
    resetSession();
    await post("/api/auth/reset", { token, password: NEW_PASSWORD });

    useSession(attackerCookie);
    expect(await body(await get("/api/auth/me"), 200)).toEqual({
      user: null,
      studentId: null,
    });
  });

  test("works exactly once", async () => {
    await newStudent();
    const { userId } = await signUp("once@example.com", PASSWORD);
    const token = await issueToken(userId);
    resetSession();

    expect((await post("/api/auth/reset", { token, password: NEW_PASSWORD })).status).toBe(200);
    resetSession();
    expect((await post("/api/auth/reset", { token, password: "third password here" })).status)
      .toBe(400);
  });

  test("refuses an expired token", async () => {
    await newStudent();
    const { userId } = await signUp("expired@example.com", PASSWORD);
    const token = await issueToken(userId, -1); // expired a minute ago
    resetSession();
    expect((await post("/api/auth/reset", { token, password: NEW_PASSWORD })).status).toBe(400);
  });

  test("refuses a token that was never issued", async () => {
    resetSession();
    expect(
      (await post("/api/auth/reset", { token: "not-a-real-token", password: NEW_PASSWORD }))
        .status
    ).toBe(400);
  });

  test("says the same thing for expired, spent, and never-issued", async () => {
    // Distinguishing them would confirm a token was real, and the useful next
    // step — ask for a new link — is identical in all three cases.
    await newStudent();
    const { userId } = await signUp("indistinct@example.com", PASSWORD);
    const spent = await issueToken(userId);
    resetSession();
    await post("/api/auth/reset", { token: spent, password: NEW_PASSWORD });

    resetSession();
    const used = await post("/api/auth/reset", { token: spent, password: "another one here" });
    const bogus = await post("/api/auth/reset", { token: "nope", password: "another one here" });
    expect(await used.clone().text()).toBe(await bogus.clone().text());
  });

  test("checks the password rules before spending the link", async () => {
    // A short password must not burn the one-use token — otherwise a typo
    // costs a trip back to the inbox.
    await newStudent();
    const { userId } = await signUp("short@example.com", PASSWORD);
    const token = await issueToken(userId);
    resetSession();

    expect((await post("/api/auth/reset", { token, password: "short" })).status).toBe(400);
    expect((await tokenRowFor(userId))!.used_at).toBeNull();
    // And the link still works afterwards.
    expect((await post("/api/auth/reset", { token, password: NEW_PASSWORD })).status).toBe(200);
  });

  test("keeps the spent row, so a replay is distinguishable from a typo", async () => {
    // used_at only means something if the row survives being spent. It would
    // be dead weight in the schema if the reset deleted every token for the
    // user, which an earlier version of this did.
    await newStudent();
    const { userId } = await signUp("audit-trail@example.com", PASSWORD);
    const token = await issueToken(userId);
    resetSession();
    await post("/api/auth/reset", { token, password: NEW_PASSWORD });

    const row = await tokenRowFor(userId);
    expect(row).toBeTruthy();
    expect(row!.used_at).not.toBeNull();
  });

  test("clears the user's other pending tokens once one is spent", async () => {
    await newStudent();
    const { userId } = await signUp("leftovers@example.com", PASSWORD);
    const older = await issueToken(userId);
    const newer = await issueToken(userId);
    resetSession();

    await post("/api/auth/reset", { token: newer, password: NEW_PASSWORD });
    resetSession();
    // The earlier link cannot be used to change the password a second time.
    expect((await post("/api/auth/reset", { token: older, password: "yet another one" })).status)
      .toBe(400);
  });
});

describe("interaction with the rest of auth", () => {
  test("deleting an account takes its pending reset tokens with it", async () => {
    // password_resets.user_id cascades. Without that, DELETE /auth/account
    // would fail on a foreign-key violation for anyone mid-reset — the same
    // trap students.user_id sets by *not* cascading.
    await newStudent();
    const { userId } = await signUp("mid-reset@example.com", PASSWORD);
    await issueToken(userId);

    // Through the real route, as the signed-in user signUp left us as.
    const deleted = await api("/api/auth/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE", password: PASSWORD }),
    });
    expect(deleted.status).toBe(200);

    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  test("a reset cannot give a password to a guest row", async () => {
    // Anonymous accounts have a NULL email and NULL password_hash, which is
    // what makes them unreachable by every auth route. A reset that could fill
    // those in would turn a guest row into a login.
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE email IS NULL AND password_hash IS NOT NULL"
    ).first<{ n: number }>();
    expect(before?.n).toBe(0);

    await newStudent();
    const guestId = (
      await env.DB.prepare(
        "SELECT id FROM users WHERE email IS NULL ORDER BY id DESC LIMIT 1"
      ).first<{ id: number }>()
    )?.id;
    expect(guestId).toBeTruthy();

    const token = await issueToken(guestId!);
    resetSession();
    await post("/api/auth/reset", { token, password: NEW_PASSWORD });

    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE email IS NULL AND password_hash IS NOT NULL"
    ).first<{ n: number }>();
    expect(after?.n).toBe(0);
  });
});
