import { useEffect, useState } from "react";
import { api } from "../api";
import { isSettled } from "../applicationStatus";
import { countdown, dayMonth, parseLocalDate, urgencyOf } from "../dates";
import type { SharedPlan, Tier } from "../types";

// The plan as a parent or counselor sees it.
//
// Read-only in the strict sense: there is not a single control on this page
// that changes anything. No stars, no notepads, no checkboxes — the tracker's
// checklist renders as a progress read-out rather than as tickable boxes,
// because a counselor ticking a student's box would be editing their plan.
//
// It deliberately does not reuse Recommendations/ApplicationTracker/etc. Those
// components take a NotesStore and render controls throughout; adapting them
// with an `interactive={false}` prop would mean every future edit to those
// pages has to remember which half of itself is public. A separate, simpler
// component cannot grow a control by accident.

const TIER_LABEL: Record<Tier, string> = {
  reach: "Reach",
  target: "Target",
  safety: "Safety",
};

const STATUS_LABEL: Record<string, string> = {
  planning: "Planning",
  "in-progress": "In progress",
  submitted: "Submitted",
  accepted: "Accepted",
  waitlisted: "Waitlisted",
  denied: "Denied",
  withdrawn: "Withdrawn",
};

export default function SharedPlanView({ token }: { token: string }) {
  const [plan, setPlan] = useState<SharedPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .sharedPlan(token)
      .then((data) => live && setPlan(data))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [token]);

  if (error) {
    return (
      <div className="empty">
        <h1>This link isn&apos;t active</h1>
        <p>
          The student may have turned sharing off or replaced this link with a new one. Ask them
          for a current link.
        </p>
      </div>
    );
  }

  if (!plan) return <div className="spinner" aria-label="Loading the shared plan" />;

  const { student } = plan;
  const dated = plan.applications.filter((a) => a.deadline);
  const starred = plan.notes.filter((n) => n.starred);

  return (
    <div className="shared-view">
      <div className="view-head">
        <span className="eyebrow">Shared plan · read only</span>
        <h1 className="section-title">{student.name}&apos;s college plan</h1>
        <p className="lead">
          A read-only snapshot of what {student.name} is working on, shared from Compass. Nothing
          here can be changed from this page, and it reflects their plan as it stands right now.
        </p>
      </div>

      {/* ---- Profile ---- */}
      <section className="shared-section">
        <h2 className="sec-hd">The profile behind the list</h2>
        {/* A real <dl>. The dt/dd pairs need one as their parent — wrapping
            each pair in a div inside it is valid HTML5 and is what lets the
            grid lay them out. */}
        <dl className="shared-facts">
          <div>
            <dt>GPA</dt>
            <dd>{student.gpa}</dd>
          </div>
          {student.satScore != null && (
            <div>
              <dt>SAT</dt>
              <dd>{student.satScore}</dd>
            </div>
          )}
          {student.actScore != null && (
            <div>
              <dt>ACT</dt>
              <dd>{student.actScore}</dd>
            </div>
          )}
          <div>
            <dt>Intended majors</dt>
            <dd>{student.interestedMajors.join(", ") || "Undecided"}</dd>
          </div>
          {student.preferredRegions.length > 0 && (
            <div>
              <dt>Preferred regions</dt>
              <dd>{student.preferredRegions.join(", ")}</dd>
            </div>
          )}
        </dl>
        {student.careerGoals && (
          <p className="shared-goal">
            <strong>Where they&apos;re heading:</strong> {student.careerGoals}
          </p>
        )}
        {student.extracurriculars.length > 0 && (
          <p className="shared-goal">
            <strong>Outside class:</strong> {student.extracurriculars.join(" · ")}
          </p>
        )}
      </section>

      {/* ---- Applications ---- */}
      <section className="shared-section">
        <h2 className="sec-hd">Applications</h2>
        {plan.applications.length === 0 ? (
          <p className="md-lede">Nothing tracked yet.</p>
        ) : (
          <ul className="shared-apps">
            {plan.applications.map((app) => {
              const settled = isSettled(app.status);
              const done = Object.values(app.checklist).filter(Boolean).length;
              const total = Object.keys(app.checklist).length;
              return (
                <li
                  key={app.universityId}
                  className="shared-app"
                  data-urgency={
                    settled ? undefined : (urgencyOf(app.deadline) ?? undefined)
                  }
                >
                  <div className="shared-app-main">
                    <span className="shared-app-name">
                      {app.university?.name ?? "Unknown school"}
                    </span>
                    <span className="shared-app-meta">
                      {app.plan} · {STATUS_LABEL[app.status] ?? app.status}
                    </span>
                  </div>
                  <div className="shared-app-when">
                    {app.deadline ? (
                      <>
                        <strong>{dayMonth.format(parseLocalDate(app.deadline))}</strong>
                        <span>{settled ? STATUS_LABEL[app.status] : countdown(app.deadline)}</span>
                        {app.deadlineIsTypical && (
                          <span className="shared-app-caveat">
                            usual date for this plan, not confirmed
                          </span>
                        )}
                      </>
                    ) : (
                      <strong>Rolling</strong>
                    )}
                  </div>
                  {/* A read-out, not checkboxes. A counselor ticking a box
                      would be editing the student's plan. */}
                  <div className="shared-app-progress">
                    {done} of {total} to-dos done
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {dated.length > 0 && (
          <p className="md-note">
            Dates marked unconfirmed are the usual deadline for that decision plan, not one
            {" "}{student.name} has checked against the college&apos;s own admissions page.
          </p>
        )}
      </section>

      {/* ---- Matches ---- */}
      <section className="shared-section">
        <h2 className="sec-hd">The list Compass suggested</h2>
        {(["reach", "target", "safety"] as Tier[]).map((tier) => {
          const rows = plan.recommendations[tier];
          if (rows.length === 0) return null;
          // The reader cannot click through to the rest, so the count has to
          // say plainly that this is a shortlist rather than the whole tier.
          const total = plan.recommendationCounts?.[tier] ?? rows.length;
          return (
            <div key={tier} className="shared-tier">
              <h3>
                {TIER_LABEL[tier]}{" "}
                <span>{rows.length < total ? `${rows.length} strongest of ${total}` : rows.length}</span>
              </h3>
              <ul>
                {rows.map((uni) => (
                  <li key={uni.id}>
                    <span className="shared-uni">{uni.name}</span>
                    <span className="shared-uni-meta">
                      {uni.city}, {uni.state} · {uni.acceptanceRate}% admit
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>

      {/* ---- Saved schools ---- */}
      {starred.length > 0 && (
        <section className="shared-section">
          <h2 className="sec-hd">Saved schools</h2>
          <ul className="shared-notes">
            {starred.map((n) => (
              <li key={n.universityId}>
                <span className="shared-uni">
                  {n.university?.name ?? `University ${n.universityId}`}
                </span>
                {n.contactName && (
                  <span className="shared-uni-meta">
                    Contact: {n.contactName}
                    {n.contactRole ? ` — ${n.contactRole}` : ""}
                  </span>
                )}
                {n.note && <p className="shared-note-text">{n.note}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---- Scholarships ---- */}
      <section className="shared-section">
        <h2 className="sec-hd">Scholarships worth a look</h2>
        {(["target", "reach", "safety"] as Tier[]).flatMap((tier) =>
          plan.scholarships[tier].slice(0, 6).map((s) => (
            <div key={s.id} className="shared-award">
              <span className="shared-uni">
                {/* noreferrer, not just noopener. The token is in this page's
                    URL, and without it the Referer header carries the whole
                    share link to every sponsor site a reader clicks. */}
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.name}
                </a>
              </span>
              <span className="shared-uni-meta">
                {s.amountLabel} · {s.sponsor} · {s.deadline.label}
              </span>
            </div>
          ))
        )}
      </section>

      <p className="md-note">
        Shared from Compass. Deadlines, aid rules, and testing policies change between cycles —
        confirm anything that matters on the college&apos;s own site.
      </p>
    </div>
  );
}
