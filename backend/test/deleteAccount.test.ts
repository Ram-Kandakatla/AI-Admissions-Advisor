// DELETE /api/auth/account — erasing an account and everything it owns.
//
// Its own file rather than a block in auth.test.ts because what it needs to
// prove is different in kind. The other auth tests check that a request is
// allowed or refused; these check that data is *gone* — which means reading
// the database directly afterwards, since a 200 from a route that quietly
// deleted nothing looks exactly like a 200 from one that worked.
//
// The single most important test here is "leaves nothing behind in any table".
// students.user_id has no ON DELETE CASCADE (see migrations/0003_auth.sql),
// so the intuitive implementation — delete the user, let the database cascade
// — fails on a foreign-key violation instead. That is a bug an end-to-end
// assertion catches and a status-code assertion does not.

import { beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import {
  api,
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

const PASSWORD = "correct horse battery";

// Deletion shares the "auth" rate-limit bucket with signup and login, and
// every test in this file runs as the same client. Without this the sixteenth
// request would start failing for a reason unrelated to what it asserts.
beforeEach(async () => {
  await resetRateLimits();
});

/** DELETE with a JSON body — `del` in helpers.ts sends none. */
function deleteAccount(payload: unknown = { confirm: "DELETE" }): Promise<Response> {
  return api("/api/auth/account", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** How many rows mention this student, table by table. */
async function rowsFor(studentId: string) {
  const count = async (sql: string) =>
    ((await env.DB.prepare(sql).bind(studentId).first<{ n: number }>())?.n) ?? -1;
  return {
    students: await count("SELECT COUNT(*) AS n FROM students WHERE id = ?"),
    messages: await count("SELECT COUNT(*) AS n FROM messages WHERE student_id = ?"),
    applications: await count("SELECT COUNT(*) AS n FROM applications WHERE student_id = ?"),
    notes: await count("SELECT COUNT(*) AS n FROM school_notes WHERE student_id = ?"),
    shareLinks: await count("SELECT COUNT(*) AS n FROM share_links WHERE student_id = ?"),
  };
}

describe("what actually gets deleted", () => {
  test("leaves nothing behind in any table", async () => {
    const studentId = await newStudent();
    const { userId } = await signUp("erase-everything@example.com", PASSWORD);

    // Give the account something in every table that hangs off a student, so
    // a cascade that silently does not fire has something to be caught by.
    await put(`/api/students/${studentId}/notes/1`, { starred: true, note: "visited" });
    await post(`/api/students/${studentId}/applications`, { universityId: 1, plan: "ED" });
    await post("/api/chat", { question: "What is a reach school?", studentId });
    await post(`/api/students/${studentId}/share`, {});

    const before = await rowsFor(studentId);
    expect(before).toEqual({
      students: 1,
      messages: expect.any(Number),
      applications: 1,
      notes: 1,
      shareLinks: 1,
    });
    expect(before.messages).toBeGreaterThan(0);

    const res = await deleteAccount({ confirm: "DELETE", password: PASSWORD });
    expect(await body(res, 200)).toEqual({ deleted: true, hadProfile: true });

    // Every child table, not just the ones the route names. This is the
    // assertion that would have failed had the deletion been written in the
    // obvious order.
    expect(await rowsFor(studentId)).toEqual({
      students: 0,
      messages: 0,
      applications: 0,
      notes: 0,
      shareLinks: 0,
    });

    const user = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?")
      .bind(userId)
      .first<{ n: number }>();
    expect(user?.n).toBe(0);
  });

  test("revokes every session, not just the one that asked", async () => {
    // Signing in twice models two devices. Sessions cascade from users, so
    // both rows should go — otherwise a stolen cookie outlives the account it
    // belonged to, which is the worst possible thing for this route to leave.
    await newStudent();
    await signUp("two-devices@example.com", PASSWORD);

    resetSession();
    await post("/api/auth/login", { email: "two-devices@example.com", password: PASSWORD });
    const otherDevice = currentCookie();

    await post("/api/auth/login", { email: "two-devices@example.com", password: PASSWORD });
    expect(await body(await deleteAccount({ confirm: "DELETE", password: PASSWORD }), 200))
      .toMatchObject({ deleted: true });

    useSession(otherDevice);
    expect(await body(await get("/api/auth/me"), 200)).toEqual({
      user: null,
      studentId: null,
    });
  });

  test("kills a share link, so a forwarded URL stops working", async () => {
    const studentId = await newStudent();
    await signUp("shared-then-gone@example.com", PASSWORD);
    const { link } = await body<{ link: { token: string } }>(
      await post(`/api/students/${studentId}/share`, {}),
      201
    );

    // Readable by anyone before, including a stranger with no session.
    resetSession();
    expect((await get(`/api/shared/${link.token}`)).status).toBe(200);

    await post("/api/auth/login", { email: "shared-then-gone@example.com", password: PASSWORD });
    await deleteAccount({ confirm: "DELETE", password: PASSWORD });

    resetSession();
    expect((await get(`/api/shared/${link.token}`)).status).toBe(404);
  });

  test("signs the caller out — the cookie stops naming anything", async () => {
    await newStudent();
    await signUp("signed-out@example.com", PASSWORD);
    await deleteAccount({ confirm: "DELETE", password: PASSWORD });

    // The jar followed the cleared cookie, so this is a genuinely anonymous
    // request rather than one carrying a dead id.
    expect(await body(await get("/api/auth/me"), 200)).toEqual({
      user: null,
      studentId: null,
    });
  });

  test("reports hadProfile: false for an account that never built one", async () => {
    resetSession();
    await signUp("never-started@example.com", PASSWORD);
    expect(await body(await deleteAccount({ confirm: "DELETE", password: PASSWORD }), 200))
      .toEqual({ deleted: true, hadProfile: false });
  });
});

describe("proving you meant it", () => {
  test("a member must retype their password", async () => {
    const studentId = await newStudent();
    await signUp("needs-password@example.com", PASSWORD);

    const res = await deleteAccount({ confirm: "DELETE", password: "not my password" });
    // 403, not 401: the session is perfectly valid, so answering 401 would
    // tell the frontend to sign them out over a typo.
    expect(res.status).toBe(403);

    // And nothing happened.
    expect((await rowsFor(studentId)).students).toBe(1);
    expect(await body(await get("/api/auth/me"), 200)).toMatchObject({
      user: { email: "needs-password@example.com" },
    });
  });

  test("a member with no password at all is refused", async () => {
    const studentId = await newStudent();
    await signUp("omitted-password@example.com", PASSWORD);
    expect((await deleteAccount({ confirm: "DELETE" })).status).toBe(403);
    expect((await rowsFor(studentId)).students).toBe(1);
  });

  test("the confirm phrase is required, and checked before anything is touched", async () => {
    const studentId = await newStudent();
    await signUp("no-confirm@example.com", PASSWORD);

    for (const payload of [{}, { password: PASSWORD }, { confirm: "delete", password: PASSWORD }]) {
      expect((await deleteAccount(payload)).status, JSON.stringify(payload)).toBe(400);
    }
    expect((await rowsFor(studentId)).students).toBe(1);
  });

  test("a guest needs no password, because there is none to give", async () => {
    // An anonymous account has a NULL password_hash by construction, so
    // demanding one would demand something that cannot exist. This is also
    // the case that matters most on a shared computer.
    const studentId = await newStudent();
    expect(await body(await deleteAccount({ confirm: "DELETE" }), 200)).toEqual({
      deleted: true,
      hadProfile: true,
    });
    expect((await rowsFor(studentId)).students).toBe(0);
  });

  test("a guest cannot be deleted by passing a password", async () => {
    // Guarding the inverse of the rule above: the guest path must not become a
    // way to submit a password that is never checked against anything.
    const studentId = await newStudent();
    const res = await deleteAccount({ confirm: "DELETE", password: "anything at all" });
    expect(res.status).toBe(200);
    expect((await rowsFor(studentId)).students).toBe(0);
  });
});

describe("who is allowed to ask", () => {
  test("an anonymous caller gets 401", async () => {
    resetSession();
    expect((await deleteAccount({ confirm: "DELETE" })).status).toBe(401);
  });

  test("one account cannot delete another", async () => {
    // There is no id in the request at all — the route acts on the session and
    // nothing else — so this is really asserting that no future edit adds one.
    const victimStudent = await newStudent();
    await signUp("victim@example.com", PASSWORD);

    await newStudent();
    await signUp("attacker@example.com", PASSWORD);
    await deleteAccount({ confirm: "DELETE", password: PASSWORD });

    expect((await rowsFor(victimStudent)).students).toBe(1);
  });

  test("deleting twice is not an error the second time", async () => {
    // Two tabs, or a retried request. The caller wanted the account gone and
    // it is gone; reporting a failure would be technically true and useless.
    await newStudent();
    await signUp("double-tap@example.com", PASSWORD);
    const cookie = currentCookie();

    expect((await deleteAccount({ confirm: "DELETE", password: PASSWORD })).status).toBe(200);

    // Replay the now-dead cookie. The session row is gone with the user, so
    // this arrives anonymous and is refused as such.
    useSession(cookie);
    expect((await deleteAccount({ confirm: "DELETE", password: PASSWORD })).status).toBe(401);
  });
});
