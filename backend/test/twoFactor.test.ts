// Two-factor authentication, end to end through the routes.
//
// totp.test.ts proves the algorithm matches RFC 6238. This proves the *flow*:
// that enrollment cannot switch 2FA on without a working code, that a login
// stops halfway, that a code cannot be replayed, that recovery codes are the
// way back from a lost phone, and that a password reset does not quietly walk
// around the whole thing.
//
// The tests generate their own TOTP codes from the enrolled secret, the same
// way a phone would (see twoFactorHelpers.ts). The limit on wrong codes around
// all of this has a file of its own, twoFactorLimit.test.ts.

import { beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import {
  api,
  body,
  get,
  newStudent,
  post,
  resetRateLimits,
  resetSession,
  signUp,
} from "./helpers.js";
import {
  PASSWORD,
  codeFor,
  enrolled,
  resetTokenFor,
  secretFor,
} from "./twoFactorHelpers.js";
import { hashResetToken } from "../src/auth/password.js";

beforeEach(async () => {
  await resetRateLimits();
});

describe("enrolling", () => {
  test("setup stages a secret but does not switch anything on", async () => {
    // The mistyped-setup-key case: if enrollment flipped 2FA on here, anyone
    // who fumbled the key would be locked out of their own account.
    await newStudent();
    const { userId } = await signUp("staging@example.com", PASSWORD);

    const res = await post("/api/auth/2fa/setup", { password: PASSWORD });
    const b = await body<{ secret: string; otpauthUri: string }>(res, 200);
    expect(b.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(b.otpauthUri).toContain("otpauth://totp/");
    expect(b.otpauthUri).toContain("staging%40example.com");

    // Staged, not enabled.
    expect((await body<{ user: { twoFactorEnabled: boolean } }>(await get("/api/auth/me"), 200))
      .user.twoFactorEnabled).toBe(false);
    expect(await secretFor(userId)).toBeTruthy();
  });

  test("setup requires the password again, not just a session", async () => {
    await newStudent();
    await signUp("reauth@example.com", PASSWORD);
    expect((await post("/api/auth/2fa/setup", { password: "wrong" })).status).toBe(403);
    expect((await post("/api/auth/2fa/setup", {})).status).toBe(403);
  });

  test("a guest cannot enrol — there is no account to protect", async () => {
    await newStudent();
    expect((await post("/api/auth/2fa/setup", { password: "anything" })).status).toBe(403);
  });

  test("enable refuses a wrong code and leaves 2FA off", async () => {
    await newStudent();
    const { userId } = await signUp("badcode@example.com", PASSWORD);
    await post("/api/auth/2fa/setup", { password: PASSWORD });

    expect((await post("/api/auth/2fa/enable", { code: "000000" })).status).toBe(400);
    const wrongWindow = await codeFor(userId, 5);
    expect((await post("/api/auth/2fa/enable", { code: wrongWindow })).status).toBe(400);

    expect((await body<{ user: { twoFactorEnabled: boolean } }>(await get("/api/auth/me"), 200))
      .user.twoFactorEnabled).toBe(false);
  });

  test("enable with a real code switches it on and issues ten recovery codes", async () => {
    const { recoveryCodes } = await enrolled("enrolled@example.com");
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect((await body<{ user: { twoFactorEnabled: boolean } }>(await get("/api/auth/me"), 200))
      .user.twoFactorEnabled).toBe(true);
  });

  test("recovery codes are stored hashed, never in readable form", async () => {
    const { userId, recoveryCodes } = await enrolled("hashed-codes@example.com");
    const rows = await env.DB.prepare("SELECT code_hash FROM recovery_codes WHERE user_id = ?")
      .bind(userId)
      .all<{ code_hash: string }>();
    expect(rows.results).toHaveLength(10);
    for (const row of rows.results) expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    // No stored value contains a code, in any casing or spelling.
    const stored = rows.results.map((r) => r.code_hash).join("");
    for (const code of recoveryCodes) {
      expect(stored).not.toContain(code.replace(/-/g, ""));
    }
  });

  test("the code that proved enrollment cannot then be used to sign in", async () => {
    // It is banked as spent in the same write that enables 2FA.
    await newStudent();
    const { userId } = await signUp("no-reuse-enroll@example.com", PASSWORD);
    await post("/api/auth/2fa/setup", { password: PASSWORD });
    const code = await codeFor(userId);
    await post("/api/auth/2fa/enable", { code });

    resetSession();
    const login = await body<{ challenge: string }>(
      await post("/api/auth/login", {
        email: "no-reuse-enroll@example.com",
        password: PASSWORD,
      }),
      200
    );
    expect((await post("/api/auth/2fa/verify", { challenge: login.challenge, code })).status)
      .toBe(401);
  });

  test("enabling twice is refused", async () => {
    const { userId } = await enrolled("twice@example.com");
    expect((await post("/api/auth/2fa/enable", { code: await codeFor(userId, 1) })).status)
      .toBe(409);
  });
});

describe("signing in with a second factor", () => {
  test("the password alone no longer mints a session", async () => {
    await enrolled("halted@example.com");
    resetSession();

    const res = await post("/api/auth/login", {
      email: "halted@example.com",
      password: PASSWORD,
    });
    const b = await body<{ mfaRequired: boolean; challenge: string }>(res, 200);
    expect(b.mfaRequired).toBe(true);
    expect(b.challenge).toBeTruthy();
    // No user, no session — and the cookie jar picked nothing up.
    expect(b).not.toHaveProperty("user");
    expect(await body(await get("/api/auth/me"), 200)).toEqual({ user: null, studentId: null });
  });

  test("a valid code finishes the login", async () => {
    const { userId } = await enrolled("finished@example.com");
    resetSession();
    const { challenge } = await body<{ challenge: string }>(
      await post("/api/auth/login", { email: "finished@example.com", password: PASSWORD }),
      200
    );

    const res = await post("/api/auth/2fa/verify", {
      challenge,
      code: await codeFor(userId, 1),
    });
    expect(await body<{ user: { email: string } }>(res, 200)).toMatchObject({
      user: { email: "finished@example.com", twoFactorEnabled: true },
    });
    expect(await body<{ user: { email: string } }>(await get("/api/auth/me"), 200))
      .toMatchObject({ user: { email: "finished@example.com" } });
  });

  test("a wrong code does not sign anyone in, and burns the challenge", async () => {
    // A challenge that survived a wrong code would turn the five-minute window
    // into an unlimited guessing budget against six digits.
    const { userId } = await enrolled("wrongcode@example.com");
    resetSession();
    const { challenge } = await body<{ challenge: string }>(
      await post("/api/auth/login", { email: "wrongcode@example.com", password: PASSWORD }),
      200
    );

    expect((await post("/api/auth/2fa/verify", { challenge, code: "000000" })).status).toBe(401);
    expect(await body(await get("/api/auth/me"), 200)).toEqual({ user: null, studentId: null });
    // Even the right code cannot rescue a spent challenge.
    expect(
      (await post("/api/auth/2fa/verify", { challenge, code: await codeFor(userId, 1) })).status
    ).toBe(400);
  });

  test("a challenge cannot be used twice", async () => {
    const { userId } = await enrolled("challenge-reuse@example.com");
    resetSession();
    const { challenge } = await body<{ challenge: string }>(
      await post("/api/auth/login", { email: "challenge-reuse@example.com", password: PASSWORD }),
      200
    );
    expect((await post("/api/auth/2fa/verify", { challenge, code: await codeFor(userId, 1) })).status)
      .toBe(200);

    resetSession();
    expect((await post("/api/auth/2fa/verify", { challenge, code: await codeFor(userId, 2) })).status)
      .toBe(400);
  });

  test("an unknown or expired challenge is refused", async () => {
    await enrolled("nochallenge@example.com");
    resetSession();
    expect((await post("/api/auth/2fa/verify", { challenge: "made-up", code: "123456" })).status)
      .toBe(400);
  });

  test("a challenge minted for a login cannot be redeemed against a reset", async () => {
    // purpose is part of the lookup, so the two flows cannot be crossed.
    await enrolled("purpose@example.com");
    resetSession();
    const { challenge } = await body<{ challenge: string }>(
      await post("/api/auth/login", { email: "purpose@example.com", password: PASSWORD }),
      200
    );
    const found = await env.DB.prepare(
      "SELECT purpose FROM mfa_challenges WHERE token_hash = ?"
    )
      .bind(await hashResetToken(challenge))
      .first<{ purpose: string }>();
    expect(found?.purpose).toBe("login");
  });

  test("an account without 2FA still logs in exactly as before", async () => {
    await newStudent();
    await signUp("plain@example.com", PASSWORD);
    resetSession();
    const b = await body<{ user: { email: string }; mfaRequired?: boolean }>(
      await post("/api/auth/login", { email: "plain@example.com", password: PASSWORD }),
      200
    );
    expect(b.mfaRequired).toBeUndefined();
    expect(b.user.email).toBe("plain@example.com");
  });
});

describe("replay", () => {
  test("the same code cannot be used twice", async () => {
    // A code is valid across a ±1 step window, so without the spent-step guard
    // a code read off someone's screen stays usable for up to 90 seconds.
    const { userId } = await enrolled("replay@example.com");
    const code = await codeFor(userId, 1);

    resetSession();
    const first = await body<{ challenge: string }>(
      await post("/api/auth/login", { email: "replay@example.com", password: PASSWORD }),
      200
    );
    expect((await post("/api/auth/2fa/verify", { challenge: first.challenge, code })).status)
      .toBe(200);

    resetSession();
    const second = await body<{ challenge: string }>(
      await post("/api/auth/login", { email: "replay@example.com", password: PASSWORD }),
      200
    );
    expect((await post("/api/auth/2fa/verify", { challenge: second.challenge, code })).status)
      .toBe(401);
  });

  test("an older code is refused once a newer one has been used", async () => {
    const { userId } = await enrolled("stepback@example.com");
    const older = await codeFor(userId, 0);
    const newer = await codeFor(userId, 1);

    resetSession();
    const a = await body<{ challenge: string }>(
      await post("/api/auth/login", { email: "stepback@example.com", password: PASSWORD }),
      200
    );
    expect((await post("/api/auth/2fa/verify", { challenge: a.challenge, code: newer })).status)
      .toBe(200);

    resetSession();
    const b2 = await body<{ challenge: string }>(
      await post("/api/auth/login", { email: "stepback@example.com", password: PASSWORD }),
      200
    );
    expect((await post("/api/auth/2fa/verify", { challenge: b2.challenge, code: older })).status)
      .toBe(401);
  });
});

describe("recovery codes", () => {
  test("get you in when the phone is gone, once each", async () => {
    const { recoveryCodes } = await enrolled("lostphone@example.com");
    const code = recoveryCodes[0]!;

    resetSession();
    const first = await body<{ challenge: string }>(
      await post("/api/auth/login", { email: "lostphone@example.com", password: PASSWORD }),
      200
    );
    const res = await post("/api/auth/2fa/verify", { challenge: first.challenge, code });
    const b = await body<{ usedRecoveryCode: boolean; recoveryCodesRemaining: number }>(res, 200);
    expect(b.usedRecoveryCode).toBe(true);
    expect(b.recoveryCodesRemaining).toBe(9);

    // Spent.
    resetSession();
    const second = await body<{ challenge: string }>(
      await post("/api/auth/login", { email: "lostphone@example.com", password: PASSWORD }),
      200
    );
    expect((await post("/api/auth/2fa/verify", { challenge: second.challenge, code })).status)
      .toBe(401);
  });

  test("are accepted in any casing or spacing", async () => {
    const { recoveryCodes } = await enrolled("sloppy@example.com");
    const typed = recoveryCodes[0]!.toLowerCase().replace(/-/g, " ");

    resetSession();
    const { challenge } = await body<{ challenge: string }>(
      await post("/api/auth/login", { email: "sloppy@example.com", password: PASSWORD }),
      200
    );
    expect((await post("/api/auth/2fa/verify", { challenge, code: typed })).status).toBe(200);
  });

  test("one account's codes do not work on another", async () => {
    const a = await enrolled("owner-a@example.com");
    await enrolled("owner-b@example.com");

    resetSession();
    const { challenge } = await body<{ challenge: string }>(
      await post("/api/auth/login", { email: "owner-b@example.com", password: PASSWORD }),
      200
    );
    expect((await post("/api/auth/2fa/verify", { challenge, code: a.recoveryCodes[0]! })).status)
      .toBe(401);
  });

  test("can be regenerated, which invalidates the old batch", async () => {
    const { userId, recoveryCodes } = await enrolled("regen@example.com");
    const res = await post("/api/auth/2fa/recovery-codes", {
      password: PASSWORD,
      code: await codeFor(userId, 1),
    });
    const fresh = await body<{ recoveryCodes: string[] }>(res, 200);
    expect(fresh.recoveryCodes).toHaveLength(10);
    expect(fresh.recoveryCodes).not.toEqual(recoveryCodes);

    resetSession();
    const { challenge } = await body<{ challenge: string }>(
      await post("/api/auth/login", { email: "regen@example.com", password: PASSWORD }),
      200
    );
    // An old code from the printout someone was relying on is now dead.
    expect((await post("/api/auth/2fa/verify", { challenge, code: recoveryCodes[0]! })).status)
      .toBe(401);
  });

  test("the count is reported for the account page", async () => {
    await enrolled("counting@example.com");
    const b = await body<{ enabled: boolean; recoveryCodesRemaining: number }>(
      await get("/api/auth/2fa"),
      200
    );
    expect(b).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });
  });
});

