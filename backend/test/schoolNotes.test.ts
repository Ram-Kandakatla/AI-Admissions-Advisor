import { describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import { body, currentCookie, del, get, newStudent, put, useSession } from "./helpers.js";
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

  test("403s for a student the caller does not own", async () => {
    // Sign in as somebody, so this asserts the ownership check rather than
    // the signed-out check the security suite already covers.
    await newStudent();
    expect((await get("/api/students/nope/notes")).status).toBe(403);
    expect((await put("/api/students/nope/notes/1", { note: "x" })).status).toBe(403);
  });

  test("deleting forgets the school, and deleting nothing is a 404", async () => {
    const id = await newStudent();
    await put(`/api/students/${id}/notes/${MIT}`, { starred: true });
    expect((await del(`/api/students/${id}/notes/${MIT}`)).status).toBe(204);
    expect((await del(`/api/students/${id}/notes/${MIT}`)).status).toBe(404);
  });

  test("notes are per student, and one student cannot read another's", async () => {
    // newStudent() resets the jar, so each of these is a separate guest
    // session. Capturing A's cookie is what lets the test act as both.
    const a = await newStudent();
    await put(`/api/students/${a}/notes/${MIT}`, { note: "mine" });
    const aCookie = currentCookie()!;

    const b = await newStudent();
    const theirs = await body(await get(`/api/students/${b}/notes`));
    expect(theirs.notes).toEqual([]);

    // The part that matters since Phase 2: B holding A's id is not enough.
    expect((await get(`/api/students/${a}/notes`)).status).toBe(403);

    // ...and A still sees their own, so the gate rejects the right side.
    useSession(aCookie);
    const mine = await body(await get(`/api/students/${a}/notes`), 200);
    expect(mine.notes).toHaveLength(1);
  });
});

describe("store layer", () => {
  // Now against the real D1 binding rather than an in-memory SQLite file —
  // which is the whole point of running the suite inside workerd.
  test("saveSchoolNote returns null when it deletes, the record when it writes", async () => {
    const store = createStore(env.DB);
    // createStudent now requires an owner — an unowned profile is exactly what
    // Phase 2 removed, so the store has no way to make one.
    const owner = await store.createAnonymousUser();
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
    }, owner.id);
    expect((await store.saveSchoolNote(student.id, MIT, { note: "hi" }))!.note).toBe("hi");
    expect(await store.saveSchoolNote(student.id, MIT, { note: "   " })).toBeNull();
    expect(await store.getSchoolNote(student.id, MIT)).toBeNull();
  });
});

describe("the admissions contact (Phase 6.5)", () => {
  test("records a name and a role alongside the note", async () => {
    const id = await newStudent();
    const b = await body(
      await put(`/api/students/${id}/notes/${MIT}`, {
        contactName: "Dana Ruiz",
        contactRole: "Regional counselor",
      }),
      200
    );
    expect(b.contactName).toBe("Dana Ruiz");
    expect(b.contactRole).toBe("Regional counselor");
    expect(b.university.shortName).toBe("MIT");
  });

  // The whole reason a contact is not just another optional column: the row is
  // deleted when it "holds nothing", and before this the definition of nothing
  // did not know contacts existed. A student who recorded an officer and then
  // unstarred the school would have lost the name with no warning.
  test("a contact alone keeps the row alive, unstarred and with no note", async () => {
    const id = await newStudent();
    await put(`/api/students/${id}/notes/${MIT}`, { starred: true, note: "Visited." });
    await put(`/api/students/${id}/notes/${MIT}`, { contactName: "Dana Ruiz" });

    const b = await body(
      await put(`/api/students/${id}/notes/${MIT}`, { starred: false, note: "" }),
      200
    );
    expect(b.removed).toBeUndefined();
    expect(b.contactName).toBe("Dana Ruiz");

    const list = await body(await get(`/api/students/${id}/notes`), 200);
    expect(list.notes).toHaveLength(1);
    expect(list.notes[0].contactName).toBe("Dana Ruiz");
  });

  test("clearing every field, contact included, does remove the row", async () => {
    const id = await newStudent();
    await put(`/api/students/${id}/notes/${MIT}`, {
      starred: true,
      note: "Visited.",
      contactName: "Dana Ruiz",
      contactRole: "Regional counselor",
    });

    const b = await body(
      await put(`/api/students/${id}/notes/${MIT}`, {
        starred: false,
        note: "",
        contactName: "",
        contactRole: "",
      }),
      200
    );
    expect(b.removed).toBe(true);
    const list = await body(await get(`/api/students/${id}/notes`), 200);
    expect(list.notes).toEqual([]);
  });

  test("a partial write leaves the contact alone", async () => {
    const id = await newStudent();
    await put(`/api/students/${id}/notes/${MIT}`, {
      contactName: "Dana Ruiz",
      contactRole: "Regional counselor",
    });

    const b = await body(await put(`/api/students/${id}/notes/${MIT}`, { starred: true }), 200);
    expect(b.contactName).toBe("Dana Ruiz");
    expect(b.contactRole).toBe("Regional counselor");
    expect(b.starred).toBe(true);
  });

  test("and writing a contact leaves the note and the star alone", async () => {
    const id = await newStudent();
    await put(`/api/students/${id}/notes/${MIT}`, { starred: true, note: "Visited." });

    const b = await body(
      await put(`/api/students/${id}/notes/${MIT}`, { contactRole: "Regional counselor" }),
      200
    );
    expect(b.note).toBe("Visited.");
    expect(b.starred).toBe(true);
  });

  // Whitespace has to normalize to empty, or " " is a contact that every
  // emptiness check treats as present and every reader sees as blank.
  test("a whitespace-only contact is no contact", async () => {
    const id = await newStudent();
    const b = await body(
      await put(`/api/students/${id}/notes/${MIT}`, { starred: false, note: "", contactName: "   " }),
      200
    );
    expect(b.removed).toBe(true);
  });

  test("caps a long name and role instead of rejecting them", async () => {
    const id = await newStudent();
    const b = await body(
      await put(`/api/students/${id}/notes/${MIT}`, {
        contactName: "N".repeat(400),
        contactRole: "R".repeat(400),
      }),
      200
    );
    expect(b.contactName).toHaveLength(120);
    expect(b.contactRole).toHaveLength(120);
  });

  test("rejects a non-string contact field", async () => {
    const id = await newStudent();
    const b = await body(await put(`/api/students/${id}/notes/${MIT}`, { contactName: 42 }), 400);
    expect(b.error).toContain("contactName");
  });

  test("existing notes read back with empty contacts, not missing ones", async () => {
    const id = await newStudent();
    await put(`/api/students/${id}/notes/${MIT}`, { note: "Visited." });
    const list = await body(await get(`/api/students/${id}/notes`), 200);
    expect(list.notes[0].contactName).toBe("");
    expect(list.notes[0].contactRole).toBe("");
  });
});

