import { Link } from "react-router-dom";
import { useMemo, useState } from "react";
import SchoolNote, { StarButton } from "./SchoolNote";
import { downloadCsv, notesToCsv, savedCsvFilename } from "../exportList";
import type { SchoolNote as SchoolNoteRecord, StudentRecord } from "../types";
import type { NotesStore } from "../useSchoolNotes";

type Filter = "all" | "starred";

const printedOn = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });
const noted = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export default function SavedSchools({
  student,
  notes,
}: {
  student: StudentRecord;
  notes: NotesStore;
}) {
  const [filter, setFilter] = useState<Filter>("all");

  const all = useMemo(() => [...notes.byId.values()], [notes.byId]);
  const rows = useMemo(
    () =>
      all
        .filter((n) => (filter === "starred" ? n.starred : true))
        // Starred first, then most recently touched — the two orders a student
        // actually asks for when they come back to this months later.
        .sort(
          (a, b) =>
            Number(b.starred) - Number(a.starred) ||
            (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? "")
        ),
    [all, filter]
  );

  const starredCount = all.filter((n) => n.starred).length;

  if (notes.loading) return <div className="spinner" aria-label="Loading your saved schools" />;

  return (
    <div>
      <div className="print-only print-head">
        <div className="print-brand">Compass — saved schools</div>
        <div className="print-meta">
          {student.name} · {all.length} school{all.length === 1 ? "" : "s"} · saved{" "}
          {printedOn.format(new Date())}
        </div>
      </div>

      <div className="view-head">
        <span className="eyebrow">Saved by {student.name}</span>
        <h1 className="section-title">
          {all.length === 0
            ? "Nothing saved yet."
            : `${all.length} school${all.length === 1 ? "" : "s"} you've written about.`}
        </h1>
        <p className="lead">
          Star a school anywhere in Compass and it lands here. The note you write is the same one
          everywhere — on a match card, in the explorer, in a comparison, on a tracked application —
          so there&apos;s one place to look when you&apos;re trying to remember why a school made
          the list in March.
        </p>
      </div>

      {notes.error && (
        <div className="form-error" role="alert">
          {notes.error}
        </div>
      )}

      {all.length === 0 ? (
        <div className="empty">
          <h2>Start with the schools you already like</h2>
          <p>
            Tap the ☆ on any school to save it, and write down what you thought while it&apos;s
            fresh — &ldquo;great CS program&rdquo;, &ldquo;too expensive&rdquo;, &ldquo;emailed
            their admissions officer&rdquo;. Future you will not remember otherwise.
          </p>
          <div className="form-footer" style={{ justifyContent: "center" }}>
            <Link className="btn btn-ghost" to="/explore">
              Browse every school
            </Link>
            <Link className="btn btn-primary" to="/matches">
              See my matches <span className="btn-arrow">→</span>
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="export-bar no-print">
            <div className="export-copy">
              <strong>Take your notes with you.</strong> Print them for a counselor meeting, or
              export to a spreadsheet alongside your college list.
            </div>
            <div className="export-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => downloadCsv(savedCsvFilename(student), notesToCsv(rows))}
              >
                Export CSV
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => window.print()}>
                Save as PDF
              </button>
            </div>
          </div>

          <div className="sch-controls no-print">
            <div className="sch-sort" role="group" aria-label="Filter saved schools">
              <button className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
                All {all.length}
              </button>
              <button
                className="chip"
                aria-pressed={filter === "starred"}
                onClick={() => setFilter("starred")}
              >
                <span className="chip-star" aria-hidden="true">
                  ★
                </span>{" "}
                Starred {starredCount}
              </button>
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="empty">
              <h2>No starred schools yet</h2>
              <p>
                You&apos;ve written notes, but haven&apos;t starred anything. Stars are for the
                shortlist — the schools you actually want to come back to.
              </p>
            </div>
          ) : (
            <div className="saved-list">
              {rows.map((row) => (
                <SavedCard key={row.universityId} row={row} notes={notes} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SavedCard({ row, notes }: { row: SchoolNoteRecord; notes: NotesStore }) {
  const uni = row.university;
  const name = uni?.name ?? "Unknown school";
  const when = row.updatedAt ?? row.createdAt;

  return (
    <article className="saved-card" data-starred={row.starred || undefined}>
      <div className="saved-top">
        <div>
          <h2>{name}</h2>
          {uni && (
            <div className="loc">
              {uni.city}, {uni.state} · {uni.acceptanceRate}% admit · $
              {(uni.tuition / 1000).toFixed(0)}k tuition
            </div>
          )}
        </div>
        <div className="saved-actions">
          <StarButton universityId={row.universityId} name={name} notes={notes} />
          <button
            type="button"
            className="btn btn-ghost btn-sm no-print"
            onClick={() => notes.forget(row.universityId)}
            aria-label={`Forget ${name}`}
          >
            Forget
          </button>
        </div>
      </div>

      <SchoolNote universityId={row.universityId} name={name} notes={notes} alwaysOpen />

      {when && <div className="saved-when">Last written {noted.format(new Date(when))}</div>}
    </article>
  );
}
