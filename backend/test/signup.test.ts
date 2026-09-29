// Signup — POST /api/auth/signup.
//
// Signup is a claim, not a create: the caller almost always already has a
// guest row from building a profile anonymously, and signing up fills in that
// row's email and password rather than minting a second one. The assertions
// that matter most are that it reuses the guest's row and profile rather than
// orphaning it, that an already-registered address is refused plainly (there
// is no inbox-based flow left for silence to protect), and that the caller
// ends up signed in immediately.

import { beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import { body, currentCookie, get, newStudent, post, resetRateLimits, resetSession, signUp } from "./helpers.js";

const PASSWORD = "correct horse battery";

beforeEach(resetRateLimits);

let seq = 0;
const freshEmail = () => `signup${seq++}.${crypto.randomUUID().slice(0, 8)}@example.com`;

const requestSignup = (email: string, password = PASSWORD) =>
  post("/api/auth/signup", { email, password });

const accountFor = (email: string) =>
  env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();

describe("signing up", () => {
  test("creates the account on the spot and signs the caller in, keeping the guest's profile", async () => {
    const email = freshEmail();
    const id = await newStudent({ name: "Ada" });
    const before = currentCookie();

    const b = await body(await requestSignup(email), 200);
    expect(b.user.email).toBe(email);
    expect(b.user.guest).toBe(false);
    // The reason signup is a claim: the row that owned the guest profile is the
    // account now, so nothing was reparented.
    expect(b.studentId).toBe(id);
    expect(b.discardedGuestProfile).toBe(false);
    // A fresh session id at the privilege boundary, as login issues one.
    expect(currentCookie()).not.toBe(before);
    expect((await body(await get(`/api/students/${id}`), 200)).name).toBe("Ada");
  });

  test("the address is normalised before it is stored", async () => {
    const email = freshEmail();
    await newStudent();
    await requestSignup(`  ${email.toUpperCase()}  `);
    expect(await accountFor(email)).toBeTruthy();
  });

  test("the password is stored hashed, never in the clear", async () => {
    const email = freshEmail();
    await newStudent();
    const res = await requestSignup(email);
    // Raw text, so a hash nested anywhere in the body would still trip it.
    expect(await res.text()).not.toContain("pbkdf2");
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE email = ?")
      .bind(email)
      .first<{ password_hash: string }>();
    expect(row!.password_hash.startsWith("pbkdf2$")).toBe(true);
    expect(row!.password_hash).not.toContain(PASSWORD);
  });

  test("still says what is wrong with the form itself", async () => {
    const bad = await body(await post("/api/auth/signup", { email: "nope", password: "x" }), 400);
    expect(bad.errors).toHaveLength(2);
  });

  test("refuses a signup from a session that is already a signed-in account", async () => {
    await signUp(freshEmail());
    expect((await requestSignup(freshEmail())).status).toBe(409);
  });

  test("an address that already has an account is refused, and nothing about it changes", async () => {
    const taken = freshEmail();
    await newStudent();
    await signUp(taken);

    resetSession();
    const res = await requestSignup(taken, "a different password");
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toMatch(/sign in/i);

    // The original account's own password still works.
    resetSession();
    expect((await post("/api/auth/login", { email: taken, password: PASSWORD })).status).toBe(200);
  });
});
