// Read-only share links (Phase 6.7).
//
// This is the only unauthenticated read path into a student's data in the
// whole API, so most of what follows asserts what is *not* in the response.
// Those tests are the point of the file: a future field added to the profile
// or a `...student` spread creeping into the handler would widen what a
// forwarded URL exposes, silently, and nothing else in the suite would notice.

import { beforeEach, describe, expect, test } from "vitest";
import {
  body,
  currentCookie,
  del,
  get,
  newStudent,
  post,
  put,
  resetRateLimits,
  resetSession,
  signUp,
  useSession,
} from "./helpers.js";

const MIT = 1;

beforeEach(resetRateLimits);

/** A student with a plan worth sharing. */
async function studentWithAPlan(): Promise<string> {
  const id = await newStudent({
    name: "Sam Rivera",
    gpa: 3.8,
    satScore: 1450,
    interestedMajors: ["CS"],
    careerGoals: "Build medical devices.",
    financialNeed: "high",
  });
  await post(`/api/students/${id}/applications`, { universityId: MIT, plan: "EA" });
  await put(`/api/students/${id}/notes/${MIT}`, {
    starred: true,
    note: "Loved the labs.",
    contactName: "Dana Ruiz",
  });
  return id;
}

async function shareToken(studentId: string): Promise<string> {
  const b = await body(await post(`/api/students/${studentId}/share`, {}), 201);
  return b.link.token;
}

describe("managing the link", () => {
  test("a student starts with none", async () => {
    const id = await newStudent();
    const b = await body(await get(`/api/students/${id}/share`), 200);
    expect(b.link).toBeNull();
  });

  test("creating one returns a token, and asking again returns the same one", async () => {
    const id = await newStudent();
    const first = await body(await post(`/api/students/${id}/share`, {}), 201);
    const second = await body(await post(`/api/students/${id}/share`, {}), 201);

    expect(first.link.token).toMatch(/^[0-9a-f-]{36}$/);
    // Idempotent on purpose: a reload must not strand the URL already sent.
    expect(second.link.token).toBe(first.link.token);
  });

  test("rotating mints a new token and kills the old one immediately", async () => {
    const id = await studentWithAPlan();
    const old = await shareToken(id);
    const rotated = await body(await post(`/api/students/${id}/share`, { rotate: true }), 201);

    expect(rotated.link.token).not.toBe(old);
    expect((await get(`/api/shared/${old}`)).status).toBe(404);
    expect((await get(`/api/shared/${rotated.link.token}`)).status).toBe(200);
  });

  test("revoking makes the link dead", async () => {
    const id = await studentWithAPlan();
    const token = await shareToken(id);
    expect((await get(`/api/shared/${token}`)).status).toBe(200);

    expect((await del(`/api/students/${id}/share`)).status).toBe(204);
    expect((await get(`/api/shared/${token}`)).status).toBe(404);
    expect((await body(await get(`/api/students/${id}/share`), 200)).link).toBeNull();
  });

  test("revoking twice is not an error", async () => {
    const id = await newStudent();
    await shareToken(id);
    expect((await del(`/api/students/${id}/share`)).status).toBe(204);
    expect((await del(`/api/students/${id}/share`)).status).toBe(204);
  });
});

describe("only the owner manages the link", () => {
  test("another signed-in student cannot read, create, or revoke it", async () => {
    const owner = await studentWithAPlan();
    // A second person, with their own session.
    await newStudent({ name: "Someone Else" });

    expect((await get(`/api/students/${owner}/share`)).status).toBe(403);
    expect((await post(`/api/students/${owner}/share`, {})).status).toBe(403);
    expect((await del(`/api/students/${owner}/share`)).status).toBe(403);
  });

  test("a signed-out visitor gets 401, not 403", async () => {
    const id = await newStudent();
    const owned = currentCookie();
    resetSession();

    expect((await get(`/api/students/${id}/share`)).status).toBe(401);
    expect((await post(`/api/students/${id}/share`, {})).status).toBe(401);

    useSession(owned);
    expect((await get(`/api/students/${id}/share`)).status).toBe(200);
  });
});

