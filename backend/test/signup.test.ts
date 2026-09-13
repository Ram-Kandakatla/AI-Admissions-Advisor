// Signup — POST /api/auth/signup and POST /api/auth/verify.
//
// The assertions that matter most are about what signup refuses to reveal and
// refuses to let happen: the same answer for an address with an account and
// one without, no account until the emailed link is used, and no way to finish
// someone else's signup by opening a link you never asked for. None of those
// changes the happy path, which is exactly why a refactor would drop them
// without anything else noticing.
//
// No email is ever sent here — no RESEND_API_KEY is set. Where a test needs the
// link, it re-keys the pending row to a token it knows (confirmationTokenFor in
// helpers.ts). Where it asserts that something did *not* happen, it first waits
// for a positive signal from the same background task, because the work runs
// after the response.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  api,
  body,
  confirmationTokenFor,
  currentCookie,
  eventually,
  get,
  newStudent,
  post,
  resetRateLimits,
  resetSession,
  signUp,
  useSession,
} from "./helpers.js";

const PASSWORD = "correct horse battery";

beforeEach(resetRateLimits);

afterEach(() => {
  vi.restoreAllMocks();
  env.LOG_LEVEL = "silent";
});

let seq = 0;
const freshEmail = () => `signup${seq++}.${crypto.randomUUID().slice(0, 8)}@example.com`;

const requestSignup = (email: string, password = PASSWORD) =>
  post("/api/auth/signup", { email, password });

const login = (email: string, password: string) =>
  post("/api/auth/login", { email, password });

interface PendingRow {
  token_hash: string;
  email: string;
  password_hash: string;
  guest_user_id: number;
}

async function pendingFor(email: string): Promise<PendingRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT token_hash, email, password_hash, guest_user_id FROM pending_signups WHERE email = ?"
  )
    .bind(email)
    .all<PendingRow>();
  return results;
}

/** The first pending row for `email`, once the background task has written it. */
const firstPending = (email: string) =>
  eventually(async () => (await pendingFor(email))[0], `a pending signup for ${email}`);

const accountFor = (email: string) =>
  env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();

/**
 * Collect the `msg` of every log line the Worker writes at `level` or above.
 *
 * The tests that assert on absence use this to know a background task has
 * finished: each branch of the signup task ends by logging, and with no email
 * provider configured, that line is deterministic.
 */
function watchLog(level: string): string[] {
  env.LOG_LEVEL = level;
  const messages: string[] = [];
  for (const method of ["warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((line: unknown) => {
      try {
        messages.push((JSON.parse(String(line)) as { msg: string }).msg);
      } catch {
        /* not one of ours */
      }
    });
  }
  return messages;
}

describe("asking to sign up tells you nothing about who has an account", () => {
  test("answers identically for a new address and one that already has an account", async () => {
    const taken = freshEmail();
    await newStudent();
    await signUp(taken);

    resetSession();
    const forTaken = await requestSignup(taken, "a different password");
    resetSession();
    const forFresh = await requestSignup(freshEmail());

    expect(forTaken.status).toBe(202);
    expect(forFresh.status).toBe(202);
    expect(await forTaken.json()).toEqual(await forFresh.json());
  });

  test("an address with an account is sent a note, never a link", async () => {
    const taken = freshEmail();
    await newStudent();
    await signUp(taken);

    const log = watchLog("error");
    resetSession();
    await requestSignup(taken, "somebody else's password");
    // The notice branch's last act, with no provider configured. Until it has
    // happened, "no pending row" would prove nothing.
    await eventually(
      async () => log.includes("signup notice requested but not delivered"),
      "the notice to be attempted"
    );

    // Nothing that could create or change an account was written...
    expect(await pendingFor(taken)).toHaveLength(0);
    // ...and the account's own password still works.
    resetSession();
    expect((await login(taken, PASSWORD)).status).toBe(200);
  });

  test("still says what is wrong with the form itself", async () => {
    // Shape errors describe what was typed, not who has an account.
    const bad = await body(await post("/api/auth/signup", { email: "nope", password: "x" }), 400);
    expect(bad.errors).toHaveLength(2);
  });

  test("refuses a signup from a session that is already a signed-in account", async () => {
    // A fact about the caller's own session, not about the address typed.
    await signUp(freshEmail());
    expect((await requestSignup(freshEmail())).status).toBe(409);
  });
});

describe("nothing exists until the link is opened", () => {
  test("a request signs nobody in and creates no account", async () => {
    const email = freshEmail();
    const id = await newStudent({ name: "Ada" });
    await requestSignup(email);
    await firstPending(email);

    const me = await body(await get("/api/auth/me"), 200);
    expect(me.user.guest).toBe(true);
    expect(me.studentId).toBe(id);
    expect(await accountFor(email)).toBeNull();
  });

  test("what waits is hashed — the token and the password alike", async () => {
    const email = freshEmail();
    await newStudent();
    await requestSignup(email);

    const row = await firstPending(email);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.password_hash.startsWith("pbkdf2$")).toBe(true);
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
  });

  test("the address is normalised before anything is compared", async () => {
    // Case and surrounding space must not be enough to sign up twice.
    const email = freshEmail();
    await newStudent();
    await requestSignup(`  ${email.toUpperCase()}  `);

    expect((await firstPending(email)).email).toBe(email);
  });
});

