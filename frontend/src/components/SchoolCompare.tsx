import { Link } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api";
import { MAX_COMPARE, toggleCompare } from "../compare";
import type { Recommendation, StudentRecord, University } from "../types";
import SchoolNote, { NoteHint, StarButton } from "./SchoolNote";
import { GpaValue, SatValue } from "./GpaValue";
import type { NotesStore } from "../useSchoolNotes";
import { TIER_LABEL, TIER_ORDER } from "../tiers";

// Side-by-side comparison across the whole dataset.
//
// A note on what gets highlighted: there is no single "best" school on a row,
// and pretending otherwise would be the wrong lesson. A low acceptance rate
// isn't a feature, it's a hurdle. So each numeric row names what its standout
// column actually is — "Best odds", "Most selective", "Lowest sticker" —
// rather than stamping a winner. Only tuition has an unambiguous direction,
// and even that is sticker price, not what you'd pay.

const usd = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/**
 * How far a school's avgGPA can be off, by where the number came from. A lead
 * smaller than this is not a lead — it is the estimator's noise.
 *
 * Without this the grid hands "Highest bar" to an interpolated 3.93 over a
 * school's own reported 3.90, adjudicating a 0.03 gap with a number whose error
 * is three times that. The figures are the ones published beside each estimator
 * in scripts/import-scorecard.mjs.
 */
const GPA_UNCERTAINTY: Record<string, number> = {
  curated: 0,
  "estimated-sat": 0.09,
  "estimated-profile": 0.152,
};

const gpaNoise = (u: University) => GPA_UNCERTAINTY[u.gpaSource ?? "curated"] ?? 0;

/** Plain English for Scorecard's admission-test requirement code. */
const TEST_POLICY_LABEL: Record<string, string> = {
  required: "Required",
  recommended: "Recommended",
  optional: "Optional",
  "not-used": "Not considered",
};

const enrolled = new Intl.NumberFormat();

/** Exported for SchoolCompare.test.tsx — standoutIndex takes one. */
export interface Metric {
  key: string;
  label: string;
  cell: (u: University) => ReactNode;
  /** Which column to call out on this row, and what to call it. */
  standout?: {
    of: (u: University) => number;
    pick: "min" | "max";
    label: string;
    /**
     * Noise in `of`'s value for a given school. When the winner's margin over
     * the runner-up is inside it, the row is left unflagged rather than
     * claiming a difference the data cannot support.
     */
    uncertainty?: (u: University) => number;
  };
}

