// The star and the notepad, as they appear on every card in the app.
//
// Deliberately one component rather than a variant per page: the note on a
// match card, an explorer row, a comparison column and a tracked application
// are the same note, and looking different in each place would suggest
// otherwise. The only thing that varies is whether the textarea starts open.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { daysUntil, monthYear, parseLocalDate } from "../dates";
import type { NotesStore } from "../useSchoolNotes";

/** Today as YYYY-MM-DD, for capping the date input. Local, never UTC. */
function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * How long since the last contact, if it is long enough to mention.
 *
 * Null under 30 days on purpose. This line exists to catch a school that has
 * gone quiet, not to comment on every contact a student records — and a
 * reminder that appears the day after you email someone is a reminder people
 * learn to ignore.
 */
function stalenessOf(iso: string): { level: "warm" | "cold"; text: string } | null {
  if (!iso) return null;
  const days = -daysUntil(iso);
  // A future date is a typo, not a contact. Say nothing rather than "-4 days".
  if (days < 30) return null;
  const since = monthYear.format(parseLocalDate(iso));
  return days >= 90
    ? { level: "cold", text: `No contact since ${since} — over three months.` }
    : { level: "warm", text: `Last contact was ${since}.` };
}

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
      aria-label={`Save ${name}`}
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
  const contactName = record?.contactName ?? "";
  const contactRole = record?.contactRole ?? "";
  const contactLastAt = record?.contactLastAt ?? "";
  const staleness = stalenessOf(contactLastAt);
  // Opens for a recorded contact as well as for text — otherwise a school
  // whose only content is the officer's name looks blank until you click.
  const [open, setOpen] = useState(alwaysOpen || saved !== "" || contactName !== "" || contactLastAt !== "");
  const box = useRef<HTMLTextAreaElement>(null);

  // Whether a save has completed since this note was opened.
  //
  // The status line below is a live region, so it is the only thing telling a
  // screen reader user what happened to what they just typed. It used to
  // announce "Saving…" and then fall silent, on the reasoning that silence
  // means saved — which works when you can see the word disappear, and is
  // indistinguishable from a failed save when you cannot. Now the end of a
  // save is announced too.
  const [justSaved, setJustSaved] = useState(false);
  const wasSaving = useRef(notes.saving);
  useEffect(() => {
    if (wasSaving.current && !notes.saving) setJustSaved(true);
    wasSaving.current = notes.saving;
  }, [notes.saving]);

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
          {open ? "Hide note" : saved || contactName || contactLastAt ? "Note ✓" : "Add a note"}
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
            onChange={(e) => {
              // A new keystroke starts a new save cycle, so the previous
              // "Saved" stops being true before it stops being displayed.
              setJustSaved(false);
              notes.setNote(universityId, e.target.value);
            }}
          />
          {/* Who is reading this application.

              Under the note rather than above it: the note is what students
              open this for, and most schools never get a name recorded at all.
              Two plain fields, no heading — a section header over two inputs
              would weigh more than what it introduces. */}
          <div className="note-contact">
            <div className="field">
              <label htmlFor={`contact-name-${universityId}`}>Admissions officer</label>
              <input
                id={`contact-name-${universityId}`}
                type="text"
                value={contactName}
                maxLength={120}
                placeholder="Name, if you know it"
                autoComplete="off"
                onChange={(e) => {
                  setJustSaved(false);
                  notes.setContact(universityId, { contactName: e.target.value });
                }}
              />
            </div>
            <div className="field">
              <label htmlFor={`contact-role-${universityId}`}>Their role</label>
              <input
                id={`contact-role-${universityId}`}
                type="text"
                value={contactRole}
                maxLength={120}
                placeholder="e.g. regional counselor"
                autoComplete="off"
                onChange={(e) => {
                  setJustSaved(false);
                  notes.setContact(universityId, { contactRole: e.target.value });
                }}
              />
            </div>
            <div className="field">
              <label htmlFor={`contact-last-${universityId}`}>Last spoke</label>
              {/* A native date input: it gets the platform's own picker and
                  keyboard, and it hands back YYYY-MM-DD, which is exactly the
                  shape the column stores and dates.ts parses. */}
              <input
                id={`contact-last-${universityId}`}
                type="date"
                value={contactLastAt}
                max={todayIso()}
                onChange={(e) => {
                  setJustSaved(false);
                  notes.setContact(universityId, { contactLastAt: e.target.value });
                }}
              />
            </div>
          </div>

          {/* The whole reason the date is worth storing: not when you spoke,
              but how long ago. Silent under a month — a school you contacted
              three weeks ago is not neglected, and a nag on every card would
              teach students to stop reading these. */}
          {staleness && (
            <p className="note-stale" data-stale={staleness.level}>
              {staleness.text}
            </p>
          )}

          {/* Saving is automatic and has no button, so this line is the
              whole of the feedback. */}
          <span className="note-status no-print" role="status">
            {notes.saving ? "Saving…" : justSaved ? "Saved" : ""}
          </span>
        </>
      )}

      {/* On paper the note matters more than the control that edits it. */}
      {saved && <p className="print-only note-print">{saved}</p>}
      {contactName && (
        <p className="print-only note-print">
          Contact: {contactName}
          {contactRole ? ` — ${contactRole}` : ""}
          {contactLastAt ? ` · last spoke ${contactLastAt}` : ""}
        </p>
      )}
    </div>
  );
}
