const request = require("supertest");
const app = require("../server");

describe("API endpoints", () => {
  test("GET /api/health reports status and llm mode", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(["claude", "openai", "fallback"]).toContain(res.body.llm);
  });

  test("GET /api/universities returns the dataset and supports filters", async () => {
    const all = await request(app).get("/api/universities");
    expect(all.status).toBe(200);
    expect(all.body.length).toBeGreaterThan(30);

    const west = await request(app).get("/api/universities?region=West");
    expect(west.body.every((u) => u.region === "West")).toBe(true);
  });

  test("POST /api/students validates required fields", async () => {
    const bad = await request(app).post("/api/students").send({ name: "" });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.length).toBeGreaterThan(0);
  });

  test("full flow: create student then fetch recommendations", async () => {
    const create = await request(app)
      .post("/api/students")
      .send({ name: "Ana", gpa: 3.8, satScore: 1450, interestedMajors: ["CS"], financialNeed: "medium" });
    expect(create.status).toBe(201);
    const id = create.body.id;

    const recs = await request(app).get(`/api/students/${id}/recommendations`);
    expect(recs.status).toBe(200);
    expect(recs.body.recommendations).toHaveProperty("reach");
    expect(recs.body.recommendations).toHaveProperty("target");
    expect(recs.body.recommendations).toHaveProperty("safety");
  });

  test("POST /api/chat returns an answer in fallback mode", async () => {
    const res = await request(app).post("/api/chat").send({ question: "How does the FAFSA work?" });
    expect(res.status).toBe(200);
    expect(typeof res.body.answer).toBe("string");
    expect(res.body.answer.length).toBeGreaterThan(0);
  });
});
