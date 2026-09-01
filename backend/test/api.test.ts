import { describe, expect, test } from "vitest";
import { body, get, post } from "./helpers.js";

describe("API endpoints", () => {
  test("GET /api/health reports status, llm mode and D1 reachability", async () => {
    const res = await get("/api/health");
    const b = await body(res, 200);
    expect(b.status).toBe("ok");
    expect(["claude", "openai", "fallback"]).toContain(b.llm);
    // New in the D1 port: uptime monitoring needs to tell "the Worker is up"
    // apart from "the Worker is up but the database isn't".
    expect(b.database).toBe("ok");
  });

  test("GET /api/universities returns the dataset and supports filters", async () => {
    const all = await body(await get("/api/universities"), 200);
    expect(all.length).toBeGreaterThan(30);

    const west = await body(await get("/api/universities?region=West"), 200);
    expect(west.every((u: { region: string }) => u.region === "West")).toBe(true);
  });

  test("POST /api/students validates required fields", async () => {
    const bad = await body(await post("/api/students", { name: "" }), 400);
    expect(bad.errors.length).toBeGreaterThan(0);
  });

  test("full flow: create student then fetch recommendations", async () => {
    const create = await body(
      await post("/api/students", {
        name: "Ana",
        gpa: 3.8,
        satScore: 1450,
        interestedMajors: ["CS"],
        financialNeed: "medium",
      }),
      201
    );

    const recs = await body(await get(`/api/students/${create.id}/recommendations`), 200);
    expect(recs.recommendations).toHaveProperty("reach");
    expect(recs.recommendations).toHaveProperty("target");
    expect(recs.recommendations).toHaveProperty("safety");
  });

  test("POST /api/chat returns an answer in fallback mode", async () => {
    const b = await body(await post("/api/chat", { question: "How does the FAFSA work?" }), 200);
    expect(typeof b.answer).toBe("string");
    expect(b.answer.length).toBeGreaterThan(0);
  });

  test("a profile survives the request that created it", async () => {
    // The point of D1 rather than isolate memory: a Worker keeps nothing
    // between requests, so this passing is what proves state is really stored.
    const created = await body(
      await post("/api/students", { name: "Rae", gpa: 3.5, interestedMajors: ["Math"] }),
      201
    );
    const fetched = await body(await get(`/api/students/${created.id}`), 200);
    expect(fetched.name).toBe("Rae");
    expect(fetched.interestedMajors).toEqual(["Math"]);
  });

  test("PUT /api/students/:id merges rather than replacing", async () => {
    const created = await body(
      await post("/api/students", {
        name: "Jo",
        gpa: 3.6,
        satScore: 1400,
        interestedMajors: ["CS"],
      }),
      201
    );
    const { put } = await import("./helpers.js");
    const updated = await body(
      await put(`/api/students/${created.id}`, {
        name: "Jo",
        gpa: 3.9,
        interestedMajors: ["CS"],
      }),
      200
    );
    expect(updated.gpa).toBe(3.9);
    expect(updated.updatedAt).toBeDefined();
  });

  test("unknown student ids 404 across every student route", async () => {
    for (const path of [
      "/api/students/nope",
      "/api/students/nope/recommendations",
      "/api/students/nope/scholarships",
      "/api/students/nope/chat",
    ]) {
      expect((await get(path)).status, path).toBe(404);
    }
  });
});
