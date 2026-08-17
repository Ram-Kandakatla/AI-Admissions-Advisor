// One notes store for the whole app.
//
// Matches, Explore, Compare, Tracker and Saved all read and write the same
// note, so the state is loaded once in App and handed down rather than
// fetched per page — otherwise starring a school on one page would leave a
// stale star on the next.
//
// Writes are optimistic. Typing into a note and having the letters arrive a
// beat late is worse than the rare failed save, which is reconciled by
// reloading the server's copy.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { SchoolNote } from "./types";

/** How long to wait after the last keystroke before saving. */
const SAVE_DELAY = 700;

export interface NotesStore {
  /** Every annotated or starred school, keyed by university id. */
  byId: Map<number, SchoolNote>;
  loading: boolean;
  error: string | null;
  /** True while at least one write is in flight — drives the "Saving…" label. */
  saving: boolean;
  toggleStar: (universityId: number) => void;
  setNote: (universityId: number, note: string) => void;
  forget: (universityId: number) => void;
}

const EMPTY: NotesStore = {
  byId: new Map(),
  loading: false,
  error: null,
  saving: false,
  toggleStar: () => {},
  setNote: () => {},
  forget: () => {},
};

export function useSchoolNotes(studentId: string | null): NotesStore {
  const [byId, setById] = useState<Map<number, SchoolNote>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(0);

  // One timer per school: editing two notes in quick succession must not have
  // the second cancel the first one's save.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (!studentId) {
      setById(new Map());
      return;
    }
    let live = true;
    setLoading(true);
    api
      .notes(studentId)
      .then((res) => {
        if (!live) return;
        setById(new Map(res.notes.map((n) => [n.universityId, n])));
        setError(null);
      })
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [studentId]);

  // Pending saves are flushed by the timers themselves; on unmount there is
  // nowhere to put the result, so they are simply dropped.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((t) => clearTimeout(t));
      pending.clear();
    };
  }, []);

  const write = useCallback(
    async (universityId: number, body: { starred?: boolean; note?: string }) => {
      if (!studentId) return;
      setInFlight((n) => n + 1);
      try {
        const saved = await api.saveNote(studentId, universityId, body);
        setById((prev) => {
          const next = new Map(prev);
          if (saved.removed) next.delete(universityId);
          else next.set(universityId, saved);
          return next;
        });
        setError(null);
      } catch (e) {
        setError((e as Error).message);
        // The optimistic copy is now suspect — take the server's word for it.
        const fresh = await api.notes(studentId).catch(() => null);
        if (fresh) setById(new Map(fresh.notes.map((n) => [n.universityId, n])));
      } finally {
        setInFlight((n) => n - 1);
      }
    },
    [studentId]
  );

  const optimistic = useCallback((universityId: number, patch: Partial<SchoolNote>) => {
    setById((prev) => {
      const next = new Map(prev);
      const current = next.get(universityId);
      next.set(universityId, {
        universityId,
        starred: false,
        note: "",
        university: null,
        ...current,
        ...patch,
      });
      return next;
    });
  }, []);

  const toggleStar = useCallback(
    (universityId: number) => {
      const starred = !byId.get(universityId)?.starred;
      optimistic(universityId, { starred });
      // Stars are a single click with a visible result, so they skip the
      // debounce that text edits need.
      void write(universityId, { starred });
    },
    [byId, optimistic, write]
  );

  const setNote = useCallback(
    (universityId: number, note: string) => {
      optimistic(universityId, { note });
      const existing = timers.current.get(universityId);
      if (existing) clearTimeout(existing);
      timers.current.set(
        universityId,
        setTimeout(() => {
          timers.current.delete(universityId);
          void write(universityId, { note });
        }, SAVE_DELAY)
      );
    },
    [optimistic, write]
  );

  const forget = useCallback(
    (universityId: number) => {
      const pending = timers.current.get(universityId);
      if (pending) {
        // A queued save would otherwise resurrect the note seconds later.
        clearTimeout(pending);
        timers.current.delete(universityId);
      }
      setById((prev) => {
        const next = new Map(prev);
        next.delete(universityId);
        return next;
      });
      if (studentId) void api.forgetNote(studentId, universityId).catch(() => undefined);
    },
    [studentId]
  );

  return { byId, loading, error, saving: inFlight > 0, toggleStar, setNote, forget };
}

export { EMPTY as EMPTY_NOTES };
