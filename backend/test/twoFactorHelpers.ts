// The enrolled account both two-factor suites start from.
//
// twoFactor.test.ts proves the flow and twoFactorLimit.test.ts proves the
// budget of wrong codes around it. Both need an account with a second factor
// switched on through the real routes, and codes made from its secret the way a
// phone would make them — so they share one copy rather than two that drift.

import { env } from "cloudflare:test";
import { body, newStudent, post, signUp } from "./helpers.js";
import { totpCode, timeStep } from "../src/auth/totp.js";

export const PASSWORD = "correct horse battery";

/** The secret as the database holds it — what the user's phone would have. */
export async function secretFor(userId: number): Promise<string> {
  const row = await env.DB.prepare("SELECT totp_secret FROM users WHERE id = ?")
    .bind(userId)
    .first<{ totp_secret: string | null }>();
  return row!.totp_secret!;
}

/** A code for right now, exactly as an authenticator app would produce it. */
export async function codeFor(userId: number, offsetSteps = 0): Promise<string> {
  return totpCode(await secretFor(userId), timeStep() + offsetSteps);
}

/**
 * A signed-up account with 2FA switched on, plus its recovery codes.
 *
 * Goes through the real routes rather than writing rows, so every test starts
 * from a state the application can actually produce.
 */
export async function enrolled(email: string) {
  await newStudent();
  const { userId } = await signUp(email, PASSWORD);
  await post("/api/auth/2fa/setup", { password: PASSWORD });
  const res = await post("/api/auth/2fa/enable", { code: await codeFor(userId) });
  const { recoveryCodes } = await body<{ recoveryCodes: string[] }>(res, 200);
  return { userId, recoveryCodes };
}
