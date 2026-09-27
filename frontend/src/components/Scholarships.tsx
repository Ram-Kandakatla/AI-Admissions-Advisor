import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { downloadCsv, scholarshipCsvFilename, scholarshipsToCsv } from "../exportList";
import type { Scholarship, ScholarshipResponse, StudentRecord, Tier } from "../types";
import { TIER_ORDER, tierVar } from "../tiers";

const TIER_META: Record<Tier, { title: string; blurb: string }> = {
  reach: { title: "Reach", blurb: "National names with long odds — worth the essay, not the whole plan." },
  target: { title: "Target", blurb: "Real odds for a profile like yours. Spend most of your time here." },
  safety: { title: "Safety", blurb: "Nothing in your profile argues against you. Start with these." },
};

type SortKey = "match" | "deadline" | "amount";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "match", label: "Best match" },
  { key: "deadline", label: "Closing soonest" },
  { key: "amount", label: "Largest award" },
];

const printedOn = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });

export default function Scholarships({
  student,
}: {
  student: StudentRecord;
}) {
  const [data, setData] = useState<ScholarshipResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("match");
  // Awards gated on something Compass can't see (a demographic, a club
  // membership, a service commitment) are shown by default but easy to hide —
  // a student who knows none of them apply shouldn't have to scroll past them.
  const [hideRestricted, setHideRestricted] = useState(false);

  useEffect(() => {
    setData(null);
    setError(null);
    api
      .scholarships(student.id)
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, [student.id]);

  const view = useMemo(() => {
    if (!data) return null;
    const shape = (list: Scholarship[]) =>
      list
        .filter((s) => !hideRestricted || s.eligibilityToConfirm.length === 0)
        .sort(comparator(sort));
    return {
      reach: shape(data.scholarships.reach),
      target: shape(data.scholarships.target),
      safety: shape(data.scholarships.safety),
    };
  }, [data, sort, hideRestricted]);

  if (error) {
    return (
      <div className="empty">
        <h1>Couldn&apos;t load your scholarships</h1>
        <p>{error}</p>
        <Link className="btn btn-ghost" to="/profile">
          Back to profile
        </Link>
      </div>
    );
  }

  if (!data || !view) return <div className="spinner" aria-label="Loading scholarships" />;

  const shown = view.reach.length + view.target.length + view.safety.length;
  const total = data.counts.reach + data.counts.target + data.counts.safety;
  // Deliberately not a dollar total. Summing the ceilings of 40 awards
  // produces a seven-figure number that means nothing — nobody wins the list —
  // and a headline figure that large would set exactly the wrong expectation.
  const fullCost = [...view.reach, ...view.target, ...view.safety].filter((s) =>
    s.award.term.startsWith("full")
  ).length;

  return (
    <div>
      <div className="print-only print-head">
        <div className="print-brand">Compass — scholarship list</div>
        <div className="print-meta">
          {student.name} · GPA {student.gpa} · {data.cycleYear}–{data.cycleYear + 1} cycle · saved{" "}
          {printedOn.format(new Date())}
        </div>
      </div>

      <div className="view-head">
        <span className="eyebrow">Scholarships for {student.name}</span>
        <h1 className="section-title">
          {total > 0
            ? `${total} awards you're eligible to apply for.`
            : "No awards match this profile yet."}
        </h1>
        <p className="lead">
          Filtered against your GPA, intended majors, and reported financial need — anything with a
          bar you don&apos;t clear has already been removed, so every card here is one you can
          actually enter. Amounts and deadlines come from a curated list; the sponsor&apos;s own page
          is always the authority.
        </p>
        <div className="form-footer no-print" style={{ marginTop: 20 }}>
          <Link className="btn btn-ghost" to="/profile">
            Edit profile
          </Link>
          <Link className="btn btn-primary" to="/chat">
            Ask Compass about these <span className="btn-arrow">→</span>
          </Link>
        </div>
      </div>

      {total === 0 ? (
        <div className="empty">
          <h2>Nothing matched — check your profile</h2>
          <p>
            Most national awards set a GPA floor or restrict themselves to certain majors. Adding
            another intended major, or correcting your financial need if you left it at the default,
            usually opens the list up.
          </p>
          <Link className="btn btn-primary" to="/profile">
            Adjust my profile
          </Link>
        </div>
      ) : (
        <>
          <div className="sch-caveat">
            <strong>Read this before you write anything.</strong> Every deadline below is the month
            the program <em>usually</em> closes, not a date Compass can confirm for this cycle —
            sponsors move them, and a missed deadline costs more than a rushed essay. Open the
            official page on each card and check the date there first. Compass never asks for your
            race, gender, or membership in anything, so where an award is limited to a particular
            group, the card says so and leaves the judgement to you.
          </div>

          <div className="export-bar no-print">
            <div className="export-copy">
              <strong>Keep this list.</strong> Save it as a PDF, or export the deadlines to a
              spreadsheet and work them alongside your college applications.
            </div>
            <div className="export-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() =>
                  downloadCsv(scholarshipCsvFilename(student), scholarshipsToCsv(data))
                }
              >
                Export CSV
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => window.print()}>
                Save as PDF
              </button>
            </div>
          </div>

          <div className="rec-summary">
            {TIER_ORDER.map((t) => (
              <div className={`rec-stat ${t}`} key={t}>
                <div className="num">{data.counts[t]}</div>
                <div className="label">{TIER_META[t].title}</div>
                <div className="desc">{TIER_META[t].blurb}</div>
              </div>
            ))}
          </div>

          <div className="sch-controls no-print">
            <div className="sch-sort" role="group" aria-label="Sort scholarships">
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  className="chip"
                  aria-pressed={sort === s.key}
                  onClick={() => setSort(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <label className="sch-filter-toggle">
              <input
                type="checkbox"
                checked={hideRestricted}
                onChange={(e) => setHideRestricted(e.target.checked)}
              />
              <span>Hide awards limited to a specific group</span>
            </label>
          </div>

          {shown === 0 ? (
            <div className="empty">
              <h2>Everything is hidden</h2>
              <p>
                Every award matching your profile is limited to a particular group. Untick the
                filter to see them and decide for yourself which apply to you.
              </p>
            </div>
          ) : (
            <>
              <p className="sch-total no-print">
                Showing <strong>{shown}</strong> of {total} awards
                {fullCost > 0 && (
                  <>
                    , {fullCost} of which cover full tuition or the full cost of attendance
                  </>
                )}
                . Most students who win anything win two or three small ones — the short
                applications in Safety are where that actually happens.
              </p>

              {(["safety", "target", "reach"] as Tier[]).map((t) =>
                view[t].length > 0 ? (
                  <section className={`tier-block ${t}`} key={t}>
                    <div className="tier-head" style={tierVar(t)}>
                      <span className="tier-dot" />
                      <h2>{TIER_META[t].title}</h2>
                      <span className="count">
                        {view[t].length} · {TIER_META[t].blurb}
                      </span>
                    </div>
                    <div className="uni-grid">
                      {view[t].map((s) => (
                        <ScholarshipCard key={s.id} s={s} />
                      ))}
                    </div>
                  </section>
                ) : null
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Safety first, reach last — the reverse of the college list.
 *
 * On the matches page the reaches are the aspiration you read first. Here the
 * order is a work queue: the awards you're most likely to win are the ones
 * that should get written while you still have time.
 */
function comparator(sort: SortKey): (a: Scholarship, b: Scholarship) => number {
  if (sort === "deadline") {
    return (a, b) => a.deadline.sortKey.localeCompare(b.deadline.sortKey) || b.matchScore - a.matchScore;
  }
  if (sort === "amount") {
    return (a, b) => b.expectedValue - a.expectedValue || b.matchScore - a.matchScore;
  }
  return (a, b) => b.matchScore - a.matchScore || b.expectedValue - a.expectedValue;
}

const EFFORT_LABEL: Record<Scholarship["effort"], string> = {
  short: "Short form",
  essay: "Essay",
  "multi-stage": "Multi-stage",
};

function ScholarshipCard({ s }: { s: Scholarship }) {
  return (
    <article className={`uni-card sch-card ${s.tier}`}>
      <div className="uni-card-top">
        <div>
          <h3>{s.name}</h3>
          <div className="loc">{s.sponsor}</div>
        </div>
        <div className="score-badge">
          <span className="s">{s.matchScore}</span>
          <span className="l">match</span>
        </div>
      </div>

      <div className="sch-amount">
        <span className="sch-money">{s.amountLabel}</span>
        {s.award.renewable && <span className="sch-flag">Renewable</span>}
      </div>

      <p className="sch-summary">{s.summary}</p>

      {(s.matchedMajors.length > 0 || s.tags.length > 0) && (
        <div className="major-tags">
          {s.matchedMajors.map((m) => (
            <span key={m}>{m}</span>
          ))}
          {s.tags.slice(0, 3).map((t) => (
            <span key={t} className="sch-tag">
              {t.replace(/-/g, " ")}
            </span>
          ))}
        </div>
      )}

      <ul className="reasons">
        {s.reasons.slice(0, 3).map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>

      {s.eligibilityToConfirm.length > 0 && (
        <div className="sch-confirm">
          <strong>Check you qualify:</strong> open to {s.eligibilityToConfirm.join(", ")}.
        </div>
      )}

      <div className="sch-deadline">
        <span className="sch-when">
          {s.deadline.label}
          <span className="sch-unconfirmed" title="Compass has not confirmed this cycle's date">
            usually
          </span>
        </span>
        <span className="sch-note">{s.deadline.note}</span>
      </div>

      <div className="uni-stats">
        <span>
          Effort <b>{EFFORT_LABEL[s.effort]}</b>
        </span>
        {s.awardsPerYear != null && s.competitiveness !== "entitlement" && (
          <span>
            Awards/yr <b>{s.awardsPerYear.toLocaleString("en-US")}</b>
          </span>
        )}
        <span>
          GPA floor <b>{s.minGPA ?? "none"}</b>
        </span>
      </div>

      <a className="sch-link no-print" href={s.url} target="_blank" rel="noreferrer noopener">
        Official page &amp; this year&apos;s deadline <span className="btn-arrow">→</span>
      </a>
      {/* On paper a link is unclickable, so the URL has to be readable. */}
      <div className="print-only sch-url">{s.url}</div>
    </article>
  );
}
