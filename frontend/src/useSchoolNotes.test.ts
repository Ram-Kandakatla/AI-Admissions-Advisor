import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { EMPTY_NOTES, useSchoolNotes } from "./useSchoolNotes";
import { schoolNote } from "./test/factories";
import type { SchoolNote } from "./types";

vi.mock("./api", () => ({
  api: {
    notes: vi.fn(),
    saveNote: vi.fn(),
    forgetNote: vi.fn(),
  },
}));

const mockApi = vi.mocked(api);

/** What the hook's debounce waits before saving a typed note. */
const SAVE_DELAY = 700;

function notesResponse(notes: SchoolNote[]) {
  return { studentId: "stu_1", notes };
}

beforeEach(() => {
  mockApi.notes.mockResolvedValue(notesResponse([]));
  mockApi.saveNote.mockImplementation(async (_s, universityId, body) =>
    schoolNote({ universityId, starred: false, note: "", ...body })
  );
  mockApi.forgetNote.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("loading", () => {
  it("keys the server's notes by university id", async () => {
    mockApi.notes.mockResolvedValue(
      notesResponse([schoolNote({ universityId: 3 }), schoolNote({ universityId: 8 })])
    );
    const { result } = renderHook(() => useSchoolNotes("stu_1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect([...result.current.byId.keys()]).toEqual([3, 8]);
    expect(result.current.error).toBeNull();
  });

  it("does not call the server without a student", async () => {
    const { result } = renderHook(() => useSchoolNotes(null));
    expect(mockApi.notes).not.toHaveBeenCalled();
    expect(result.current.byId.size).toBe(0);
    expect(result.current.loading).toBe(false);
  });

  it("reloads when the student changes, and empties when they sign out", async () => {
    mockApi.notes.mockResolvedValue(notesResponse([schoolNote({ universityId: 3 })]));
    const { result, rerender } = renderHook(({ id }) => useSchoolNotes(id), {
      initialProps: { id: "stu_1" as string | null },
    });
    await waitFor(() => expect(result.current.byId.size).toBe(1));

    mockApi.notes.mockResolvedValue(notesResponse([schoolNote({ universityId: 9 })]));
    rerender({ id: "stu_2" });
    await waitFor(() => expect([...result.current.byId.keys()]).toEqual([9]));

    rerender({ id: null });
    expect(result.current.byId.size).toBe(0);
  });

  it("ignores a response that arrives after the student has changed", async () => {
    // Five pages share this store, so a fast profile switch can leave the
    // first student's notes in flight. Landing them would show one student's
    // annotations under another's name.
    let resolveFirst!: (v: { studentId: string; notes: SchoolNote[] }) => void;
    mockApi.notes.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      })
    );
    const { result, rerender } = renderHook(({ id }) => useSchoolNotes(id), {
      initialProps: { id: "stu_1" },
    });

    mockApi.notes.mockResolvedValue(notesResponse([schoolNote({ universityId: 9 })]));
    rerender({ id: "stu_2" });
    await waitFor(() => expect([...result.current.byId.keys()]).toEqual([9]));

    await act(async () => {
      resolveFirst(notesResponse([schoolNote({ universityId: 3 })]));
    });
    expect([...result.current.byId.keys()]).toEqual([9]);
  });

  it("surfaces a load failure without clearing what's on screen", async () => {
    mockApi.notes.mockRejectedValue(new Error("Network down"));
    const { result } = renderHook(() => useSchoolNotes("stu_1"));
    await waitFor(() => expect(result.current.error).toBe("Network down"));
    expect(result.current.loading).toBe(false);
  });
});

describe("toggleStar", () => {
  it("stars immediately and saves without waiting", async () => {
    // A star is one click with a visible result, so it deliberately skips the
    // debounce that typed notes need.
    const { result } = renderHook(() => useSchoolNotes("stu_1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.toggleStar(5));
    expect(result.current.byId.get(5)?.starred).toBe(true);
    expect(mockApi.saveNote).toHaveBeenCalledWith("stu_1", 5, { starred: true });
  });

  it("unstars a school that was starred", async () => {
    mockApi.notes.mockResolvedValue(
      notesResponse([schoolNote({ universityId: 5, starred: true })])
    );
    mockApi.saveNote.mockResolvedValue(
      schoolNote({ universityId: 5, starred: false, note: "", removed: true })
    );
    const { result } = renderHook(() => useSchoolNotes("stu_1"));
    await waitFor(() => expect(result.current.byId.get(5)?.starred).toBe(true));

    await act(async () => result.current.toggleStar(5));
    expect(mockApi.saveNote).toHaveBeenCalledWith("stu_1", 5, { starred: false });
  });

  it("drops the record when the write reports it was deleted", async () => {
    // Emptying the note and unstarring leaves nothing to store; the row goes,
    // and the map has to follow or the school stays on the Saved page.
    mockApi.saveNote.mockResolvedValue(schoolNote({ universityId: 5, removed: true }));
    const { result } = renderHook(() => useSchoolNotes("stu_1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => result.current.toggleStar(5));
    expect(result.current.byId.has(5)).toBe(false);
  });

  it("reports saving while a write is in flight", async () => {
    let finish!: (v: SchoolNote) => void;
    mockApi.saveNote.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const { result } = renderHook(() => useSchoolNotes("stu_1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.toggleStar(5));
    await waitFor(() => expect(result.current.saving).toBe(true));

    await act(async () => finish(schoolNote({ universityId: 5, starred: true })));
    expect(result.current.saving).toBe(false);
  });
});

describe("setNote", () => {
  it("shows the typing immediately but waits before saving", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useSchoolNotes("stu_1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setNote(5, "Visited"));
    expect(result.current.byId.get(5)?.note).toBe("Visited");
    expect(mockApi.saveNote).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(SAVE_DELAY);
    });
    expect(mockApi.saveNote).toHaveBeenCalledWith("stu_1", 5, { note: "Visited" });
  });

  it("saves once for a burst of keystrokes, with the final text", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useSchoolNotes("stu_1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    for (const text of ["V", "Vi", "Vis"]) {
      act(() => result.current.setNote(5, text));
      act(() => {
        vi.advanceTimersByTime(200);
      });
    }
    expect(mockApi.saveNote).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(SAVE_DELAY);
    });
    expect(mockApi.saveNote).toHaveBeenCalledOnce();
    expect(mockApi.saveNote).toHaveBeenCalledWith("stu_1", 5, { note: "Vis" });
  });

  it("keeps one timer per school so a second edit can't cancel the first", async () => {
    // The store is shared across pages: editing school A's note and then
    // school B's within the debounce window must save both.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useSchoolNotes("stu_1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setNote(5, "note A"));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => result.current.setNote(9, "note B"));

    await act(async () => {
      vi.advanceTimersByTime(SAVE_DELAY);
    });
    expect(mockApi.saveNote).toHaveBeenCalledTimes(2);
    expect(mockApi.saveNote).toHaveBeenCalledWith("stu_1", 5, { note: "note A" });
    expect(mockApi.saveNote).toHaveBeenCalledWith("stu_1", 9, { note: "note B" });
  });

  it("takes the server's word for it when a write fails", async () => {
    // The optimistic copy is now suspect: the note on screen was never stored.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApi.saveNote.mockRejectedValue(new Error("Save failed"));
    mockApi.notes
      .mockResolvedValueOnce(notesResponse([]))
      .mockResolvedValueOnce(notesResponse([schoolNote({ universityId: 5, note: "server copy" })]));

    const { result } = renderHook(() => useSchoolNotes("stu_1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setNote(5, "typed but not saved"));
    await act(async () => {
      vi.advanceTimersByTime(SAVE_DELAY);
    });

    await waitFor(() => expect(result.current.error).toBe("Save failed"));
    expect(result.current.byId.get(5)?.note).toBe("server copy");
  });
});

describe("forget", () => {
  it("removes the note and tells the server", async () => {
    mockApi.notes.mockResolvedValue(notesResponse([schoolNote({ universityId: 5 })]));
    const { result } = renderHook(() => useSchoolNotes("stu_1"));
    await waitFor(() => expect(result.current.byId.size).toBe(1));

    await act(async () => result.current.forget(5));
    expect(result.current.byId.has(5)).toBe(false);
    expect(mockApi.forgetNote).toHaveBeenCalledWith("stu_1", 5);
  });

  it("cancels a queued save so the note can't come back seconds later", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useSchoolNotes("stu_1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setNote(5, "about to be deleted"));
    await act(async () => result.current.forget(5));

    await act(async () => {
      vi.advanceTimersByTime(SAVE_DELAY * 2);
    });
    expect(mockApi.saveNote).not.toHaveBeenCalled();
    expect(result.current.byId.has(5)).toBe(false);
  });
});

describe("unmounting", () => {
  it("drops a pending save rather than writing into a gone component", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result, unmount } = renderHook(() => useSchoolNotes("stu_1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setNote(5, "half typed"));
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(SAVE_DELAY * 2);
    });
    expect(mockApi.saveNote).not.toHaveBeenCalled();
  });
});

describe("EMPTY_NOTES", () => {
  it("is inert, so a page can render before a student exists", () => {
    expect(EMPTY_NOTES.byId.size).toBe(0);
    expect(EMPTY_NOTES.saving).toBe(false);
    expect(() => {
      EMPTY_NOTES.toggleStar(1);
      EMPTY_NOTES.setNote(1, "x");
      EMPTY_NOTES.forget(1);
    }).not.toThrow();
  });
});

describe("setContact", () => {
  it("debounces like the note and sends only the field that changed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useSchoolNotes("stu_1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setContact(5, { contactName: "Dana Ruiz" }));
    expect(result.current.byId.get(5)?.contactName).toBe("Dana Ruiz");
    expect(mockApi.saveNote).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(SAVE_DELAY);
    });
    expect(mockApi.saveNote).toHaveBeenCalledWith("stu_1", 5, { contactName: "Dana Ruiz" });
  });

  // The bug adding contacts created, and the reason the debounce accumulates a
  // patch instead of carrying one field. Both edits share a school, so they
  // share its timer — a timer holding only the last field's value would cancel
  // the note's save and send the contact alone, leaving the note on screen and
  // not on the server.
  it("does not let a contact edit cancel a pending note save", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useSchoolNotes("stu_1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setNote(5, "Visited in October"));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    act(() => result.current.setContact(5, { contactName: "Dana Ruiz" }));

    await act(async () => {
      vi.advanceTimersByTime(SAVE_DELAY);
    });

    expect(mockApi.saveNote).toHaveBeenCalledOnce();
    expect(mockApi.saveNote).toHaveBeenCalledWith("stu_1", 5, {
      note: "Visited in October",
      contactName: "Dana Ruiz",
    });
  });

  it("merges both contact fields into one write", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useSchoolNotes("stu_1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setContact(5, { contactName: "Dana Ruiz" }));
    act(() => result.current.setContact(5, { contactRole: "Regional counselor" }));

    await act(async () => {
      vi.advanceTimersByTime(SAVE_DELAY);
    });
    expect(mockApi.saveNote).toHaveBeenCalledOnce();
    expect(mockApi.saveNote).toHaveBeenCalledWith("stu_1", 5, {
      contactName: "Dana Ruiz",
      contactRole: "Regional counselor",
    });
  });

  it("drops a forgotten school's queued patch instead of carrying it forward", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useSchoolNotes("stu_1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setContact(5, { contactName: "Dana Ruiz" }));
    act(() => result.current.forget(5));
    act(() => result.current.setNote(5, "Starting over"));

    await act(async () => {
      vi.advanceTimersByTime(SAVE_DELAY);
    });
    expect(mockApi.saveNote).toHaveBeenCalledWith("stu_1", 5, { note: "Starting over" });
  });
});
