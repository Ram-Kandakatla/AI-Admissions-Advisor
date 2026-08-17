const request = require("supertest");
const app = require("../server");
const store = require("../store/dataStore");

async function newStudent() {
  const res = await request(app)
    .post("/api/students")
    .send({ name: "Sam", gpa: 3.7, interestedMajors: ["CS"] });
  return res.body.id;
}

const MIT = 1;

describe("school notes API", () => {
  test("starts empty", async () => {
    const id = await newStudent();
    const res = await request(app).get(`/api/students/${id}/notes`);
    expect(res.status).toBe(200);
    expect(res.body.notes).toEqual([]);
  });

  test("saves a note and joins the school onto it", async () => {
    const id = await newStudent();
    const res = await request(app)
      .put(`/api/students/${id}/notes/${MIT}`)
      .send({ note: "Great CS program, talked to an admissions officer at the fair." });

    expect(res.status).toBe(200);
    expect(res.body.note).toMatch(/Great CS program/);
    expect(res.body.starred).toBe(false);
    expect(res.body.university.shortName).toBe("MIT");
  });

  test("starring keeps the note, and writing a note keeps the star", async () => {
    const id = await newStudent();
    await request(app).put(`/api/students/${id}/notes/${MIT}`).send({ note: "Too expensive" });
    // A star from a match card must not wipe text typed on another page.
    const starred = await request(app).put(`/api/students/${id}/notes/${MIT}`).send({ starred: true });
    expect(starred.body.note).toBe("Too expensive");
    expect(starred.body.starred).toBe(true);

    const edited = await request(app)
      .put(`/api/students/${id}/notes/${MIT}`)
      .send({ note: "Too expensive, but check aid" });
    expect(edited.body.starred).toBe(true);
  });

  test("one note per school, however many times it is written", async () => {
    const id = await newStudent();
    await request(app).put(`/api/students/${id}/notes/${MIT}`).send({ note: "first" });
    await request(app).put(`/api/students/${id}/notes/${MIT}`).send({ note: "second" });
    const res = await request(app).get(`/api/students/${id}/notes`);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0].note).toBe("second");
  });

  test("emptying an unstarred note removes it rather than leaving a blank row", async () => {
    const id = await newStudent();
    await request(app).put(`/api/students/${id}/notes/${MIT}`).send({ note: "never mind" });
    const cleared = await request(app).put(`/api/students/${id}/notes/${MIT}`).send({ note: "" });
    expect(cleared.body.removed).toBe(true);
    const list = await request(app).get(`/api/students/${id}/notes`);
    expect(list.body.notes).toEqual([]);
  });

  test("a starred school with no text is still kept", async () => {
    const id = await newStudent();
    await request(app).put(`/api/students/${id}/notes/${MIT}`).send({ starred: true });
    const list = await request(app).get(`/api/students/${id}/notes`);
    expect(list.body.notes).toHaveLength(1);
    expect(list.body.notes[0].note).toBe("");
  });

  test("starred schools sort ahead of merely annotated ones", async () => {
    const id = await newStudent();
    await request(app).put(`/api/students/${id}/notes/2`).send({ note: "just a thought" });
    await request(app).put(`/api/students/${id}/notes/3`).send({ starred: true });
    const list = await request(app).get(`/api/students/${id}/notes`);
    expect(list.body.notes[0].universityId).toBe(3);
  });

  test("notes are capped, not rejected, at 1000 characters", async () => {
    const id = await newStudent();
    const res = await request(app)
      .put(`/api/students/${id}/notes/${MIT}`)
      .send({ note: "x".repeat(1500) });
    expect(res.body.note).toHaveLength(1000);
  });

  test("rejects a non-string note and an unknown school", async () => {
    const id = await newStudent();
    expect((await request(app).put(`/api/students/${id}/notes/${MIT}`).send({ note: 42 })).status).toBe(400);
    expect((await request(app).put(`/api/students/${id}/notes/9999`).send({ note: "hi" })).status).toBe(404);
  });

  test("404s for an unknown student", async () => {
    expect((await request(app).get("/api/students/nope/notes")).status).toBe(404);
    expect((await request(app).put("/api/students/nope/notes/1").send({ note: "x" })).status).toBe(404);
  });

  test("deleting forgets the school, and deleting nothing is a 404", async () => {
    const id = await newStudent();
    await request(app).put(`/api/students/${id}/notes/${MIT}`).send({ starred: true });
    expect((await request(app).delete(`/api/students/${id}/notes/${MIT}`)).status).toBe(204);
    expect((await request(app).delete(`/api/students/${id}/notes/${MIT}`)).status).toBe(404);
  });

  test("notes are per student", async () => {
    const a = await newStudent();
    const b = await newStudent();
    await request(app).put(`/api/students/${a}/notes/${MIT}`).send({ note: "mine" });
    const theirs = await request(app).get(`/api/students/${b}/notes`);
    expect(theirs.body.notes).toEqual([]);
  });
});

describe("store layer", () => {
  test("saveSchoolNote returns null when it deletes, the record when it writes", () => {
    const student = store.createStudent({ name: "Kit", gpa: 3.4, interestedMajors: ["CS"] });
    expect(store.saveSchoolNote(student.id, MIT, { note: "hi" }).note).toBe("hi");
    expect(store.saveSchoolNote(student.id, MIT, { note: "   " })).toBeNull();
    expect(store.getSchoolNote(student.id, MIT)).toBeNull();
  });
});
