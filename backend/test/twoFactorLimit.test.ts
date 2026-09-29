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
import { PASSWORD, codeFor, enrolled, secretFor } from "./twoFactorHelpers.js";
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

/** Spend the free wrong codes on signing in, from networks 0 to 4. */
async function failSignIns(email: string, wrong: string): Promise<void> {
  for (let n = 0; n < FREE_FAILURES; n++) {
    expect((await signInFrom(n, email, wrong)).status).toBe(401);
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
    // but the settings routes can. Through the routes the timing cannot be
    // pinned down, so this goes to the claim itself.
    const store = createStore(env.DB);
    const { id: userId } = await store.createAnonymousUser();

    const outcomes = await Promise.all([
      store.claimSecondFactorAttempt(userId, "password", CLAIM_HOLD_MS),
      store.claimSecondFactorAttempt(userId, "password", CLAIM_HOLD_MS),
    ]);
    const refused = outcomes.flatMap((o) => (o.claimed ? [] : [o.retryAfterMs]));
    expect(outcomes.filter((o) => o.claimed)).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toBeGreaterThan(0);
    expect(refused[0]).toBeLessThanOrEqual(CLAIM_HOLD_MS);

    // Settling the claim — here a first wrong code, which carries no wait —
    // replaces the hold, and the next attempt is let in.
    await store.recordSecondFactorFailure(userId, "password", waitAfter(1));
    expect(await store.claimSecondFactorAttempt(userId, "password", CLAIM_HOLD_MS)).toEqual({
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
    const email = "doubling@example.com";
    const { userId } = await enrolled(email);
    const wrong = await wrongCodeFor(userId);

    await failSignIns(email, wrong);
    await expectLock(userId, "password", 5, 1 * MINUTE);

    await unlock(userId, "password");
    expect((await signInFrom(5, email, wrong)).status).toBe(401);
    await expectLock(userId, "password", 6, 2 * MINUTE);

    await unlock(userId, "password");
    expect((await signInFrom(6, email, wrong)).status).toBe(401);
    await expectLock(userId, "password", 7, 4 * MINUTE);
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

describe("the settings routes share the sign-in count", () => {
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

    const res = await postFrom(FREE_FAILURES, "/api/auth/2fa/disable", {
      password: PASSWORD,
      code: await codeFor(userId, 1),
    });
    expect(res.status).toBe(429);
    expect((await body<{ enabled: boolean }>(await get("/api/auth/2fa"), 200)).enabled).toBe(true);
  });

  test("setting it up again spends the sign-in count too, and a lock replaces nothing", async () => {
    // With 2FA on, setting up again replaces the secret — so a code guessed
    // right here would put someone else's phone where the owner's was.
    const { userId } = await enrolled("resetup-limit@example.com");
    const secret = await secretFor(userId);
    const wrong = await wrongCodeFor(userId);

    for (let n = 0; n < FREE_FAILURES; n++) {
      expect(
        (await postFrom(n, "/api/auth/2fa/setup", { password: PASSWORD, code: wrong })).status
      ).toBe(403);
    }
    await expectLock(userId, "password", FREE_FAILURES, 1 * MINUTE);

    const res = await postFrom(FREE_FAILURES, "/api/auth/2fa/setup", {
      password: PASSWORD,
      code: await codeFor(userId, 1),
    });
    expect(res.status).toBe(429);
    expect(await body(res)).not.toHaveProperty("secret");
    expect(await secretFor(userId)).toBe(secret);
    expect((await body<{ enabled: boolean }>(await get("/api/auth/2fa"), 200)).enabled).toBe(true);
  });
});

describe("what is not a guess", () => {
  test("setting it up again with no code counts nothing", async () => {
    // Refused for what is missing, not charged as a wrong code: nothing was guessed.
    const { userId } = await enrolled("resetup-no-code@example.com");
    expect((await postFrom(0, "/api/auth/2fa/setup", { password: PASSWORD })).status).toBe(409);
    expect((await postFrom(1, "/api/auth/2fa/setup", { password: PASSWORD, code: "  " })).status)
      .toBe(409);
    expect(await countFor(userId, "password")).toBeNull();
  });

  test("sending a blank code counts nothing", async () => {
    const email = "asking@example.com";
    const { userId } = await enrolled(email);

    // A blank code at sign-in is refused, but nothing was guessed.
    expect((await signInFrom(2, email, "   ")).status).toBe(401);

    expect(await countFor(userId, "password")).toBeNull();
  });
});