describe("opening the link", () => {
  test("in the browser that asked, the link alone finishes it and keeps the guest's profile", async () => {
    const email = freshEmail();
    const id = await newStudent({ name: "Ada" });
    await requestSignup(email);
    const token = await confirmationTokenFor(email);
    const before = currentCookie();

    const b = await body(await post("/api/auth/verify", { token }), 200);
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

  test("anywhere else, it asks for the password chosen at signup", async () => {
    const email = freshEmail();
    const id = await newStudent();
    await requestSignup(email);
    const token = await confirmationTokenFor(email);

    resetSession(); // the same link, opened on another device
    expect(await body(await post("/api/auth/verify", { token }), 200)).toEqual({
      passwordRequired: true,
    });
    expect((await post("/api/auth/verify", { token, password: "not the one" })).status).toBe(401);

    // A wrong guess does not spend the link.
    const b = await body(await post("/api/auth/verify", { token, password: PASSWORD }), 200);
    expect(b.user.email).toBe(email);
    expect(b.studentId).toBe(id);
  });

  test("someone who opens a link they never asked for cannot finish it", async () => {
    // Account pre-hijacking: sign up with somebody else's address and a
    // password of your own, and wait for them to click.
    const victim = freshEmail();
    await newStudent({ name: "Requester" });
    const requester = currentCookie();
    await requestSignup(victim, "the requester's password");
    const token = await confirmationTokenFor(victim);

    // The owner of the inbox opens it in their own browser, with a list of
    // their own in progress.
    resetSession();
    await newStudent({ name: "Owner" });
    expect(await body(await post("/api/auth/verify", { token }), 200)).toEqual({
      passwordRequired: true,
    });
    expect((await post("/api/auth/verify", { token, password: PASSWORD })).status).toBe(401);

    // No account exists for the address, and the requester is still a guest.
    expect(await accountFor(victim)).toBeNull();
    useSession(requester);
    expect((await body(await get("/api/auth/me"), 200)).user.guest).toBe(true);
  });

  test("a link works once", async () => {
    const email = freshEmail();
    await newStudent();
    await requestSignup(email);
    const token = await confirmationTokenFor(email);

    expect((await post("/api/auth/verify", { token })).status).toBe(200);
    expect((await post("/api/auth/verify", { token, password: PASSWORD })).status).toBe(400);
  });

  test("an expired link is refused", async () => {
    const email = freshEmail();
    await newStudent();
    await requestSignup(email);
    const token = await confirmationTokenFor(email);
    await env.DB.prepare("UPDATE pending_signups SET expires_at = ? WHERE email = ?")
      .bind("2020-01-01T00:00:00.000Z", email)
      .run();

    expect((await post("/api/auth/verify", { token })).status).toBe(400);
  });

  test("never returns a password hash", async () => {
    const email = freshEmail();
    await newStudent();
    await requestSignup(email);

    const res = await post("/api/auth/verify", { token: await confirmationTokenFor(email) });
    // Raw text, so a hash nested anywhere in the body would still trip it.
    expect(await res.text()).not.toContain("pbkdf2");
  });

  test("if the address got an account some other way first, the link says to sign in", async () => {
    const email = freshEmail();
    await newStudent();
    await requestSignup(email);
    const token = await confirmationTokenFor(email);
    // Stands in for a second pending signup for the same address, confirmed
    // a moment earlier by whoever holds the inbox.
    await env.DB.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)")
      .bind(email, "pbkdf2$placeholder", new Date().toISOString())
      .run();

    const res = await post("/api/auth/verify", { token });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toMatch(/sign in/i);
  });

  test("confirming one address cancels the other signups the same guest started", async () => {
    await newStudent();
    const first = freshEmail();
    const second = freshEmail();
    await requestSignup(first);
    const firstToken = await confirmationTokenFor(first);
    await requestSignup(second);
    const secondToken = await confirmationTokenFor(second);

    expect((await post("/api/auth/verify", { token: firstToken })).status).toBe(200);
    // One guest profile becomes one account, not two.
    expect(
      (await post("/api/auth/verify", { token: secondToken, password: PASSWORD })).status
    ).toBe(400);
  });

  test("a guest who deletes their account takes their pending signup with it", async () => {
    const email = freshEmail();
    await newStudent();
    await requestSignup(email);
    const token = await confirmationTokenFor(email);

    const deleted = await api("/api/auth/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(deleted.status).toBe(200);

    // The address typed into the form was personal data too.
    expect(await pendingFor(email)).toHaveLength(0);
    expect((await post("/api/auth/verify", { token, password: PASSWORD })).status).toBe(400);
  });
});

describe("the inbox it mails", () => {
  test("one address is sent at most three signup emails an hour", async () => {
    const email = freshEmail();
    const log = watchLog("warn");

    // Four networks' worth of requests would look the same: each is a fresh
    // session, so only the per-address cap can stop the fourth.
    for (let i = 0; i < 4; i++) {
      resetSession();
      await requestSignup(email);
    }

    // Three rows from the sends that went ahead, and the skip line from the
    // one that did not: all four background tasks have decided.
    await eventually(
      async () =>
        log.includes("signup email skipped — that address has had its share this hour") &&
        (await pendingFor(email)).length === 3,
      "all four requests to be decided"
    );
    expect(await pendingFor(email)).toHaveLength(3);
  });

  test("the counter holds a hash of the address, never the address", async () => {
    const email = freshEmail();
    await newStudent();
    await requestSignup(email);
    await firstPending(email);

    const { results } = await env.DB.prepare(
      "SELECT client FROM rate_limits WHERE bucket = 'signup-mail'"
    ).all<{ client: string }>();
    const clients = results.map((r) => r.client);
    expect(clients).toContainEqual(expect.stringMatching(/^email:[0-9a-f]{64}$/));
    for (const client of clients) expect(client).not.toContain(email);
  });
});
