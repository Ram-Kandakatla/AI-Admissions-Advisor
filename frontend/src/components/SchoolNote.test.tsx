// The accessibility contract of the star and the notepad.
//
// Both of these came out of Phase 5's hand pass rather than axe: they are
// about what a screen reader *says*, which is a question no automated rule
// answers. Written down as tests because the next person to touch either
// control will not think of them.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SchoolNote, { StarButton } from "./SchoolNote";
import { EMPTY_NOTES } from "../useSchoolNotes";
import type { NotesStore } from "../useSchoolNotes";
import { schoolNote } from "../test/factories";

function store(over: Partial<NotesStore> = {}): NotesStore {
  return {
    ...EMPTY_NOTES,
    toggleStar: vi.fn(),
    setNote: vi.fn(),
    setContact: vi.fn(),
    forget: vi.fn(),
    ...over,
  };
}

describe("the star", () => {
  it("keeps one name and lets aria-pressed carry the state", async () => {
    // The bug this replaces: the label flipped to "Unsave X" at the same
    // moment aria-pressed became true, so the announcement was "Unsave
    // Coastal State, pressed" — a name and a state that contradict.
    const notes = store({ byId: new Map([[1, schoolNote({ universityId: 1, starred: true })]]) });
    render(<StarButton universityId={1} name="Coastal State" notes={notes} />);

    const star = screen.getByRole("button", { name: "Save Coastal State" });
    expect(star).toHaveAttribute("aria-pressed", "true");
  });

  it("has the same name when unstarred", async () => {
    render(<StarButton universityId={1} name="Coastal State" notes={store()} />);
    const star = screen.getByRole("button", { name: "Save Coastal State" });
    expect(star).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(star);
    expect(star).toBeInTheDocument();
  });
});