export default function SchoolCompare({
  student,
  selected,
  onChange,
  notes,
}: {
  student: StudentRecord | null;
  selected: number[];
  onChange: (ids: number[]) => void;
  notes: NotesStore;
}) {
  const [all, setAll] = useState<University[] | null>(null);
  const [recs, setRecs] = useState<Map<number, Recommendation>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .universities()
      .then((list) => live && setAll(list))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, []);

  // The student's own read on these schools — tier, match score, fit reasons —
  // is a second layer over the shared stats, so a missing profile (or a failed
  // fetch) just drops those rows rather than breaking the page.
  useEffect(() => {
    if (!student) {
      setRecs(new Map());
      return;
    }
    let live = true;
    api
      // Uncapped: this builds a lookup by school id, and any school the API
      // trimmed would render "Not in your matches" for a school that is in
      // them. Compare shows at most three columns, so nothing renders per row
      // regardless of how many come back.
      .recommendations(student.id, { full: true })
      .then((data) => {
        if (!live) return;
        const map = new Map<number, Recommendation>();
        for (const tier of TIER_ORDER) {
          for (const uni of data.recommendations[tier]) map.set(uni.id, uni);
        }
        setRecs(map);
      })
      .catch(() => live && setRecs(new Map()));
    return () => {
      live = false;
    };
  }, [student]);

  const byId = useMemo(() => new Map((all ?? []).map((u) => [u.id, u])), [all]);

  // Drop ids the dataset doesn't know about rather than rendering empty
  // columns — profiles outlive nothing here, but a stale link might.
  const columns = useMemo(
    () => selected.map((id) => byId.get(id)).filter((u): u is University => !!u),
    [selected, byId]
  );

  const remaining = useMemo(() => {
    const taken = new Set(selected);
    return (all ?? [])
      .filter((u) => !taken.has(u.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [all, selected]);

  const metrics = useMemo<Metric[]>(() => {
    const base: Metric[] = [
      {
        key: "location",
        label: "Location",
        cell: (u) => `${u.city}, ${u.state}`,
      },
      { key: "region", label: "Region", cell: (u) => u.region },
      { key: "setting", label: "Setting", cell: (u) => u.setting ?? "—" },
      { key: "type", label: "Type", cell: (u) => u.type ?? "—" },
      {
        key: "acceptance",
        label: "Acceptance rate",
        cell: (u) => `${u.acceptanceRate}%`,
        standout: { of: (u) => u.acceptanceRate, pick: "max", label: "Best odds" },
      },
      {
        key: "gpa",
        label: "Avg admitted GPA",
        cell: (u) => <GpaValue value={u.avgGPA} source={u.gpaSource} />,
        standout: {
          of: (u) => u.avgGPA,
          pick: "max",
          label: "Highest bar",
          uncertainty: gpaNoise,
        },
      },
      {
        key: "sat",
        label: "Avg admitted SAT",
        cell: (u) => <SatValue value={u.avgSAT} />,
        // A test-blind school has no SAT bar to be highest, so it sorts below
        // every real score rather than winning the row on a coerced zero.
        standout: { of: (u) => u.avgSAT ?? -1, pick: "max", label: "Highest bar" },
      },
      {
        key: "testPolicy",
        label: "Tests required?",
        // The row that makes the one above readable. An SAT average is computed
        // over submitters only, so at a test-optional school it describes the
        // students who chose to send scores, not the class — and it is the same
        // average this school's estimated GPA was derived from.
        cell: (u) => (u.testPolicy ? TEST_POLICY_LABEL[u.testPolicy] : "—"),
      },
      {
        key: "enrollment",
        label: "Undergraduates",
        cell: (u) => (typeof u.enrollment === "number" ? enrolled.format(u.enrollment) : "—"),
      },
      {
        key: "tuition",
        label: "Tuition (sticker)",
        cell: (u) => usd.format(u.tuition),
        standout: { of: (u) => u.tuition, pick: "min", label: "Lowest sticker" },
      },
      {
        key: "majors",
        label: "Majors offered",
        cell: (u) => (
          <div className="cmp-majors">
            {u.majors.map((m) => (
              <span key={m}>{m}</span>
            ))}
          </div>
        ),
      },
    ];

    if (!student) return base;

    return [
      ...base,
      {
        key: "tier",
        label: "Your tier",
        cell: (u) => {
          const rec = recs.get(u.id);
          if (!rec) return <span className="cmp-muted">Not in your matches</span>;
          return <span className={`tier-tag tier-${rec.tier}`}>{TIER_LABEL[rec.tier]}</span>;
        },
      },
      {
        key: "score",
        label: "Match score",
        cell: (u) => {
          const rec = recs.get(u.id);
          return rec ? rec.matchScore : <span className="cmp-muted">—</span>;
        },
        standout: { of: (u) => recs.get(u.id)?.matchScore ?? -1, pick: "max", label: "Strongest fit" },
      },
      {
        key: "gap",
        label: "Your GPA vs. average",
        cell: (u) => {
          const gap = Number((student.gpa - u.avgGPA).toFixed(2));
          if (gap === 0) return "Right on it";
          const cls = gap > 0 ? "cmp-over" : "cmp-under";
          return (
            <span className={cls}>
              {gap > 0 ? "+" : "−"}
              {Math.abs(gap).toFixed(2)} {gap > 0 ? "above" : "below"}
            </span>
          );
        },
        standout: {
          of: (u) => student.gpa - u.avgGPA,
          pick: "max",
          label: "Best GPA standing",
          // Same inferred GPA on the other side of the subtraction.
          uncertainty: gpaNoise,
        },
      },
      {
        key: "majorfit",
        label: "Matches your majors",
        cell: (u) => {
          const rec = recs.get(u.id);
          if (!rec || rec.matchedMajors.length === 0) return <span className="cmp-muted">None</span>;
          return (
            <div className="cmp-majors">
              {rec.matchedMajors.map((m) => (
                <span key={m} className="cmp-hit">
                  {m}
                </span>
              ))}
            </div>
          );
        },
      },
    ];
  }, [student, recs]);

  return (
    <div>
      <div className="view-head">
        <span className="eyebrow">Side by side</span>
        <h1 className="section-title">Weigh two or three schools against each other.</h1>
        <p className="lead">
          Pick from any school in the set — the same numbers, aligned on the same rows, so the
          trade-off between a reach and a safety is a thing you can actually see.
          {student ? " Your own tier and GPA standing come along with them." : ""}
        </p>
        {/* Gated on a profile *and* on there being a column: this hint points
            at a header and a row, and pointing at either before the table
            exists is worse than saying nothing. */}
        <NoteHint notes={student && columns.length >= 2 ? notes : null}>
          The star in a column header saves that school, and the last row of the table is a notepad
          for each one — handy for writing the reason you preferred a school while it&apos;s in
          front of you.
        </NoteHint>
      </div>

      {error && (
        <div className="empty">
          <h2>Couldn&apos;t load the schools</h2>
          <p>{error}</p>
        </div>
      )}

      {!all && !error && <div className="spinner" aria-label="Loading schools" />}

      {all && (
        <>
          <div className="cmp-bar">
            <SchoolPicker
              options={remaining}
              disabled={selected.length >= MAX_COMPARE}
              onPick={(id) => onChange(toggleCompare(selected, id))}
            />
            <div className="cmp-chosen">
              {columns.map((u) => (
                <span className="tag" key={u.id}>
                  {u.shortName || u.name}
                  <button
                    type="button"
                    onClick={() => onChange(toggleCompare(selected, u.id))}
                    aria-label={`Remove ${u.name} from the comparison`}
                  >
                    ×
                  </button>
                </span>
              ))}
              {columns.length === 0 && <span className="cmp-muted">Nothing picked yet</span>}
            </div>
            {columns.length > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={() => onChange([])}>
                Clear
              </button>
            )}
          </div>

          {columns.length < 2 ? (
            <div className="empty">
              <h2>{columns.length === 0 ? "Pick two schools to start" : "Add one more"}</h2>
              <p>
                A comparison needs at least two columns. Search above for any school in the set, or
                tick <b>Compare</b> on a card over in your matches and they&apos;ll be waiting here.
              </p>
              {student && (
                <Link className="btn btn-primary" to="/matches">
                  Go to my matches <span className="btn-arrow">→</span>
                </Link>
              )}
            </div>
          ) : (
            <div className="cmp-wrap">
              <table className="cmp-table" style={{ ["--cols" as string]: columns.length }}>
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="cmp-corner">Comparing</span>
                    </th>
                    {columns.map((u) => (
                      <th scope="col" key={u.id}>
                        <div className="cmp-head">
                          <span className="cmp-name">
                            {student && <StarButton universityId={u.id} name={u.name} notes={notes} />}
                            {u.name}
                          </span>
                          <span className="cmp-sub">
                            {u.city}, {u.state}
                          </span>
                          <button
                            type="button"
                            className="cmp-drop"
                            onClick={() => onChange(toggleCompare(selected, u.id))}
                            aria-label={`Remove ${u.name} from the comparison`}
                          >
                            Remove
                          </button>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((metric) => {
                    const winner = standoutIndex(metric, columns);
                    return (
                      <tr key={metric.key}>
                        <th scope="row">{metric.label}</th>
                        {columns.map((u, i) => (
                          <td key={u.id} data-standout={i === winner || undefined}>
                            <div className="cmp-value">{metric.cell(u)}</div>
                            {i === winner && metric.standout && (
                              <span className="cmp-flag">{metric.standout.label}</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    );
                  })}

                  {/* Your own words, on the same grid as the numbers — the
                      whole point of comparing is deciding, and the reason
                      you liked a school belongs next to its stats. */}
                  {student && (
                    <tr className="cmp-note-row">
                      <th scope="row">Your notes</th>
                      {columns.map((u) => (
                        <td key={u.id}>
                          <SchoolNote
                            universityId={u.id}
                            name={u.name}
                            notes={notes}
                            alwaysOpen
                            placeholder="What you thought…"
                          />
                        </td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          <p className="md-note">
            Averages describe the middle of an admitted class, not a cutoff — plenty of students are
            admitted from either side of them. Tuition is sticker price before any aid, which is
            often a long way from what a family actually pays.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Index of the column to flag on a row, or -1 when there's nothing to say —
 * either the row carries no direction, or every column ties on it, in which
 * case calling one of them out would be noise.
 */
export function standoutIndex(metric: Metric, columns: University[]): number {
  if (!metric.standout || columns.length < 2) return -1;
  const { of, pick, uncertainty } = metric.standout;
  const values = columns.map(of);
  if (values.some((v) => !Number.isFinite(v))) return -1;
  const target = pick === "min" ? Math.min(...values) : Math.max(...values);
  if (values.every((v) => v === target)) return -1;
  const winner = values.indexOf(target);

  // A lead inside the estimator's own error is not a lead. Most of the dataset's
  // GPAs are inferred, so without this the grid would routinely name a winner on
  // a gap smaller than the noise in the numbers it compared.
  if (uncertainty) {
    const rest = values.filter((_, i) => i !== winner);
    const runnerUp = pick === "min" ? Math.min(...rest) : Math.max(...rest);
    const noise = Math.max(...columns.map(uncertainty));
    if (Math.abs(target - runnerUp) <= noise) return -1;
  }
  return winner;
}

/**
 * A search-as-you-type picker over the full dataset. Built by hand rather
 * than with a <datalist>, whose filtering and keyboard behavior differ enough
 * between browsers that it can't be relied on for the page's main control.
 */
function SchoolPicker({
  options,
  disabled,
  onPick,
}: {
  options: University[];
  disabled: boolean;
  onPick: (id: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? options.filter((u) =>
          `${u.name} ${u.shortName} ${u.city} ${u.state}`.toLowerCase().includes(q)
        )
      : options;
    return list.slice(0, 8);
  }, [options, query]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const choose = (uni: University | undefined) => {
    if (!uni) return;
    onPick(uni.id);
    setQuery("");
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (open && matches.length > 0) {
        e.preventDefault();
        choose(matches[active]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="cmp-picker" ref={wrap}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls="cmp-options"
        aria-autocomplete="list"
        aria-label="Add a school to the comparison"
        placeholder={
          disabled ? `Comparing ${MAX_COMPARE} — remove one to swap` : "Add a school by name or city…"
        }
        value={query}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {open && !disabled && (
        <ul className="cmp-options" id="cmp-options" role="listbox">
          {matches.length === 0 ? (
            <li className="cmp-empty">No school matches “{query.trim()}”</li>
          ) : (
            matches.map((u, i) => (
              <li key={u.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-active={i === active || undefined}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(u)}
                >
                  <span className="cmp-opt-name">{u.name}</span>
                  <span className="cmp-opt-sub">
                    {u.city}, {u.state} · {u.acceptanceRate}% admit
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
