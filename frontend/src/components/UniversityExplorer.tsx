import { Fragment, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Meta, University } from "../types";
import SchoolNote, { NoteHint, StarButton } from "./SchoolNote";
import type { NotesStore } from "../useSchoolNotes";

export default function UniversityExplorer({
  meta,
  // Null until there's a profile to hang notes off. The table still browses
  // fine without them; it just doesn't offer a star it couldn't save.
  notes,
}: {
  meta: Meta | null;
  notes: NotesStore | null;
}) {
  const [all, setAll] = useState<University[] | null>(null);
  const [search, setSearch] = useState("");
  const [region, setRegion] = useState("");
  const [major, setMajor] = useState("");
  const [sort, setSort] = useState<"name" | "acceptance" | "tuition">("name");
  /** Which school's note is open for editing — one at a time. */
  const [editing, setEditing] = useState<number | null>(null);

  useEffect(() => {
    api.universities().then(setAll).catch(() => setAll([]));
  }, []);

  const rows = useMemo(() => {
    if (!all) return [];
    const q = search.trim().toLowerCase();
    let list = all.filter((u) => {
      if (region && u.region !== region) return false;
      if (major && !u.majors.includes(major)) return false;
      if (q && !`${u.name} ${u.shortName} ${u.city} ${u.state}`.toLowerCase().includes(q)) return false;
      return true;
    });
    list = [...list].sort((a, b) => {
      if (sort === "acceptance") return a.acceptanceRate - b.acceptanceRate;
      if (sort === "tuition") return a.tuition - b.tuition;
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [all, search, region, major, sort]);

  return (
    <div>
      <div className="view-head">
        <span className="eyebrow">The database</span>
        <h2 className="section-title">Browse every school in the set.</h2>
        <p className="lead">
          {all ? `${all.length} universities` : "Loading"} with the numbers that actually matter —
          selectivity, typical stats, and sticker price. Filter and sort to explore.
        </p>
        <NoteHint notes={notes}>
          The star column saves a school to your list; <strong>Note</strong> at the end of a row
          opens a notepad for it that follows the school everywhere in Compass.
        </NoteHint>
      </div>

      <div className="explorer-controls">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or city…"
          aria-label="Search universities"
        />
        <select value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Filter by region">
          <option value="">All regions</option>
          {(meta?.regions ?? []).map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select value={major} onChange={(e) => setMajor(e.target.value)} aria-label="Filter by major">
          <option value="">All majors</option>
          {(meta?.majors ?? []).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort by">
          <option value="name">Sort: A–Z</option>
          <option value="acceptance">Sort: Most selective</option>
          <option value="tuition">Sort: Lowest tuition</option>
        </select>
        <span className="explorer-count">{rows.length} shown</span>
      </div>

      {!all ? (
        <div className="spinner" aria-label="Loading universities" />
      ) : rows.length === 0 ? (
        <div className="empty">
          <h3>Nothing matches those filters</h3>
          <p>Try clearing the search box or picking a different region or major.</p>
        </div>
      ) : (
        <div className="uni-table-wrap">
          <table className="uni-table">
            <thead>
              <tr>
                {notes && <th className="uni-th-star" aria-label="Saved" />}
                <th>University</th>
                <th>Location</th>
                <th>Avg GPA</th>
                <th>Avg SAT</th>
                <th>Admit rate</th>
                <th>Tuition</th>
                <th>Majors</th>
                {notes && <th className="uni-th-note" aria-label="Your note" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const note = notes?.byId.get(u.id);
                // A textarea inside a dense table row would wreck the column
                // widths, so the editor gets a row of its own, opened per
                // school and closed again when you're done.
                const open = editing === u.id;
                return (
                  <Fragment key={u.id}>
                    <tr data-noted={note ? true : undefined}>
                      {notes && (
                        <td className="uni-td-star">
                          <StarButton universityId={u.id} name={u.name} notes={notes} />
                        </td>
                      )}
                      <td>
                        <span className="name">{u.name}</span>
                        {note?.note && !open && (
                          <span className="uni-note">{note.note}</span>
                        )}
                      </td>
                      <td>
                        {u.city}, {u.state}
                      </td>
                      <td>{u.avgGPA}</td>
                      <td>{u.avgSAT}</td>
                      <td>{u.acceptanceRate}%</td>
                      <td>${(u.tuition / 1000).toFixed(0)}k</td>
                      <td>{u.majors.slice(0, 3).join(", ")}{u.majors.length > 3 ? "…" : ""}</td>
                      {notes && (
                        <td className="uni-td-note">
                          <button
                            type="button"
                            className="note-toggle"
                            aria-expanded={open}
                            onClick={() => setEditing(open ? null : u.id)}
                          >
                            {open ? "Close" : note?.note ? "Note ✓" : "Note"}
                          </button>
                        </td>
                      )}
                    </tr>
                    {notes && open && (
                      <tr className="uni-note-row">
                        <td colSpan={9}>
                          <SchoolNote universityId={u.id} name={u.name} notes={notes} alwaysOpen />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
