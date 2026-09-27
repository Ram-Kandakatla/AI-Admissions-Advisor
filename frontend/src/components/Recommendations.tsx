import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { MAX_COMPARE } from "../compare";
import { csvFilename, downloadCsv, recommendationsToCsv } from "../exportList";
import SchoolNote, { NoteHint, StarButton } from "./SchoolNote";
import { GpaValue, SatValue } from "./GpaValue";
import type { NotesStore } from "../useSchoolNotes";
import type { Recommendation, RecommendationResponse, StudentRecord, Tier } from "../types";
import { TIER_ORDER, tierVar } from "../tiers";

const TIER_META: Record<Tier, { title: string; blurb: string }> = {
  reach: { title: "Reach", blurb: "Ambitious — apply, but don't count on them." },
  target: { title: "Target", blurb: "Right in your range — the heart of your list." },
  safety: { title: "Safety", blurb: "Very likely admits you'd be happy to attend." },
};

const printedOn = new Intl.DateTimeFormat(undefined, {
  dateStyle: "long",
});

export default function Recommendations({
  student,
  compareIds,
  onToggleCompare,
  notes,
}: {
  student: StudentRecord;
  compareIds: number[];
  onToggleCompare: (id: number) => void;
  notes: NotesStore;
}) {
  const [data, setData] = useState<RecommendationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    setData(null);
    setError(null);
    api
      .recommendations(student.id)
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, [student.id]);

  if (error) {
    return (
      <div className="empty">
        <h1>Couldn&apos;t load your matches</h1>
        <p>{error}</p>
        <Link className="btn btn-ghost" to="/profile">
          Back to profile
        </Link>
      </div>
    );
  }

  if (!data) return <div className="spinner" aria-label="Loading matches" />;

  const total = data.counts.reach + data.counts.target + data.counts.safety;
  // What actually rendered, after the API's per-tier cap. Kept separate from
  // `total` so the headline can stay truthful about how many schools fit while
  // the page is honest about how many it is showing.
  const shownTotal =
    data.recommendations.reach.length +
    data.recommendations.target.length +
    data.recommendations.safety.length;

  return (
    <div>
      {/* Print-only masthead. The app's chrome is hidden on paper, so without
          this a saved PDF would arrive with no name and no date on it. */}
      <div className="print-only print-head">
        <div className="print-brand">Compass — college list</div>
        <div className="print-meta">
          {student.name} · GPA {student.gpa}
          {student.satScore ? ` · SAT ${student.satScore}` : ""}
          {student.actScore ? ` · ACT ${student.actScore}` : ""} · saved{" "}
          {printedOn.format(new Date())}
        </div>
      </div>

      <div className="view-head">
        <span className="eyebrow">Matches for {student.name}</span>
        <h1 className="section-title">
          {total > 0 ? `${total} schools that fit your story.` : "No matches with these filters yet."}
        </h1>
        <p className="lead">
          Sorted by how you stack up on GPA, tests, major fit, region, and budget. Match scores are a
          guide, not a verdict — admissions weigh essays and context too.
          {shownTotal < total && (
            <>
              {" "}
              Showing the <strong>{shownTotal}</strong> strongest — <Link to="/explore">browse
              every school</Link> to see the rest.
            </>
          )}
        </p>
        <NoteHint notes={notes}>
          Tap the star beside a match score to save a school, or <strong>Add a note</strong> to write
          down what you thought. Both follow the school to every other page.
        </NoteHint>
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
          <h2>Let&apos;s widen the net</h2>
          <p>
            No schools in our set matched your intended majors and filters. Try adding another major,
            loosening your preferred regions, or adjusting financial need.
          </p>
          <Link className="btn btn-primary" to="/profile">
            Adjust my profile
          </Link>
        </div>
      ) : (
        <>
          <div className="export-bar no-print">
            <div className="export-copy">
              <strong>Keep this list.</strong> Save it as a PDF to print or email, or pull it into a
              spreadsheet to track alongside your own notes.
            </div>
            <div className="export-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => downloadCsv(csvFilename(student), recommendationsToCsv(data))}
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

          {TIER_ORDER.map((t) =>
            data.recommendations[t].length > 0 ? (
              <section className={`tier-block ${t}`} key={t}>
                <div className="tier-head" style={tierVar(t)}>
                  <span className="tier-dot" />
                  <h2>{TIER_META[t].title} schools</h2>
                  <span className="count">
                    {/* The summary stat above shows the true total, so a tier
                        that was capped has to say so here — otherwise the two
                        numbers contradict each other with no explanation. */}
                    {data.recommendations[t].length < data.counts[t]
                      ? `${data.recommendations[t].length} strongest of ${data.counts[t]}`
                      : data.recommendations[t].length}{" "}
                    · {TIER_META[t].blurb}
                  </span>
                </div>
                <div className="uni-grid">
                  {data.recommendations[t].map((uni) => (
                    <UniCard
                      key={uni.id}
                      uni={uni}
                      comparing={compareIds.includes(uni.id)}
                      compareFull={compareIds.length >= MAX_COMPARE}
                      onToggleCompare={() => onToggleCompare(uni.id)}
                      notes={notes}
                    />
                  ))}
                </div>
              </section>
            ) : null
          )}

          {compareIds.length > 0 && (
            <div className="compare-tray no-print" role="status">
              <span>
                {compareIds.length} school{compareIds.length === 1 ? "" : "s"} picked to compare
                {compareIds.length === 1 ? " — add one more" : ""}
              </span>
              {/* The one nav control on this page that stays a button:
                  it is unavailable until two schools are ticked, and an
                  anchor has no disabled state to express that. */}
              <button
                className="btn btn-primary btn-sm"
                disabled={compareIds.length < 2}
                onClick={() => navigate("/compare")}
              >
                Compare side by side <span className="btn-arrow">→</span>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function UniCard({
  uni,
  comparing,
  compareFull,
  onToggleCompare,
  notes,
}: {
  uni: Recommendation;
  comparing: boolean;
  compareFull: boolean;
  onToggleCompare: () => void;
  notes: NotesStore;
}) {
  // A full tray shouldn't grey out the schools already in it — those are the
  // ones you need to be able to click to make room.
  const locked = compareFull && !comparing;

  return (
    <article className={`uni-card ${uni.tier}`}>
      <div className="uni-card-top">
        <div>
          <h3>{uni.name}</h3>
          <div className="loc">
            {uni.city}, {uni.state} · {uni.region} · {uni.type}
          </div>
        </div>
        <div className="card-aside">
          <StarButton universityId={uni.id} name={uni.name} notes={notes} />
          <div className="score-badge">
            <span className="s">{uni.matchScore}</span>
            <span className="l">match</span>
          </div>
        </div>
      </div>

      <div className="major-tags">
        {uni.matchedMajors.map((m) => (
          <span key={m}>{m}</span>
        ))}
      </div>

      <ul className="reasons">
        {uni.reasons.slice(0, 3).map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>

      <div className="uni-stats">
        <span>
          Avg GPA <b><GpaValue value={uni.avgGPA} source={uni.gpaSource} /></b>
        </span>
        <span>
          Avg SAT <b><SatValue value={uni.avgSAT} /></b>
        </span>
        <span>
          Admit <b>{uni.acceptanceRate}%</b>
        </span>
        <span>
          Tuition <b>${(uni.tuition / 1000).toFixed(0)}k</b>
        </span>
      </div>

      <SchoolNote universityId={uni.id} name={uni.name} notes={notes} />

      <button
        type="button"
        className="cmp-toggle no-print"
        aria-pressed={comparing}
        disabled={locked}
        title={locked ? `You can compare ${MAX_COMPARE} schools at a time` : undefined}
        onClick={onToggleCompare}
      >
        {comparing ? "✓ In comparison" : "Compare"}
      </button>
    </article>
  );
}
