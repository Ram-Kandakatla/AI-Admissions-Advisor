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
  return { ...EMPTY_NOTES, toggleStar: vi.fn(), setNote: vi.fn(), forget: vi.fn(), ...over };
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

    await userEvent.type(screen.getByRole("textbox"), "x");
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
