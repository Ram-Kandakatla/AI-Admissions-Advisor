// The per-account limit on wrong two-factor codes.
//
// twoFactor.test.ts proves the flow; this proves the budget around it. The
// per-network limiter on these routes stops one machine, so every attempt here
// comes from its own address — which is the attack the limit exists for, and
// shows it is the account's count doing the stopping, not the network's.
//
// Waits are skipped by moving locked_until into the past rather than by faking
// the clock. The row is exactly what the route reads, so nothing about the
// route itself is stubbed.

import { beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import {
  api,
  body,
  currentCookie,
  get,
  resetRateLimits,
  resetSession,
  useSession,
} from "./helpers.js";
import { PASSWORD, codeFor, enrolled, resetTokenFor, secretFor } from "./twoFactorHelpers.js";
import { totpCode, timeStep } from "../src/auth/totp.js";
import {
  CLAIM_HOLD_MS,
  FREE_FAILURES,
  describeWait,
  waitAfter,
  type FirstFactor,
} from "../src/auth/secondFactorLimit.js";
import { createStore } from "../src/store/dataStore.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

beforeEach(async () => {
  await resetRateLimits();
});

/**
 * Headers for a request from network `n`.
 *
 * Each attempt comes from a different address. That is the attack, and it keeps
 * the per-network limit — 15 per address — from being what any test here runs
 * into.
 */
function fromNetwork(n: number): Record<string, string> {
  return { "CF-Connecting-IP": `198.51.100.${n}` };
}

function postFrom(n: number, path: string, payload: unknown): Promise<Response> {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...fromNetwork(n) },
    body: JSON.stringify(payload),
  });
}

/** A whole sign-in from network `n`, in a fresh browser: the password, then `code`. */
async function signInFrom(n: number, email: string, code: string): Promise<Response> {
  resetSession();
  const login = await postFrom(n, "/api/auth/login", { email, password: PASSWORD });
  const { challenge } = await body<{ challenge: string }>(login, 200);
  return postFrom(n, "/api/auth/2fa/verify", { challenge, code });
}

/** Use a reset link from network `n`. Leaving out `code` is how the page asks whether it needs one. */
function resetFrom(n: number, token: string, code?: string): Promise<Response> {
  return postFrom(n, "/api/auth/reset", {
    token,
    password: "a brand new passphrase",
    ...(code === undefined ? {} : { code }),
  });
}

/** Spend the free wrong codes on signing in, from networks 0 to 4. */
async function failSignIns(email: string, wrong: string): Promise<void> {
  for (let n = 0; n < FREE_FAILURES; n++) {
    expect((await signInFrom(n, email, wrong)).status).toBe(401);
  }
}

/** Spend the free wrong codes on a reset link, from networks 0 to 4. */
async function failResets(token: string, wrong: string): Promise<void> {
  for (let n = 0; n < FREE_FAILURES; n++) {
    expect((await resetFrom(n, token, wrong)).status).toBe(401);
  }
}

/**
 * A six-digit code that is certainly wrong.
 *
 * "000000" is right about once in 300,000 tries, and this file makes dozens of
 * wrong guesses a run: a rare flake that would look exactly like the limit
 * misbehaving. The codes for two steps either side of now are ruled out, so a
 * step ticking over mid-test cannot make it right either.
 */
async function wrongCodeFor(userId: number): Promise<string> {
  const secret = await secretFor(userId);
  const now = timeStep();
  const near = await Promise.all([-2, -1, 0, 1, 2].map((d) => totpCode(secret, now + d)));
  for (let n = 0; ; n++) {
    const candidate = String(n).padStart(6, "0");
    if (!near.includes(candidate)) return candidate;
  }
}

/** The stored count for one factor, or null when there is none. */
function countFor(userId: number, factor: FirstFactor) {
  return env.DB.prepare(
    "SELECT failures, locked_until FROM mfa_attempts WHERE user_id = ? AND factor = ?"
  )
    .bind(userId, factor)
    .first<{ failures: number; locked_until: string }>();
}

/** Skip a wait without faking the clock. */
async function unlock(userId: number, factor: FirstFactor): Promise<void> {
  await env.DB.prepare(
    "UPDATE mfa_attempts SET locked_until = '2000-01-01T00:00:00.000Z' WHERE user_id = ? AND factor = ?"
  )
    .bind(userId, factor)
    .run();
}

/** Assert the count, and a lock that lifts `waitMs` from about now. */
async function expectLock(
  userId: number,
  factor: FirstFactor,
  failures: number,
  waitMs: number
): Promise<void> {
  const row = await countFor(userId, factor);
  expect(row?.failures).toBe(failures);
  // Seconds of slack for the requests themselves; the waits being told apart
  // are at least a minute apart.
  expect(Math.abs(Date.parse(row!.locked_until) - (Date.now() + waitMs))).toBeLessThan(5_000);
}

