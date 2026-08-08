const request = require("supertest");
const app = require("../server");
const {
  currentCycleYear,
  typicalDeadline,
  validateApplication,
} = require("../models/application");

async function newStudent() {
  const res = await request(app)
    .post("/api/students")
    .send({ name: "Sam", gpa: 3.7, interestedMajors: ["CS"] });
  return res.body.id;
}

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

    const given = validateApplication({ universityId: 1, plan: "ED", deadline: "2026-11-15" })
      .application;
    expect(given.deadline).toBe("2026-11-15");
    expect(given.deadlineIsTypical).toBe(false);
  });
});

describe("application endpoints", () => {
  test("GET /api/application-meta exposes plans, statuses and checklist", async () => {
    const res = await request(app).get("/api/application-meta");
    expect(res.status).toBe(200);
    expect(res.body.plans.map((p) => p.key)).toContain("ED");
    expect(res.body.plans.find((p) => p.key === "ED").binding).toBe(true);
    expect(res.body.plans.find((p) => p.key === "RD").binding).toBe(false);
    expect(res.body.statuses).toContain("submitted");
    expect(res.body.checklist.length).toBeGreaterThan(0);
  });

  test("tracking a school seeds the plan's typical deadline", async () => {
    const id = await newStudent();
    const res = await request(app)
      .post(`/api/students/${id}/applications`)
      .send({ universityId: 1, plan: "ED" });

    expect(res.status).toBe(201);
    expect(res.body.university.shortName).toBe("MIT");
    expect(res.body.deadline).toBe(typicalDeadline("ED"));
    expect(res.body.deadlineIsTypical).toBe(true);
    expect(res.body.status).toBe("planning");
  });

  test("the same school cannot be tracked twice", async () => {
    const id = await newStudent();
    await request(app).post(`/api/students/${id}/applications`).send({ universityId: 2 });
    const dup = await request(app).post(`/api/students/${id}/applications`).send({ universityId: 2 });
    expect(dup.status).toBe(409);
  });

  test("rejects a university outside the dataset", async () => {
    const id = await newStudent();
    const res = await request(app)
      .post(`/api/students/${id}/applications`)
      .send({ universityId: 99999 });
    expect(res.status).toBe(400);
  });

  test("PATCH merges checklist ticks instead of replacing the whole map", async () => {
    const id = await newStudent();
    const created = await request(app)
      .post(`/api/students/${id}/applications`)
      .send({ universityId: 3 });

    const first = await request(app)
      .patch(`/api/students/${id}/applications/${created.body.id}`)
      .send({ checklist: { essay: true } });
    expect(first.body.checklist.essay).toBe(true);

    const second = await request(app)
      .patch(`/api/students/${id}/applications/${created.body.id}`)
      .send({ checklist: { transcript: true } });
    // The earlier tick must survive a patch that doesn't mention it.
    expect(second.body.checklist.essay).toBe(true);
    expect(second.body.checklist.transcript).toBe(true);
  });

  test("supplying a real deadline clears the typical flag", async () => {
    const id = await newStudent();
    const created = await request(app)
      .post(`/api/students/${id}/applications`)
      .send({ universityId: 4, plan: "RD" });
    expect(created.body.deadlineIsTypical).toBe(true);

    const patched = await request(app)
      .patch(`/api/students/${id}/applications/${created.body.id}`)
      .send({ deadline: "2027-01-05" });
    expect(patched.body.deadline).toBe("2027-01-05");
    expect(patched.body.deadlineIsTypical).toBe(false);
  });

  test("GET sorts by deadline and puts undated rolling applications last", async () => {
    const id = await newStudent();
    await request(app)
      .post(`/api/students/${id}/applications`)
      .send({ universityId: 5, plan: "ROLLING" });
    await request(app)
      .post(`/api/students/${id}/applications`)
      .send({ universityId: 6, plan: "RD" });
    await request(app)
      .post(`/api/students/${id}/applications`)
      .send({ universityId: 7, plan: "ED" });

    const list = await request(app).get(`/api/students/${id}/applications`);
    const deadlines = list.body.applications.map((a) => a.deadline);
    expect(deadlines[0]).toBe(typicalDeadline("ED")); // November
    expect(deadlines[1]).toBe(typicalDeadline("RD")); // January
    expect(deadlines[2]).toBeNull(); // rolling
  });

  test("DELETE stops tracking, and 404s the second time", async () => {
    const id = await newStudent();
    const created = await request(app)
      .post(`/api/students/${id}/applications`)
      .send({ universityId: 8 });

    const gone = await request(app).delete(`/api/students/${id}/applications/${created.body.id}`);
    expect(gone.status).toBe(204);

    const again = await request(app).delete(`/api/students/${id}/applications/${created.body.id}`);
    expect(again.status).toBe(404);

    const list = await request(app).get(`/api/students/${id}/applications`);
    expect(list.body.applications).toHaveLength(0);
  });

  test("one student's applications are invisible to another", async () => {
    const a = await newStudent();
    const b = await newStudent();
    await request(app).post(`/api/students/${a}/applications`).send({ universityId: 9 });

    const listB = await request(app).get(`/api/students/${b}/applications`);
    expect(listB.body.applications).toHaveLength(0);
  });

  test("unknown student gets a 404, not an empty list", async () => {
    const res = await request(app).get("/api/students/not-a-real-id/applications");
    expect(res.status).toBe(404);
  });
});
