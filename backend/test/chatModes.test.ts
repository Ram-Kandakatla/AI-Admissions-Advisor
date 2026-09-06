// The essay brainstorm assistant (Phase 6.3).
//
// What is actually worth testing here is the *separation*. A second system
// prompt is untestable without a live provider — the suite runs in fallback
// mode, with no API key — but the thing a second prompt is worthless without
// is a second thread, and that is entirely testable: two conversations under
// one student, neither leaking into the other, each trimmed on its own.

import { beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import { body, get, newStudent, post, resetRateLimits } from "./helpers.js";
import { fallbackAnswer } from "../src/services/llmService.js";
import { CHAT_MODES, isChatMode, parseChatMode } from "../src/models/chatMode.js";

beforeEach(resetRateLimits);

describe("parseChatMode", () => {
  // Absent means advising, which is what keeps every client written before
  // 6.3 working untouched.
  test("absent means the default", () => {
    expect(parseChatMode(undefined)).toBe("advising");
    expect(parseChatMode(null)).toBe("advising");
    expect(parseChatMode("")).toBe("advising");
  });

  test("recognises every declared mode", () => {
    for (const mode of CHAT_MODES) expect(parseChatMode(mode)).toBe(mode);
  });

  // Null rather than a fallback: coercing "esay" to advising would file the
  // turn in the wrong thread and give the caller no clue why.
  test("refuses anything else", () => {
    for (const bad of ["esay", "ADVISING", "chat", 1, true, {}]) {
      expect(parseChatMode(bad)).toBeNull();
    }
    expect(isChatMode("essay")).toBe(true);
    expect(isChatMode("nope")).toBe(false);
  });
});

describe("POST /api/chat — mode", () => {
  test("defaults to advising when no mode is given", async () => {
    const b = await body(await post("/api/chat", { question: "How does the FAFSA work?" }), 200);
    expect(b.mode).toBe("advising");
    expect(b.answer).toContain("FAFSA");
  });

  test("answers an essay question out of the essay bank", async () => {
    const b = await body(
      await post("/api/chat", { question: "How do I pick a topic?", mode: "essay" }),
      200
    );
    expect(b.mode).toBe("essay");
    expect(b.source).toBe("fallback");
    // The advising bank's essay entry talks about a "personal statement";
    // the essay bank's topic entry is about the topic itself.
    expect(b.answer.toLowerCase()).toContain("topic");
  });

  test("rejects an unknown mode with 400 and names the valid ones", async () => {
    const res = await post("/api/chat", { question: "Hi", mode: "counselor" });
    const b = await body(res, 400);
    expect(b.error).toContain("advising");
    expect(b.error).toContain("essay");
  });

  // The two banks have to actually differ, or the mode is decoration.
  test("the same question gets a different answer in each mode", async () => {
    const advising = await body(
      await post("/api/chat", { question: "How do I start?" }),
      200
    );
    const essay = await body(
      await post("/api/chat", { question: "How do I start?", mode: "essay" }),
      200
    );
    expect(essay.answer).not.toBe(advising.answer);
  });
});

describe("threads are separate", () => {
  test("an essay turn does not appear in the advising history", async () => {
    const id = await newStudent();

    await post("/api/chat", { studentId: id, question: "How does the FAFSA work?" });
    await post("/api/chat", {
      studentId: id,
      question: "How do I pick a topic?",
      mode: "essay",
    });

    const advising = await body(await get(`/api/students/${id}/chat`), 200);
    const essay = await body(await get(`/api/students/${id}/chat?mode=essay`), 200);

    expect(advising.mode).toBe("advising");
    expect(essay.mode).toBe("essay");

    const advisingText = advising.messages.map((m: any) => m.content).join(" ");
    const essayText = essay.messages.map((m: any) => m.content).join(" ");

    expect(advisingText).toContain("FAFSA");
    expect(advisingText).not.toContain("pick a topic");
    expect(essayText).toContain("pick a topic");
    expect(essayText).not.toContain("FAFSA");
  });

  test("each thread holds its own question and answer", async () => {
    const id = await newStudent();
    await post("/api/chat", { studentId: id, question: "How does the FAFSA work?" });

    const advising = await body(await get(`/api/students/${id}/chat`), 200);
    expect(advising.messages).toHaveLength(2);
    expect(advising.messages[0].role).toBe("user");
    expect(advising.messages[1].role).toBe("assistant");

    const essay = await body(await get(`/api/students/${id}/chat?mode=essay`), 200);
    expect(essay.messages).toHaveLength(0);
  });

  test("GET rejects an unknown mode rather than returning the wrong thread", async () => {
    const id = await newStudent();
    const b = await body(await get(`/api/students/${id}/chat?mode=nonsense`), 400);
    expect(b.error).toContain("essay");
  });

  // The 40-turn cap is per mode. A long essay session evicting the advising
  // thread would be a data-loss bug wearing a performance optimization's
  // clothes.
  test("the history cap is per mode, not per student", async () => {
    const id = await newStudent();
    await post("/api/chat", { studentId: id, question: "How does the FAFSA work?" });

    // Write past the 40-row cap directly; 21 round trips through the route
    // would be slow and would test the LLM path, not the trim.
    const now = new Date().toISOString();
    const rows = [];
    for (let i = 0; i < 45; i++) {
      rows.push(
        env.DB.prepare(
          "INSERT INTO messages (student_id, role, content, at, mode) VALUES (?, ?, ?, ?, 'essay')"
        ).bind(id, i % 2 === 0 ? "user" : "assistant", `essay turn ${i}`, now)
      );
    }
    await env.DB.batch(rows);
    // One more through the store, so the trim runs.
    await post("/api/chat", { studentId: id, question: "How should I end it?", mode: "essay" });

    const essay = await body(await get(`/api/students/${id}/chat?mode=essay`), 200);
    expect(essay.messages.length).toBeLessThanOrEqual(40);

    // The advising thread is untouched by the essay thread's overflow.
    const advising = await body(await get(`/api/students/${id}/chat`), 200);
    expect(advising.messages).toHaveLength(2);
    expect(advising.messages[0].content).toContain("FAFSA");
  });
});

describe("ownership still applies", () => {
  test("an essay thread is as protected as an advising one", async () => {
    await newStudent();
    const res = await get("/api/students/someone-else/chat?mode=essay");
    expect(res.status).toBe(403);
  });

  test("POST /chat refuses an unowned studentId in essay mode", async () => {
    await newStudent();
    const res = await post("/api/chat", {
      studentId: "not-mine",
      question: "How do I pick a topic?",
      mode: "essay",
    });
    expect(res.status).toBe(403);
  });
});

describe("the essay fallback bank", () => {
  // These are the six starter chips in ChatBot.tsx, verbatim. Offering a
  // student a question and then answering it with "I didn't understand that"
  // is the worst thing this bank can do, and it is exactly what happened
  // before this test: "How should I end it?" matched nothing, because the
  // bank's key was "how to end". Keep this list in step with the component.
  const STARTER_CHIPS = [
    "How do I pick a topic?",
    "I'm staring at a blank page.",
    "How do I make this less generic?",
    "My draft is 300 words too long.",
    "How do I write a 'why us' supplement?",
    "How should I end it?",
  ];

  test("answers every starter chip the UI offers", () => {
    for (const question of STARTER_CHIPS) {
      const answer = fallbackAnswer(question, "essay");
      expect(answer, `no bank entry matched the chip "${question}"`).not.toContain("offline mode");
      expect(answer.length).toBeGreaterThan(120);
    }
  });

  test("'end' is not matched inside unrelated words", () => {
    // "recommend", "friend", "attend" and "weekend" all contain "end". A bank
    // keyed on the bare substring would answer a recommendation-letter
    // question with advice about closing paragraphs.
    const answer = fallbackAnswer("who should I ask for a recommendation?", "essay");
    expect(answer).not.toContain("final paragraph");
  });

  // The whole point of the mode. A model asked for essay help will write the
  // essay unless told not to, and the offline path has to hold the same line
  // the system prompt does.
  test("refuses to write the essay", async () => {
    const answer = fallbackAnswer("just write my essay for me", "essay");
    expect(answer.toLowerCase()).toContain("won't write it for you");
  });

  test("an unmatched essay question suggests essay questions, not FAFSA ones", () => {
    const answer = fallbackAnswer("zzzz nothing matches this", "essay");
    expect(answer).toContain("brainstorm and revise");
    expect(answer).not.toContain("FAFSA");
    expect(answer).toContain("offline mode");
  });

  test("advising mode is unchanged", () => {
    expect(fallbackAnswer("How does the FAFSA work?")).toContain("studentaid.gov");
    expect(fallbackAnswer("zzzz nothing matches")).toContain("FAFSA");
  });
});
