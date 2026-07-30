import { useEffect, useState } from "react";
import { api } from "../api";
import type { Recommendation, RecommendationResponse, StudentRecord, Tier } from "../types";

const TIER_META: Record<Tier, { title: string; blurb: string }> = {
  reach: { title: "Reach", blurb: "Ambitious — apply, but don't count on them." },
  target: { title: "Target", blurb: "Right in your range — the heart of your list." },
  safety: { title: "Safety", blurb: "Very likely admits you'd be happy to attend." },
};

export default function Recommendations({
  student,
  onEdit,
  onAsk,
}: {
  student: StudentRecord;
  onEdit: () => void;
  onAsk: () => void;
}) {
  const [data, setData] = useState<RecommendationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        <h3>Couldn&apos;t load your matches</h3>
        <p>{error}</p>
        <button className="btn btn-ghost" onClick={onEdit}>
          Back to profile
        </button>
      </div>
    );
  }

  if (!data) return <div className="spinner" aria-label="Loading matches" />;

  const total = data.counts.reach + data.counts.target + data.counts.safety;

  return (
    <div>
      <div className="view-head">
        <span className="eyebrow">Matches for {student.name}</span>
        <h2 className="section-title">
          {total > 0 ? `${total} schools that fit your story.` : "No matches with these filters yet."}
        </h2>
        <p className="lead">
          Sorted by how you stack up on GPA, tests, major fit, region, and budget. Match scores are a
          guide, not a verdict — admissions weigh essays and context too.
        </p>
        <div className="form-footer" style={{ marginTop: 20 }}>
          <button className="btn btn-ghost" onClick={onEdit}>
            Edit profile
          </button>
          <button className="btn btn-primary" onClick={onAsk}>
            Ask Compass about these <span className="btn-arrow">→</span>
          </button>
        </div>
      </div>

      {total === 0 ? (
        <div className="empty">
          <h3>Let&apos;s widen the net</h3>
          <p>
            No schools in our set matched your intended majors and filters. Try adding another major,
            loosening your preferred regions, or adjusting financial need.
          </p>
          <button className="btn btn-primary" onClick={onEdit}>
            Adjust my profile
          </button>
        </div>
      ) : (
        <>
          <div className="rec-summary">
            {(["reach", "target", "safety"] as Tier[]).map((t) => (
              <div className={`rec-stat ${t}`} key={t}>
                <div className="num">{data.counts[t]}</div>
                <div className="label">{TIER_META[t].title}</div>
                <div className="desc">{TIER_META[t].blurb}</div>
              </div>
            ))}
          </div>

          {(["reach", "target", "safety"] as Tier[]).map((t) =>
            data.recommendations[t].length > 0 ? (
              <section className={`tier-block ${t}`} key={t}>
                <div className="tier-head" style={tierVar(t)}>
                  <span className="tier-dot" />
                  <h3>{TIER_META[t].title} schools</h3>
                  <span className="count">
                    {data.recommendations[t].length} · {TIER_META[t].blurb}
                  </span>
                </div>
                <div className="uni-grid">
                  {data.recommendations[t].map((uni) => (
                    <UniCard key={uni.id} uni={uni} />
                  ))}
                </div>
              </section>
            ) : null
          )}
        </>
      )}
    </div>
  );
}

function tierVar(t: Tier): React.CSSProperties {
  const map: Record<Tier, string> = {
    reach: "var(--clay)",
    target: "var(--forest)",
    safety: "var(--ochre)",
  };
  return { ["--tier" as string]: map[t] } as React.CSSProperties;
}

function UniCard({ uni }: { uni: Recommendation }) {
  return (
    <article className={`uni-card ${uni.tier}`}>
      <div className="uni-card-top">
        <div>
          <h4>{uni.name}</h4>
          <div className="loc">
            {uni.city}, {uni.state} · {uni.region} · {uni.type}
          </div>
        </div>
        <div className="score-badge">
          <span className="s">{uni.matchScore}</span>
          <span className="l">match</span>
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
          Avg GPA <b>{uni.avgGPA}</b>
        </span>
        <span>
          Avg SAT <b>{uni.avgSAT}</b>
        </span>
        <span>
          Admit <b>{uni.acceptanceRate}%</b>
        </span>
        <span>
          Tuition <b>${(uni.tuition / 1000).toFixed(0)}k</b>
        </span>
      </div>
    </article>
  );
}