describe("the notepad's status line", () => {
  it("announces the save starting", () => {
    render(
      <SchoolNote universityId={1} name="Coastal State" notes={store({ saving: true })} alwaysOpen />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");
  });

  it("announces the save finishing, rather than falling silent", () => {
    // "Silence means saved" is legible when you can watch the word vanish and
    // indistinguishable from a failed save when you cannot.
    const { rerender } = render(
      <SchoolNote universityId={1} name="Coastal State" notes={store({ saving: true })} alwaysOpen />
    );
    rerender(
      <SchoolNote universityId={1} name="Coastal State" notes={store({ saving: false })} alwaysOpen />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("says nothing before anything has been saved", () => {
    render(
      <SchoolNote universityId={1} name="Coastal State" notes={store()} alwaysOpen />
    );
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("drops the confirmation as soon as the note changes again", async () => {
    const notes = store({ saving: true });
    const { rerender } = render(
      <SchoolNote universityId={1} name="Coastal State" notes={notes} alwaysOpen />
    );
    const settled = store({ saving: false });
    rerender(<SchoolNote universityId={1} name="Coastal State" notes={settled} alwaysOpen />);
    expect(screen.getByRole("status")).toHaveTextContent("Saved");

    // Named rather than by bare role: the notepad now shares the panel with
    // the two contact fields, so "the textbox" is three elements.
    await userEvent.type(screen.getByLabelText("Your notes on Coastal State"), "x");
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(settled.setNote).toHaveBeenCalled();
  });
});

describe("the hint", () => {
  it("is not in a live region", () => {
    // Deliberate. It retires itself the moment a student stars anything, and
    // announcing the disappearance of instructions nobody asked for would be
    // noise — the star's own pressed state is what confirms the action.
    render(<SchoolNote universityId={1} name="Coastal State" notes={store()} alwaysOpen />);
    const status = screen.getByRole("status");
    expect(status).toHaveClass("note-status");
  });
});

describe("the admissions contact", () => {
  it("labels both fields, so neither is an unnamed box", () => {
    render(<SchoolNote universityId={1} name="Coastal State" notes={store()} alwaysOpen />);
    expect(screen.getByLabelText("Admissions officer")).toBeInTheDocument();
    expect(screen.getByLabelText("Their role")).toBeInTheDocument();
  });

  // Two notes on one page would otherwise share an id, which silently breaks
  // the label association for whichever renders second.
  it("gives each school's fields their own ids", () => {
    render(
      <>
        <SchoolNote universityId={1} name="Coastal State" notes={store()} alwaysOpen />
        <SchoolNote universityId={2} name="Northfield" notes={store()} alwaysOpen />
      </>
    );
    const ids = screen
      .getAllByLabelText("Admissions officer")
      .map((el) => (el as HTMLInputElement).id);
    expect(new Set(ids).size).toBe(2);
  });

  it("shows what has already been recorded", () => {
    const notes = store({
      byId: new Map([
        [1, schoolNote({ universityId: 1, contactName: "Dana Ruiz", contactRole: "Regional counselor" })],
      ]),
    });
    render(<SchoolNote universityId={1} name="Coastal State" notes={notes} alwaysOpen />);
    expect(screen.getByLabelText("Admissions officer")).toHaveValue("Dana Ruiz");
    expect(screen.getByLabelText("Their role")).toHaveValue("Regional counselor");
  });

  it("reports an edit as a contact change, not a note change", async () => {
    const notes = store();
    render(<SchoolNote universityId={1} name="Coastal State" notes={notes} alwaysOpen />);
    await userEvent.type(screen.getByLabelText("Admissions officer"), "D");

    expect(notes.setContact).toHaveBeenCalledWith(1, { contactName: "D" });
    expect(notes.setNote).not.toHaveBeenCalled();
  });

  // A school whose only content is the officer's name would otherwise look
  // untouched until you opened it.
  it("opens the panel for a recorded contact, not just for text", () => {
    const notes = store({
      byId: new Map([[1, schoolNote({ universityId: 1, note: "", contactName: "Dana Ruiz" })]]),
    });
    render(<SchoolNote universityId={1} name="Coastal State" notes={notes} />);
    expect(screen.getByLabelText("Admissions officer")).toBeInTheDocument();
  });

  it("stays shut for a school with nothing on it", () => {
    render(<SchoolNote universityId={1} name="Coastal State" notes={store()} />);
    expect(screen.queryByLabelText("Admissions officer")).toBeNull();
    expect(screen.getByRole("button", { name: "Add a note" })).toBeInTheDocument();
  });
});

describe("when you last spoke to them", () => {
  it("takes a date and reports it as a contact change", async () => {
    const notes = store();
    render(<SchoolNote universityId={1} name="Coastal State" notes={notes} alwaysOpen />);

    const field = screen.getByLabelText("Last spoke");
    expect(field).toHaveAttribute("type", "date");
    await userEvent.type(field, "2026-08-14");
    expect(notes.setContact).toHaveBeenCalledWith(1, { contactLastAt: "2026-08-14" });
  });

  // The line exists to catch a school that has gone quiet. Firing it the day
  // after you emailed someone is how a student learns to ignore it.
  it("says nothing about a recent contact", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15));
    const notes = store({
      byId: new Map([[1, schoolNote({ universityId: 1, contactLastAt: "2026-10-01" })]]),
    });
    render(<SchoolNote universityId={1} name="Coastal State" notes={notes} alwaysOpen />);
    expect(screen.queryByText(/Last contact was/)).toBeNull();
    expect(screen.queryByText(/No contact since/)).toBeNull();
    vi.useRealTimers();
  });

  it("mentions a contact over a month old", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15));
    const notes = store({
      byId: new Map([[1, schoolNote({ universityId: 1, contactLastAt: "2026-09-01" })]]),
    });
    render(<SchoolNote universityId={1} name="Coastal State" notes={notes} alwaysOpen />);
    expect(screen.getByText(/Last contact was September 2026/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("escalates past three months", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15));
    const notes = store({
      byId: new Map([[1, schoolNote({ universityId: 1, contactLastAt: "2026-05-01" })]]),
    });
    render(<SchoolNote universityId={1} name="Coastal State" notes={notes} alwaysOpen />);
    const line = screen.getByText(/No contact since May 2026/);
    expect(line).toHaveAttribute("data-stale", "cold");
    vi.useRealTimers();
  });

  // A date in the future is a typo, not a contact. "-4 days ago" would be
  // worse than silence.
  it("says nothing for a future date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15));
    const notes = store({
      byId: new Map([[1, schoolNote({ universityId: 1, contactLastAt: "2027-01-01" })]]),
    });
    const { container } = render(
      <SchoolNote universityId={1} name="Coastal State" notes={notes} alwaysOpen />
    );
    expect(container.querySelector(".note-stale")).toBeNull();
    vi.useRealTimers();
  });

  it("opens the panel for a date alone", () => {
    const notes = store({
      byId: new Map([
        [1, schoolNote({ universityId: 1, note: "", contactName: "", contactLastAt: "2026-08-14" })],
      ]),
    });
    render(<SchoolNote universityId={1} name="Coastal State" notes={notes} />);
    expect(screen.getByLabelText("Last spoke")).toBeInTheDocument();
  });
});
