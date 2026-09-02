// Accounts, sessions, and ownership.
//
// The implementation guide singles out one regression as the most common in
// apps like this: a route that silently drops its auth check on a future edit.
// The 401/403 paths are therefore tested per route in security.test.ts; this
// suite covers the machinery those checks rest on — that a session is issued,
// revoked, and scoped correctly, and that a guest profile survives signup.

import { beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import {
  body,
  currentCookie,
  get,
  newStudent,
  post,
  put,
  resetRateLimits,
  resetSession,
  signUp,
  useSession,
} from "./helpers.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";

const PASSWORD = "correct horse battery";

// Signup and login share one rate-limit bucket keyed on the client, and every
// test here runs as the same client. Without this the fifteenth test in the
// file would start failing for a reason that has nothing to do with what it
// asserts.
beforeEach(resetRateLimits);

// Unique per test, so a run never collides with a row an earlier test wrote.
let seq = 0;
const freshEmail = () => `student${seq++}.${crypto.randomUUID().slice(0, 8)}@example.com`;

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
    expect(stored.startsWith("pbkdf2$SHA-256$100000$")).toBe(true);
    // An anonymous user row has password_hash NULL by design; reaching one on
    // a login attempt must read as a wrong password, not a 500.
    expect(await verifyPassword(PASSWORD, null)).toBe(false);
    expect(await verifyPassword(PASSWORD, "not-a-hash")).toBe(false);
  });
});

describe("signup", () => {
  test("creates an account and starts a session", async () => {
    const email = freshEmail();
    const b = await body(await post("/api/auth/signup", { email, password: PASSWORD }), 201);
    expect(b.user.email).toBe(email);
    expect(b.user.guest).toBe(false);
    expect(currentCookie()).toMatch(/^compass_session=/);

    const me = await body(await get("/api/auth/me"), 200);
    expect(me.user.email).toBe(email);
  });

  test("never returns the password hash", async () => {
    const res = await post("/api/auth/signup", { email: freshEmail(), password: PASSWORD });
    // Checked as raw text rather than on the parsed object, so a hash nested
    // anywhere in the response would still trip it.
    expect(await res.text()).not.toContain("pbkdf2");
  });

  test("normalises the email and rejects a duplicate", async () => {
    const email = freshEmail();
    await signUp(email);

    resetSession();
    const dup = await post("/api/auth/signup", {
      // Case and surrounding space must not be enough to register twice.
      email: `  ${email.toUpperCase()}  `,
      password: PASSWORD,
    });
    expect(dup.status).toBe(409);
  });

  test("rejects a malformed email and a short password", async () => {
    const bad = await body(await post("/api/auth/signup", { email: "nope", password: "x" }), 400);
    expect(bad.errors).toHaveLength(2);
  });

  test("refuses a second account from a session that already has one", async () => {
    await signUp(freshEmail());
    const res = await post("/api/auth/signup", { email: freshEmail(), password: PASSWORD });
    expect(res.status).toBe(409);
  });
});

describe("guest profiles", () => {
  test("a profile can be built with no account, and is owned from the start", async () => {
    // The product's front door: no signup required. The point of Phase 2 is
    // that "no account" no longer means "no owner".
    resetSession();
    const id = await newStudent({ name: "Guest" });
    expect(currentCookie()).toMatch(/^compass_session=/);

    const me = await body(await get("/api/auth/me"), 200);
    expect(me.user.guest).toBe(true);
    expect(me.user.email).toBeNull();
    expect(me.studentId).toBe(id);
  });

  test("signing up keeps the profile the guest already built", async () => {
    const id = await newStudent({ name: "Ada" });
    const res = await body(
      await post("/api/auth/signup", { email: freshEmail(), password: PASSWORD }),
      201
    );

    // The whole reason guests get a users row: signup fills in the email and
    // password on the row that already owns the profile, so nothing is
    // reparented and there is no claim-time migration to get wrong.
    expect(res.studentId).toBe(id);
    expect((await body(await get(`/api/students/${id}`), 200)).name).toBe("Ada");
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
    await post("/api/auth/signup", { email, password: PASSWORD });
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
    await post("/api/auth/signup", { email, password: PASSWORD });

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