describe("last contacted (Phase 6.5, second pass)", () => {
  test("records a date alongside the name", async () => {
    const id = await newStudent();
    const b = await body(
      await put(`/api/students/${id}/notes/${MIT}`, {
        contactName: "Dana Ruiz",
        contactLastAt: "2026-08-14",
      }),
      200
    );
    expect(b.contactLastAt).toBe("2026-08-14");
  });

  // Same hazard the name and role had, and the reason 0007's comment spells it
  // out: "holds nothing" has to learn about every new column or the row is
  // deleted out from under it.
  test("a date alone keeps the row alive", async () => {
    const id = await newStudent();
    await put(`/api/students/${id}/notes/${MIT}`, { starred: true, contactLastAt: "2026-08-14" });

    const b = await body(
      await put(`/api/students/${id}/notes/${MIT}`, { starred: false, note: "" }),
      200
    );
    expect(b.removed).toBeUndefined();
    expect(b.contactLastAt).toBe("2026-08-14");
  });

  // Validated, not capped. A truncated name is still a name; a truncated date
  // is a different day.
  test("rejects anything that is not a YYYY-MM-DD date", async () => {
    const id = await newStudent();
    for (const bad of ["14/08/2026", "2026-8-14", "yesterday", "2026-08-14T10:00:00Z", 20260814]) {
      const b = await body(
        await put(`/api/students/${id}/notes/${MIT}`, { contactLastAt: bad }),
        400
      );
      expect(b.error).toContain("contactLastAt");
    }
  });

  test("an empty string clears it", async () => {
    const id = await newStudent();
    await put(`/api/students/${id}/notes/${MIT}`, {
      starred: true,
      contactLastAt: "2026-08-14",
    });
    const b = await body(
      await put(`/api/students/${id}/notes/${MIT}`, { contactLastAt: "" }),
      200
    );
    expect(b.contactLastAt).toBe("");
    expect(b.starred).toBe(true);
  });

  test("a partial write leaves it alone", async () => {
    const id = await newStudent();
    await put(`/api/students/${id}/notes/${MIT}`, { contactLastAt: "2026-08-14" });
    const b = await body(await put(`/api/students/${id}/notes/${MIT}`, { note: "Visited." }), 200);
    expect(b.contactLastAt).toBe("2026-08-14");
  });

  test("older notes read back with an empty date, not a missing one", async () => {
    const id = await newStudent();
    await put(`/api/students/${id}/notes/${MIT}`, { note: "Visited." });
    const list = await body(await get(`/api/students/${id}/notes`), 200);
    expect(list.notes[0].contactLastAt).toBe("");
  });
});
