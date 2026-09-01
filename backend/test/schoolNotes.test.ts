import { describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import { body, del, get, newStudent, put } from "./helpers.js";
import { createStore } from "../src/store/dataStore.js";

const MIT = 1;

describe("school notes API", () => {
  test("starts empty", async () => {
    const id = await newStudent();
    const b = await body(await get(`/api/students/${id}/notes`), 200);
    expect(b.notes).toEqual([]);
  });

  test("saves a note and joins the school onto it", async () => {
    const id = await newStudent();
    const b = await body(
      await put(`/api/students/${id}/notes/${MIT}`, {
        note: "Great CS program, talked to an admissions officer at the fair.",
      }),
      200
    );
    expect(b.note).toMatch(/Great CS program/);
    expect(b.starred).toBe(false);
    expect(b.university.shortName).toBe("MIT");
  });

  test("starring keeps the note, and writing a note keeps the star", async () => {
    const id = await newStudent();
    await put(`/api/students/${id}/notes/${MIT}`, { note: "Too expensive" });
    // A star from a match card must not wipe text typed on another page.
    const starred = await body(await put(`/api/students/${id}/notes/${MIT}`, { starred: true }));
    expect(starred.note).toBe("Too expensive");
    expect(starred.starred).toBe(true);

    const edited = await body(
      await put(`/api/students/${id}/notes/${MIT}`, { note: "Too expensive, but check aid" })
    );
    expect(edited.starred).toBe(true);
  });

  test("one note per school, however many times it is written", async () => {
    const id = await newStudent();
    await put(`/api/students/${id}/notes/${MIT}`, { note: "first" });
    await put(`/api/students/${id}/notes/${MIT}`, { note: "second" });
    const b = await body(await get(`/api/students/${id}/notes`));
    expect(b.notes).toHaveLength(1);
    expect(b.notes[0].note).toBe("second");
  });

  test("emptying an unstarred note removes it rather than leaving a blank row", async () => {
    const id = await newStudent();
    await put(`/api/students/${id}/notes/${MIT}`, { note: "never mind" });
    const cleared = await body(await put(`/api/students/${id}/notes/${MIT}`, { note: "" }));
    expect(cleared.removed).toBe(true);
    const list = await body(await get(`/api/students/${id}/notes`));
    expect(list.notes).toEqual([]);
  });

  test("a starred school with no text is still kept", async () => {
    const id = await newStudent();
    await put(`/api/students/${id}/notes/${MIT}`, { starred: true });
    const list = await body(await get(`/api/students/${id}/notes`));
    expect(list.notes).toHaveLength(1);
    expect(list.notes[0].note).toBe("");
  });

  test("starred schools sort ahead of merely annotated ones", async () => {
    const id = await newStudent();
    await put(`/api/students/${id}/notes/2`, { note: "just a thought" });
    await put(`/api/students/${id}/notes/3`, { starred: true });
    const list = await body(await get(`/api/students/${id}/notes`));
    expect(list.notes[0].universityId).toBe(3);
  });

  test("notes are capped, not rejected, at 1000 characters", async () => {
    const id = await newStudent();
    const b = await body(await put(`/api/students/${id}/notes/${MIT}`, { note: "x".repeat(1500) }));
    expect(b.note).toHaveLength(1000);
  });

  test("rejects a non-string note and an unknown school", async () => {
    const id = await newStudent();
    expect((await put(`/api/students/${id}/notes/${MIT}`, { note: 42 })).status).toBe(400);
    expect((await put(`/api/students/${id}/notes/9999`, { note: "hi" })).status).toBe(404);
  });

  test("404s for an unknown student", async () => {
    expect((await get("/api/students/nope/notes")).status).toBe(404);
    expect((await put("/api/students/nope/notes/1", { note: "x" })).status).toBe(404);
  });

  test("deleting forgets the school, and deleting nothing is a 404", async () => {
    const id = await newStudent();
    await put(`/api/students/${id}/notes/${MIT}`, { starred: true });
    expect((await del(`/api/students/${id}/notes/${MIT}`)).status).toBe(204);
    expect((await del(`/api/students/${id}/notes/${MIT}`)).status).toBe(404);
  });

  test("notes are per student", async () => {
    const a = await newStudent();
    const b = await newStudent();
    await put(`/api/students/${a}/notes/${MIT}`, { note: "mine" });
    const theirs = await body(await get(`/api/students/${b}/notes`));
    expect(theirs.notes).toEqual([]);
  });
});

describe("store layer", () => {
  // Now against the real D1 binding rather than an in-memory SQLite file —
  // which is the whole point of running the suite inside workerd.
  test("saveSchoolNote returns null when it deletes, the record when it writes", async () => {
    const store = createStore(env.DB);
    const student = await store.createStudent({
      name: "Kit",
      gpa: 3.4,
      satScore: null,
      actScore: null,
      interestedMajors: ["CS"],
      extracurriculars: [],
      careerGoals: "",
      financialNeed: "medium",
      preferredRegions: [],
    });
    expect((await store.saveSchoolNote(student.id, MIT, { note: "hi" }))!.note).toBe("hi");
    expect(await store.saveSchoolNote(student.id, MIT, { note: "   " })).toBeNull();
    expect(await store.getSchoolNote(student.id, MIT)).toBeNull();
  });
});