describe("the shared view", () => {
  test("opens with no session at all", async () => {
    const id = await studentWithAPlan();
    const token = await shareToken(id);
    resetSession();

    const b = await body(await get(`/api/shared/${token}`), 200);
    expect(b.student.name).toBe("Sam Rivera");
  });

  test("carries the plan: matches, scholarships, applications, saved schools", async () => {
    const id = await studentWithAPlan();
    const token = await shareToken(id);
    resetSession();

    const b = await body(await get(`/api/shared/${token}`), 200);
    expect(b.recommendations.reach.length + b.recommendations.target.length).toBeGreaterThan(0);
    expect(Object.keys(b.scholarships)).toEqual(["reach", "target", "safety"]);
    expect(b.applications).toHaveLength(1);
    expect(b.applications[0].university.shortName).toBe("MIT");
    expect(b.notes).toHaveLength(1);
    expect(b.notes[0].note).toBe("Loved the labs.");
    expect(b.cycleYear).toBeGreaterThan(2000);
  });

  test("shortlists the matches and reports the true totals", async () => {
    // The shared page is read by whoever the student sent it to, on whatever
    // device they have. It shipped uncapped while /recommendations was capped,
    // so the one list nobody could scroll past was the longest one.
    const id = await studentWithAPlan();
    const token = await shareToken(id);
    resetSession();

    const b = await body(await get(`/api/shared/${token}`), 200);
    expect(b.shownPerTier).toBeGreaterThan(0);
    for (const tier of ["reach", "target", "safety"] as const) {
      expect(b.recommendations[tier].length).toBeLessThanOrEqual(b.shownPerTier);
      // Without the true totals the page cannot say what it held back.
      expect(b.recommendationCounts[tier]).toBeGreaterThanOrEqual(b.recommendations[tier].length);
    }
  });

  test("an unknown token and a revoked one are the same 404", async () => {
    const id = await studentWithAPlan();
    const token = await shareToken(id);
    await del(`/api/students/${id}/share`);
    resetSession();

    const revoked = await get(`/api/shared/${token}`);
    const neverExisted = await get("/api/shared/11111111-2222-3333-4444-555555555555");

    expect(revoked.status).toBe(404);
    expect(neverExisted.status).toBe(404);
    // Identical bodies too: a different message is the same disclosure as a
    // different status.
    expect(await revoked.json()).toEqual(await neverExisted.json());
  });

  test("is never cached outside the reader's own tab", async () => {
    const id = await studentWithAPlan();
    const token = await shareToken(id);
    resetSession();

    const res = await get(`/api/shared/${token}`);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});

describe("what a shared link must never expose", () => {
  /** The whole response as raw text, so a leak in a nested field cannot hide. */
  async function sharedText(token: string): Promise<string> {
    const res = await get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    return res.text();
  }

  test("no chat history, from either assistant", async () => {
    const id = await studentWithAPlan();
    await post("/api/chat", { studentId: id, question: "Can my family afford this?" });
    await post("/api/chat", {
      studentId: id,
      question: "I want to write about my parents' divorce",
      mode: "essay",
    });
    const token = await shareToken(id);
    resetSession();

    const text = await sharedText(token);
    expect(text).not.toContain("afford this");
    expect(text).not.toContain("divorce");
    expect(text).not.toContain("messages");
  });

  test("no email address, even when the account has one", async () => {
    const id = await studentWithAPlan();
    await signUp("shared-view@example.com");
    const token = await shareToken(id);
    resetSession();

    expect(await sharedText(token)).not.toContain("shared-view@example.com");
  });

  test("no session cookie, user id, or student id", async () => {
    const id = await studentWithAPlan();
    const cookie = currentCookie();
    const token = await shareToken(id);
    resetSession();

    const text = await sharedText(token);
    expect(text).not.toContain(cookie!.split("=")[1]!);
    // The student id is the key every owner-gated route takes. A holder of the
    // share link must not come away able to address those routes by id.
    expect(text).not.toContain(id);
    expect(text).not.toContain("userId");
  });

  // The most sensitive field in the profile, and not needed to read a plan.
  test("no financial need", async () => {
    const id = await studentWithAPlan();
    const token = await shareToken(id);
    resetSession();

    const b = await body(await get(`/api/shared/${token}`), 200);
    expect(b.student.financialNeed).toBeUndefined();
    expect(await sharedText(token)).not.toContain("financialNeed");
  });

  // Guards rule 1 in the handler: the payload is enumerated, never spread. If
  // someone swaps it for `...student`, this is what fails.
  test("the student object holds exactly the agreed fields", async () => {
    const id = await studentWithAPlan();
    const token = await shareToken(id);
    resetSession();

    const b = await body(await get(`/api/shared/${token}`), 200);
    expect(Object.keys(b.student).sort()).toEqual(
      [
        "actScore",
        "careerGoals",
        "extracurriculars",
        "gpa",
        "interestedMajors",
        "name",
        "preferredRegions",
        "satScore",
      ].sort()
    );
  });

  test("holding a link grants no write of any kind", async () => {
    const id = await studentWithAPlan();
    const token = await shareToken(id);
    resetSession();

    // The token is not a session: every owner-gated route still refuses.
    expect((await get(`/api/students/${id}`)).status).toBe(401);
    expect((await put(`/api/students/${id}/notes/${MIT}`, { note: "hi" })).status).toBe(401);
    expect((await del(`/api/students/${id}/share`)).status).toBe(401);
    // And the link itself is read-only.
    expect((await del(`/api/shared/${token}`)).status).toBe(404);
    expect((await post(`/api/shared/${token}`, {})).status).toBe(404);
  });
});

describe("edge cases", () => {
  test("a token-shaped string that is not a token is a 404, not a 500", async () => {
    resetSession();
    for (const token of ["", "%20", "../students/1", "'; DROP TABLE share_links;--"]) {
      const res = await get(`/api/shared/${encodeURIComponent(token)}`);
      expect([404, 400]).toContain(res.status);
    }
  });

  test("a profile with nothing on it still shares cleanly", async () => {
    const id = await newStudent();
    const token = await shareToken(id);
    resetSession();

    const b = await body(await get(`/api/shared/${token}`), 200);
    expect(b.applications).toEqual([]);
    expect(b.notes).toEqual([]);
  });
});