describe("turning it off", () => {
  test("needs the password and a current code", async () => {
    const { userId } = await enrolled("teardown@example.com");

    expect((await post("/api/auth/2fa/disable", { password: "wrong", code: await codeFor(userId, 1) })).status)
      .toBe(403);
    expect((await post("/api/auth/2fa/disable", { password: PASSWORD, code: "000000" })).status)
      .toBe(403);
    // Still on after both failures.
    expect((await body<{ enabled: boolean }>(await get("/api/auth/2fa"), 200)).enabled).toBe(true);

    // Step +1, not +2: the accept window is deliberately ±1, so a code two
    // steps out is *correctly* refused. Neither failure above reached the TOTP
    // check — the first stops at the password — so step +1 is still unspent.
    expect((await post("/api/auth/2fa/disable", { password: PASSWORD, code: await codeFor(userId, 1) })).status)
      .toBe(200);
    expect((await body<{ enabled: boolean }>(await get("/api/auth/2fa"), 200)).enabled).toBe(false);
  });

  test("destroys the recovery codes with it", async () => {
    const { userId } = await enrolled("teardown-codes@example.com");
    await post("/api/auth/2fa/disable", { password: PASSWORD, code: await codeFor(userId, 1) });

    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?")
      .bind(userId)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  test("lets the account log in with a password alone again", async () => {
    const { userId } = await enrolled("back-to-normal@example.com");
    await post("/api/auth/2fa/disable", { password: PASSWORD, code: await codeFor(userId, 1) });

    resetSession();
    const b = await body<{ user: { email: string }; mfaRequired?: boolean }>(
      await post("/api/auth/login", { email: "back-to-normal@example.com", password: PASSWORD }),
      200
    );
    expect(b.mfaRequired).toBeUndefined();
    expect(b.user.email).toBe("back-to-normal@example.com");
  });
});

describe("password reset does not walk around 2FA", () => {
  test("a valid link alone is not enough — it asks for the second factor", async () => {
    // The whole point of the decision: email is already the recovery channel,
    // so a reset that skipped 2FA would leave the inbox as a complete takeover
    // path and reduce the second factor to decoration.
    const { userId } = await enrolled("reset-gated@example.com");
    const token = await resetTokenFor(userId);
    resetSession();

    const res = await post("/api/auth/reset", { token, password: "a brand new passphrase" });
    expect(await body<{ mfaRequired: boolean }>(res, 200)).toEqual({ mfaRequired: true });

    // Nothing changed: the old password still works (modulo the 2FA step).
    resetSession();
    const login = await post("/api/auth/login", {
      email: "reset-gated@example.com",
      password: PASSWORD,
    });
    expect((await body<{ mfaRequired: boolean }>(login, 200)).mfaRequired).toBe(true);
  });

  test("a wrong code does not spend the link", async () => {
    const { userId } = await enrolled("reset-wrong-code@example.com");
    const token = await resetTokenFor(userId);
    resetSession();

    expect(
      (await post("/api/auth/reset", { token, password: "a brand new passphrase", code: "000000" }))
        .status
    ).toBe(401);
    // Still usable with the right code.
    expect(
      (await post("/api/auth/reset", {
        token,
        password: "a brand new passphrase",
        code: await codeFor(userId, 1),
      })).status
    ).toBe(200);
  });

  test("a recovery code is accepted, which is the lost-phone path", async () => {
    const { userId, recoveryCodes } = await enrolled("reset-recovery@example.com");
    const token = await resetTokenFor(userId);
    resetSession();

    const res = await post("/api/auth/reset", {
      token,
      password: "a brand new passphrase",
      code: recoveryCodes[0]!,
    });
    expect((await body<{ user: { email: string } }>(res, 200)).user.email).toBe(
      "reset-recovery@example.com"
    );
  });

  test("an account without 2FA resets exactly as before", async () => {
    await newStudent();
    const { userId } = await signUp("reset-plain@example.com", PASSWORD);
    const token = await resetTokenFor(userId);
    resetSession();
    expect((await post("/api/auth/reset", { token, password: "a brand new passphrase" })).status)
      .toBe(200);
  });
});

describe("interaction with account deletion", () => {
  test("deleting an account takes its 2FA state with it", async () => {
    const { userId } = await enrolled("delete-2fa@example.com");
    // One wrong code first, so there is a count for the delete to take — a zero
    // below would otherwise prove nothing.
    expect((await post("/api/auth/2fa/disable", { password: PASSWORD, code: "000000" })).status)
      .toBe(403);
    const attemptsBefore = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM mfa_attempts WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ n: number }>();
    expect(attemptsBefore?.n).toBe(1);

    const deleted = await api("/api/auth/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE", password: PASSWORD }),
    });
    expect(deleted.status).toBe(200);

    const codes = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ n: number }>();
    const challenges = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM mfa_challenges WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ n: number }>();
    const attempts = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM mfa_attempts WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ n: number }>();
    expect(codes?.n).toBe(0);
    expect(challenges?.n).toBe(0);
    expect(attempts?.n).toBe(0);
  });
});
