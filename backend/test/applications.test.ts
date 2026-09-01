import { describe, expect, test } from "vitest";
import { body, del, get, newStudent, patch, post } from "./helpers.js";
import {
  currentCycleYear,
  typicalDeadline,
  validateApplication,
} from "../src/models/application.js";

describe("application model", () => {
  test("cycle year rolls over in July, not January", () => {
    // June still belongs to the cycle that opened the previous autumn.
    expect(currentCycleYear(new Date(2026, 5, 30))).toBe(2025);
    expect(currentCycleYear(new Date(2026, 6, 1))).toBe(2026);
    expect(currentCycleYear(new Date(2027, 0, 15))).toBe(2026);
  });

  test("typical deadlines follow the plan's convention", () => {
    expect(typicalDeadline("ED", 2026)).toBe("2026-11-01");
    expect(typicalDeadline("EA", 2026)).toBe("2026-11-01");
    // RD lands in the calendar year *after* the cycle opens.
    expect(typicalDeadline("RD", 2026)).toBe("2027-01-01");
    expect(typicalDeadline("ED2", 2026)).toBe("2027-01-01");
    // Rolling admission has no date to invent.
    expect(typicalDeadline("ROLLING", 2026)).toBeNull();
  });

  test("rejects impossible calendar dates", () => {
    expect(validateApplication({ universityId: 1, deadline: "2026-02-30" }).valid).toBe(false);
    expect(validateApplication({ universityId: 1, deadline: "2026-13-01" }).valid).toBe(false);
    expect(validateApplication({ universityId: 1, deadline: "11/01/2026" }).valid).toBe(false);
    expect(validateApplication({ universityId: 1, deadline: "2026-11-01" }).valid).toBe(true);
  });

  test("a seeded deadline is flagged typical; a supplied one is not", () => {
    const seeded = validateApplication({ universityId: 1, plan: "ED" }).application;
    expect(seeded.deadlineIsTypical).toBe(true);

    const given = validateApplication({
      universityId: 1,
      plan: "ED",
      deadline: "2026-11-15",
    }).application;
    expect(given.deadline).toBe("2026-11-15");
    expect(given.deadlineIsTypical).toBe(false);
  });
});

describe("application endpoints", () => {
  test("GET /api/application-meta exposes plans, statuses and checklist", async () => {
    const b = await body(await get("/api/application-meta"), 200);
    expect(b.plans.map((p: { key: string }) => p.key)).toContain("ED");
    expect(b.plans.find((p: { key: string }) => p.key === "ED").binding).toBe(true);
    expect(b.plans.find((p: { key: string }) => p.key === "RD").binding).toBe(false);
    expect(b.statuses).toContain("submitted");
    expect(b.checklist.length).toBeGreaterThan(0);
  });

  test("tracking a school seeds the plan's typical deadline", async () => {
    const id = await newStudent();
    const b = await body(
      await post(`/api/students/${id}/applications`, { universityId: 1, plan: "ED" }),
      201
    );
    expect(b.university.shortName).toBe("MIT");
    expect(b.deadline).toBe(typicalDeadline("ED"));
    expect(b.deadlineIsTypical).toBe(true);
    expect(b.status).toBe("planning");
  });

  test("the same school cannot be tracked twice", async () => {
    const id = await newStudent();
    await post(`/api/students/${id}/applications`, { universityId: 2 });
    const dup = await post(`/api/students/${id}/applications`, { universityId: 2 });
    expect(dup.status).toBe(409);
  });

  test("rejects a university outside the dataset", async () => {
    const id = await newStudent();
    const res = await post(`/api/students/${id}/applications`, { universityId: 99999 });
    expect(res.status).toBe(400);
  });

  test("PATCH merges checklist ticks instead of replacing the whole map", async () => {
    const id = await newStudent();
    const created = await body(
      await post(`/api/students/${id}/applications`, { universityId: 3 }),
      201
    );

    const first = await body(
      await patch(`/api/students/${id}/applications/${created.id}`, { checklist: { essay: true } })
    );
    expect(first.checklist.essay).toBe(true);

    const second = await body(
      await patch(`/api/students/${id}/applications/${created.id}`, {
        checklist: { transcript: true },
      })
    );
    // The earlier tick must survive a patch that doesn't mention it.
    expect(second.checklist.essay).toBe(true);
    expect(second.checklist.transcript).toBe(true);
  });

  test("supplying a real deadline clears the typical flag", async () => {
    const id = await newStudent();
    const created = await body(
      await post(`/api/students/${id}/applications`, { universityId: 4, plan: "RD" }),
      201
    );
    expect(created.deadlineIsTypical).toBe(true);

    const patched = await body(
      await patch(`/api/students/${id}/applications/${created.id}`, { deadline: "2027-01-05" })
    );
    expect(patched.deadline).toBe("2027-01-05");
    expect(patched.deadlineIsTypical).toBe(false);
  });

  test("GET sorts by deadline and puts undated rolling applications last", async () => {
    const id = await newStudent();
    await post(`/api/students/${id}/applications`, { universityId: 5, plan: "ROLLING" });
    await post(`/api/students/${id}/applications`, { universityId: 6, plan: "RD" });
    await post(`/api/students/${id}/applications`, { universityId: 7, plan: "ED" });

    const list = await body(await get(`/api/students/${id}/applications`));
    const deadlines = list.applications.map((a: { deadline: string | null }) => a.deadline);
    expect(deadlines[0]).toBe(typicalDeadline("ED")); // November
    expect(deadlines[1]).toBe(typicalDeadline("RD")); // January
    expect(deadlines[2]).toBeNull(); // rolling
  });

  test("DELETE stops tracking, and 404s the second time", async () => {
    const id = await newStudent();
    const created = await body(
      await post(`/api/students/${id}/applications`, { universityId: 8 }),
      201
    );

    expect((await del(`/api/students/${id}/applications/${created.id}`)).status).toBe(204);
    expect((await del(`/api/students/${id}/applications/${created.id}`)).status).toBe(404);

    const list = await body(await get(`/api/students/${id}/applications`));
    expect(list.applications).toHaveLength(0);
  });

  test("one student's applications are invisible to another", async () => {
    const a = await newStudent();
    const b = await newStudent();
    await post(`/api/students/${a}/applications`, { universityId: 9 });

    const listB = await body(await get(`/api/students/${b}/applications`));
    expect(listB.applications).toHaveLength(0);
  });

  test("unknown student gets a 404, not an empty list", async () => {
    expect((await get("/api/students/not-a-real-id/applications")).status).toBe(404);
  });
});