describe("the schedule", () => {
  test("the first five wrong codes cost no wait", () => {
    for (let failures = 0; failures < FREE_FAILURES; failures++) {
      expect(waitAfter(failures)).toBe(0);
    }
  });

  test("then a minute, doubling with each one", () => {
    expect(waitAfter(5)).toBe(1 * MINUTE);
    expect(waitAfter(6)).toBe(2 * MINUTE);
    expect(waitAfter(7)).toBe(4 * MINUTE);
    expect(waitAfter(10)).toBe(32 * MINUTE);
  });

  test("never more than a day", () => {
    expect(waitAfter(15)).toBeLessThan(DAY);
    expect(waitAfter(16)).toBe(DAY);
    expect(waitAfter(1000)).toBe(DAY);
  });

  test("allows 15 guesses in the first day and under 400 in a year", () => {
    // The numbers the reasoning in secondFactorLimit.ts rests on, for someone
    // guessing as fast as the schedule lets them.
    const guessesWithin = (ms: number) => {
      let guesses = 0;
      for (let at = 0; at < ms; at += waitAfter(guesses)) guesses++;
      return guesses;
    };
    expect(guessesWithin(DAY)).toBe(15);
    expect(guessesWithin(365 * DAY)).toBeLessThan(400);
  });

  test("describes a wait the way a person would say it, rounding up", () => {
    expect(describeWait(0)).toBe("a few seconds");
    expect(describeWait(10_000)).toBe("a few seconds");
    expect(describeWait(1 * MINUTE)).toBe("a minute");
    // Up, never down: the message must not send someone back before the lock lifts.
    expect(describeWait(90_000)).toBe("2 minutes");
    expect(describeWait(59 * MINUTE)).toBe("59 minutes");
    expect(describeWait(60 * MINUTE)).toBe("an hour");
    expect(describeWait(waitAfter(15))).toBe("18 hours");
  });
});

describe("the claim", () => {
  test("of two attempts at once, one is checked and the other waits", async () => {
    // Signing in cannot run in parallel — an account has one live challenge —
    // but a reset link and the settings routes can. Through the routes the
    // timing cannot be pinned down, so this goes to the claim itself.
    const store = createStore(env.DB);
    const { id: userId } = await store.createAnonymousUser();

    const outcomes = await Promise.all([
      store.claimSecondFactorAttempt(userId, "reset", CLAIM_HOLD_MS),
      store.claimSecondFactorAttempt(userId, "reset", CLAIM_HOLD_MS),
    ]);
    const refused = outcomes.flatMap((o) => (o.claimed ? [] : [o.retryAfterMs]));
    expect(outcomes.filter((o) => o.claimed)).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toBeGreaterThan(0);
    expect(refused[0]).toBeLessThanOrEqual(CLAIM_HOLD_MS);

    // Settling the claim — here a first wrong code, which carries no wait —
    // replaces the hold, and the next attempt is let in.
    await store.recordSecondFactorFailure(userId, "reset", waitAfter(1));
    expect(await store.claimSecondFactorAttempt(userId, "reset", CLAIM_HOLD_MS)).toEqual({
      claimed: true,
      failures: 1,
    });
  });
});

describe("wrong codes", () => {
  test("five are free; the sixth attempt waits, even with the right code", async () => {
    const email = "sixth@example.com";
    const { userId } = await enrolled(email);
    await failSignIns(email, await wrongCodeFor(userId));

    const res = await signInFrom(FREE_FAILURES, email, await codeFor(userId, 1));
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(50);
    expect(retryAfter).toBeLessThanOrEqual(60);
    const { error } = await body<{ error: string }>(res);
    expect(error).toMatch(/too many incorrect codes.*try again in a minute/i);
    // Shown only past the password, so it can say what that suggests.
    expect(error).toMatch(/someone may know your password/i);
    // Refused before the code was checked, so nobody was signed in.
    expect(await body(await get("/api/auth/me"), 200)).toEqual({ user: null, studentId: null });
  });

  test("each one after that doubles the wait", async () => {
    const { userId } = await enrolled("doubling@example.com");
    const token = await resetTokenFor(userId);
    const wrong = await wrongCodeFor(userId);
    resetSession();

    await failResets(token, wrong);
    await expectLock(userId, "reset", 5, 1 * MINUTE);

    await unlock(userId, "reset");
    expect((await resetFrom(5, token, wrong)).status).toBe(401);
    await expectLock(userId, "reset", 6, 2 * MINUTE);

    await unlock(userId, "reset");
    expect((await resetFrom(6, token, wrong)).status).toBe(401);
    await expectLock(userId, "reset", 7, 4 * MINUTE);
  });

  test("once the wait is over, the code refused during it still works", async () => {
    const email = "wait-ends@example.com";
    const { userId } = await enrolled(email);
    await failSignIns(email, await wrongCodeFor(userId));
    const code = await codeFor(userId, 1);
    expect((await signInFrom(5, email, code)).status).toBe(429);

    await unlock(userId, "password");
    // Refused without being checked, so its time-step was never spent.
    expect((await signInFrom(6, email, code)).status).toBe(200);
  });

  test("a lock does not spend a recovery code", async () => {
    const email = "keep-codes@example.com";
    const { userId, recoveryCodes } = await enrolled(email);
    const owner = currentCookie();
    await failSignIns(email, await wrongCodeFor(userId));

    // Checking a recovery code spends it, so a refused attempt must not check it.
    expect((await signInFrom(5, email, recoveryCodes[0]!)).status).toBe(429);

    useSession(owner);
    expect(await body(await get("/api/auth/2fa"), 200)).toMatchObject({
      recoveryCodesRemaining: 10,
    });
  });

  test("a right code clears the count", async () => {
    const email = "clears@example.com";
    const { userId } = await enrolled(email);
    const wrong = await wrongCodeFor(userId);
    for (let n = 0; n < FREE_FAILURES - 1; n++) {
      expect((await signInFrom(n, email, wrong)).status).toBe(401);
    }
    expect((await countFor(userId, "password"))?.failures).toBe(FREE_FAILURES - 1);

    expect((await signInFrom(4, email, await codeFor(userId, 1))).status).toBe(200);
    expect(await countFor(userId, "password")).toBeNull();

    // The next wrong code starts a count of its own, not a fifth strike.
    expect((await signInFrom(5, email, wrong)).status).toBe(401);
    expect((await countFor(userId, "password"))?.failures).toBe(1);
  });
});

