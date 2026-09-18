// Accounts, sessions, and ownership.
//
// The implementation guide singles out one regression as the most common in
// apps like this: a route that silently drops its auth check on a future edit.
// The 401/403 paths are therefore tested per route in security.test.ts; this
// suite covers the machinery those checks rest on — that a session is issued,
// revoked, and scoped correctly. Signup itself, and the guest profile it keeps,
// are in signup.test.ts.

import { beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import {
  body,
  currentCookie,
  eventually,
  get,
  newStudent,
  post,
  put,
  resetRateLimits,
  resetSession,
  signUp,
  useSession,
} from "./helpers.js";
import { hashPassword, needsRehash, verifyPassword } from "../src/auth/password.js";

const PASSWORD = "correct horse battery";

// Signup and login share one rate-limit bucket keyed on the client, and every
// test here runs as the same client. Without this the fifteenth test in the
// file would start failing for a reason that has nothing to do with what it
// asserts.
beforeEach(resetRateLimits);

// Unique per test, so a run never collides with a row an earlier test wrote.
let seq = 0;
const freshEmail = () => `student${seq++}.${crypto.randomUUID().slice(0, 8)}@example.com`;

/**
 * Build a hash at 100,000 iterations — the cost in use before the Workers free
 * plan's 10ms CPU cap forced it down to 25,000. Derived independently of
 * password.ts on purpose: a fixture built by the code under test agrees with
 * itself no matter what it does.
 */
async function hashAtLegacyCost(password: string): Promise<string> {
  const iterations = 100_000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return ["pbkdf2", "SHA-256", iterations, hex(salt), hex(new Uint8Array(bits))].join("$");
}

describe("password hashing", () => {
  test("a hash verifies against its own password and nothing else", async () => {
    const stored = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword(PASSWORD + "!", stored)).toBe(false);
  });

  test("the same password hashes differently every time", async () => {
    // Per-password salt. Without it, identical passwords produce identical
    // hashes and one rainbow table cracks every account that shares one.
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  test("the stored form carries its own cost, and survives a null", async () => {
    const stored = await hashPassword(PASSWORD);
    expect(stored.startsWith("pbkdf2$SHA-256$25000$")).toBe(true);
    // An anonymous user row has password_hash NULL by design; reaching one on
    // a login attempt must read as a wrong password, not a 500.
    expect(await verifyPassword(PASSWORD, null)).toBe(false);
    expect(await verifyPassword(PASSWORD, "not-a-hash")).toBe(false);
  });

  // The claim that lets ITERATIONS move without a migration, and the reason
  // lowering it to 25,000 stranded nobody. Derived here rather than taken from
  // hashPassword, which would write today's cost and so assert nothing: if
  // verifyPassword ever stopped reading the cost out of the string and used
  // the configured one instead, this is the test that fails.
  test("a hash written at a superseded cost still verifies", async () => {
    const legacy = await hashAtLegacyCost(PASSWORD);
    expect(legacy.startsWith("pbkdf2$SHA-256$100000$")).toBe(true);
    expect(await verifyPassword(PASSWORD, legacy)).toBe(true);
    expect(await verifyPassword(PASSWORD + "!", legacy)).toBe(false);
  });

  test("needsRehash spots a superseded cost and ignores what it cannot parse", () => {
    expect(needsRehash("pbkdf2$SHA-256$100000$aa$bb")).toBe(true);
    expect(needsRehash("pbkdf2$SHA-256$25000$aa$bb")).toBe(false);
    // Nothing to upgrade, and nothing that should throw on the login path.
    expect(needsRehash(null)).toBe(false);
    expect(needsRehash("not-a-hash")).toBe(false);
  });
});

describe("guest profiles", () => {
  test("a profile can be built with no account, and is owned from the start", async () => {
    // The product's front door: no signup required. The point of Phase 2 is
    // that "no account" no longer means "no owner".
    resetSession();
    const id = await newStudent({ name: "Guest" });
    expect(currentCookie()).toMatch(/^__Host-compass_session=/);

    const me = await body(await get("/api/auth/me"), 200);
    expect(me.user.guest).toBe(true);
    expect(me.user.email).toBeNull();
    expect(me.studentId).toBe(id);
  });

  test("one profile per account", async () => {
    await newStudent();
    const second = await post("/api/students", {
      name: "Second",
      gpa: 3.0,
      interestedMajors: ["CS"],
    });
    // Before Phase 2 this created a duplicate row and orphaned the first —
    // which is what the frontend did on every profile edit.
    expect(second.status).toBe(409);
    expect((await second.json<{ studentId: string }>()).studentId).toBeTruthy();
  });
});

describe("login", () => {
  test("returns the account's profile and rotates the session", async () => {
    const email = freshEmail();
    const id = await newStudent({ name: "Rae" });
    await signUp(email, PASSWORD);
    const beforeLogout = currentCookie();

    await post("/api/auth/logout", {});
    const b = await body(await post("/api/auth/login", { email, password: PASSWORD }), 200);

    expect(b.studentId).toBe(id);
    expect(b.user.email).toBe(email);
    // Session fixation: the id handed out at the privilege boundary must not
    // be one that existed before it.
    expect(currentCookie()).not.toBe(beforeLogout);
  });

  test("a wrong password and an unknown email are indistinguishable", async () => {
    const email = freshEmail();
    await signUp(email);
    resetSession();

    const wrong = await post("/api/auth/login", { email, password: "wrong-password" });
    const missing = await post("/api/auth/login", {
      email: freshEmail(),
      password: PASSWORD,
    });

    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    // Same message, so the response body is not an account-enumeration oracle.
    // fakeVerify() covers the timing half of the same problem.
    expect(await wrong.json()).toEqual(await missing.json());
  });

  // The upgrade keeps verifyPassword and fakeVerify burning the same cost. Skip
  // it and a hash left at 100,000 verifies ~4x slower than fakeVerify's 25,000,
  // which hands back by stopwatch exactly what the shared 401 message withholds.
  test("logging in upgrades a password hash left at a superseded cost", async () => {
    const email = freshEmail();
    const { userId } = await signUp(email);
    resetSession();

    // Rewind this account to the pre-cap cost, as a row written before the
    // change would be.
    const legacy = await hashAtLegacyCost(PASSWORD);
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .bind(legacy, userId)
      .run();

    // The old hash still works — nobody is locked out by the cost change.
    await body(await post("/api/auth/login", { email, password: PASSWORD }), 200);

    // The rewrite rides on waitUntil, which SELF.fetch does not await.
    const upgraded = await eventually(async () => {
      const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
        .bind(userId)
        .first<{ password_hash: string }>();
      return row && row.password_hash !== legacy ? row.password_hash : null;
    }, "the password hash to be rewritten at the current cost");

    expect(upgraded.startsWith("pbkdf2$SHA-256$25000$")).toBe(true);
    // Upgraded in place, not reset: the password itself is unchanged.
    expect(await verifyPassword(PASSWORD, upgraded)).toBe(true);
  });

  test("a guest account cannot be logged into", async () => {
    // Anonymous rows have email NULL, and `WHERE email = ?` never matches a
    // NULL — so they are unreachable by construction, not by a check.
    await newStudent();
    const res = await post("/api/auth/login", { email: "", password: PASSWORD });
    expect(res.status).toBe(400);
  });

  test("says so when logging in leaves a guest draft behind", async () => {
    const email = freshEmail();
    const saved = await newStudent({ name: "Saved" });
    await signUp(email, PASSWORD);

    // A new visitor builds a draft, then signs into the account above.
    resetSession();
    await newStudent({ name: "Draft" });
    const b = await body(await post("/api/auth/login", { email, password: PASSWORD }), 200);

    // The account's own profile wins — it is the one deliberately saved — but
    // the client is told, so the UI can say it rather than appearing to lose
    // the work silently.
    expect(b.studentId).toBe(saved);
    expect(b.discardedGuestProfile).toBe(true);
  });
});

describe("logout", () => {
  test("revokes the session server-side, not just in the browser", async () => {
    const id = await newStudent();
    const cookie = currentCookie()!;

    expect((await post("/api/auth/logout", {})).status).toBe(204);
    expect((await body(await get("/api/auth/me"), 200)).user).toBeNull();

    // The real test: replay the old cookie. A JWT would still be valid here —
    // this is the entire reason sessions are rows.
    useSession(cookie);
    expect((await get(`/api/students/${id}`)).status).toBe(401);
  });
});

describe("ownership between accounts", () => {
  test("one account cannot read or write another's profile", async () => {
    const a = await newStudent({ name: "A" });
    const aCookie = currentCookie()!;

    const b = await newStudent({ name: "B" });
    expect(b).not.toBe(a);

    // B is signed in and holds A's id. That is not enough.
    expect((await get(`/api/students/${a}`)).status).toBe(403);
    expect((await put(`/api/students/${a}`, { name: "Hacked", gpa: 4, interestedMajors: ["CS"] })).status).toBe(403);
    expect((await get(`/api/students/${a}/recommendations`)).status).toBe(403);
    expect((await post("/api/chat", { question: "hi", studentId: a })).status).toBe(403);
    expect((await get(`/api/majors/CS?studentId=${a}`)).status).toBe(403);

    useSession(aCookie);
    expect((await body(await get(`/api/students/${a}`), 200)).name).toBe("A");
  });

  test("an expired session is treated as no session at all", async () => {
    const id = await newStudent();
    const cookie = currentCookie()!;
    const sessionId = cookie.split("=")[1]!;

    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", sessionId)
      .run();

    // Expiry is enforced in the lookup's WHERE clause, so there is no path
    // where a stale session is read and then forgotten about.
    expect((await get(`/api/students/${id}`)).status).toBe(401);
  });
});

describe("unauthenticated access", () => {
  test("public routes still work with no session", async () => {
    resetSession();
    for (const path of ["/api/health", "/api/universities", "/api/meta", "/api/majors"]) {
      expect((await get(path)).status, path).toBe(200);
    }
    // Chat without a profile is the offline/anonymous path, and stays open.
    expect((await post("/api/chat", { question: "How does the FAFSA work?" })).status).toBe(200);
  });

  test("/api/auth/me is empty rather than an error", async () => {
    resetSession();
    const b = await body(await get("/api/auth/me"), 200);
    expect(b).toEqual({ user: null, studentId: null });
  });
});
