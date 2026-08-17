// The star and the notepad, as they appear on every card in the app.
//
// Deliberately one component rather than a variant per page: the note on a
// match card, an explorer row, a comparison column and a tracked application
// are the same note, and looking different in each place would suggest
// otherwise. The only thing that varies is whether the textarea starts open.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { NotesStore } from "../useSchoolNotes";

/**
 * A one-line "here's where the notepad is" line for the top of a page.
 *
 * The star and the note toggle are small controls that nobody goes looking
 * for, and each page puts them somewhere slightly different — a column here, a
 * row at the foot of a table there — so the wording is per page.
 *
 * It retires itself as soon as the student has starred or written anything.
 * A hint that outlives the moment it was useful is just a banner, and this one
 * sits above the content the student actually came for.
 */
export function NoteHint({
  notes,
  children,
}: {
  notes: NotesStore | null;
  children: ReactNode;
}) {
  // Nothing to teach before there's a profile to hang a note off, and nothing
  // to say while the first fetch is still deciding whether there are any.
  if (!notes || notes.loading || notes.byId.size > 0) return null;
  return (
    <p className="note-hint no-print">
      <span className="note-hint-mark" aria-hidden="true">
        ☆
      </span>
      <span>{children}</span>
    </p>
  );
}

export function StarButton({
  universityId,
  name,
  notes,
}: {
  universityId: number;
  name: string;
  notes: NotesStore;
}) {
  const starred = notes.byId.get(universityId)?.starred ?? false;
  return (
    <button
      type="button"
      className="note-star"
      aria-pressed={starred}
      aria-label={starred ? `Unsave ${name}` : `Save ${name}`}
      title={starred ? "Saved — click to unsave" : "Save this school"}
      onClick={() => notes.toggleStar(universityId)}
    >
      <span aria-hidden="true">{starred ? "★" : "☆"}</span>
    </button>
  );
}

export default function SchoolNote({
  universityId,
  name,
  notes,
  /** Open the textarea straight away — used where the note is the point. */
  alwaysOpen = false,
  placeholder = "Great CS program · too expensive · emailed admissions on the 12th…",
}: {
  universityId: number;
  name: string;
  notes: NotesStore;
  alwaysOpen?: boolean;
  placeholder?: string;
}) {
  const record = notes.byId.get(universityId);
  const saved = record?.note ?? "";
  const [open, setOpen] = useState(alwaysOpen || saved !== "");
  const box = useRef<HTMLTextAreaElement>(null);

  // Opening the notepad should land the cursor in it. Only on a deliberate
  // open, never on first render, or the page would scroll itself on load.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) box.current?.focus();
    wasOpen.current = open;
  }, [open]);

  return (
    <div className="note-block">
      {!alwaysOpen && (
        <button
          type="button"
          className="note-toggle no-print"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Hide note" : saved ? "Note ✓" : "Add a note"}
        </button>
      )}

      {open && (
        <>
          <textarea
            ref={box}
            className="note-box"
            value={saved}
            maxLength={1000}
            placeholder={placeholder}
            aria-label={`Your notes on ${name}`}
            onChange={(e) => notes.setNote(universityId, e.target.value)}
          />
          {/* Saving is automatic, so the only thing worth saying is when it
              has not happened yet. Silence means saved. */}
          <span className="note-status no-print" role="status">
            {notes.saving ? "Saving…" : ""}
          </span>
        </>
      )}

      {/* On paper the note matters more than the control that edits it. */}
      {saved && <p className="print-only note-print">{saved}</p>}
    </div>
  );
}