describe("signing in and resetting keep separate counts", () => {
  test("someone with the password cannot lock the owner out of recovering by email", async () => {
    const email = "recover@example.com";
    const { userId } = await enrolled(email);
    const wrong = await wrongCodeFor(userId);
    // Guessing at codes behind the password until sign-in locks.
    await failSignIns(email, wrong);
    expect((await signInFrom(FREE_FAILURES, email, wrong)).status).toBe(429);

    // The owner resets through their inbox, with the right code.
    const token = await resetTokenFor(userId);
    resetSession();
    expect((await resetFrom(0, token, await codeFor(userId, 1))).status).toBe(200);
    // And that right code lifted the sign-in lock in the same step.
    expect(await countFor(userId, "password")).toBeNull();
  });

  test("someone with the inbox cannot lock the owner out of signing in", async () => {
    const email = "signin-still@example.com";
    const { userId } = await enrolled(email);
    const token = await resetTokenFor(userId);
    const wrong = await wrongCodeFor(userId);
    resetSession();

    // Guessing at codes behind a reset link until it locks.
    await failResets(token, wrong);
    const locked = await resetFrom(FREE_FAILURES, token, wrong);
    expect(locked.status).toBe(429);
    const b = await body<{ error: string; mfaRequired: boolean }>(locked);
    // Kept on the code step, and no password hint: this caller came in through
    // the inbox, not the password.
    expect(b.mfaRequired).toBe(true);
    expect(b.error).not.toMatch(/password/i);
    // None of it spent the link.
    const link = await env.DB.prepare("SELECT used_at FROM password_resets WHERE user_id = ?")
      .bind(userId)
      .first<{ used_at: string | null }>();
    expect(link?.used_at).toBeNull();

    // The owner signs in as usual.
    expect((await signInFrom(FREE_FAILURES + 1, email, await codeFor(userId, 1))).status).toBe(200);
  });

  test("the two-factor settings spend the sign-in count", async () => {
    // They are reached with the password, so they draw on its count — which is
    // also what stops a session plus a stolen password from guessing its way to
    // switching two-factor off.
    const { userId } = await enrolled("settings@example.com");
    const wrong = await wrongCodeFor(userId);

    expect(
      (await postFrom(0, "/api/auth/2fa/recovery-codes", { password: PASSWORD, code: wrong })).status
    ).toBe(403);
    for (let n = 1; n < FREE_FAILURES; n++) {
      expect(
        (await postFrom(n, "/api/auth/2fa/disable", { password: PASSWORD, code: wrong })).status
      ).toBe(403);
    }
    await expectLock(userId, "password", FREE_FAILURES, 1 * MINUTE);
    expect(await countFor(userId, "reset")).toBeNull();

    const res = await postFrom(FREE_FAILURES, "/api/auth/2fa/disable", {
      password: PASSWORD,
      code: await codeFor(userId, 1),
    });
    expect(res.status).toBe(429);
    expect((await body<{ enabled: boolean }>(await get("/api/auth/2fa"), 200)).enabled).toBe(true);
  });
});

describe("what is not a guess", () => {
  test("asking for the code prompt, or sending a blank code, counts nothing", async () => {
    const email = "asking@example.com";
    const { userId } = await enrolled(email);
    const token = await resetTokenFor(userId);
    resetSession();

    // A link with no code is how the reset page learns it needs one.
    expect(await body(await resetFrom(0, token), 200)).toEqual({ mfaRequired: true });
    expect(await body(await resetFrom(1, token, ""), 200)).toEqual({ mfaRequired: true });
    // A blank code at sign-in is refused, but nothing was guessed.
    expect((await signInFrom(2, email, "   ")).status).toBe(401);

    expect(await countFor(userId, "reset")).toBeNull();
    expect(await countFor(userId, "password")).toBeNull();
  });
});
