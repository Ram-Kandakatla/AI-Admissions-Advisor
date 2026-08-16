import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { countdown, dayMonth, daysUntil, monthYear, parseLocalDate, urgencyOf } from "../dates";
import type {
  Application,
  ApplicationMeta,
  ApplicationStatus,
  ChecklistKey,
  DecisionPlan,
  StudentRecord,
  University,
} from "../types";

// Mirrors the server's ordering. Applied on every render rather than only on
// load, because editing a deadline locally would otherwise leave the card in
// its old slot and the timeline out of sequence.
function byDeadline(a: Application, b: Application): number {
  if (!a.deadline && !b.deadline) return 0;
  if (!a.deadline) return 1;
  if (!b.deadline) return -1;
  return a.deadline.localeCompare(b.deadline);
}

const STATUS_LABEL: Record<ApplicationStatus, string> = {
  planning: "Planning",
  "in-progress": "In progress",
  submitted: "Submitted",
  accepted: "Accepted",
  waitlisted: "Waitlisted",
  denied: "Denied",
  withdrawn: "Withdrawn",
};

// Once a decision is in, the deadline countdown stops being the story.
const CLOSED: ApplicationStatus[] = ["submitted", "accepted", "waitlisted", "denied", "withdrawn"];

export default function ApplicationTracker({
  student,
  onGoMatches,
}: {
  student: StudentRecord;
  onGoMatches: () => void;
}) {
  const [meta, setMeta] = useState<ApplicationMeta | null>(null);
  const [apps, setApps] = useState<Application[] | null>(null);
  const [universities, setUniversities] = useState<University[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [addUni, setAddUni] = useState("");
  const [addPlan, setAddPlan] = useState<DecisionPlan>("RD");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([api.applicationMeta(), api.applications(student.id), api.universities()])
      .then(([m, list, unis]) => {
        if (!live) return;
        setMeta(m);
        setApps(list.applications);
        setUniversities(unis);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [student.id]);

  const untracked = useMemo(() => {
    const taken = new Set((apps ?? []).map((a) => a.universityId));
    return universities.filter((u) => !taken.has(u.id)).sort((a, b) => a.name.localeCompare(b.name));
  }, [universities, apps]);

  // Applying Early Decision is a binding commitment, so you get exactly one.
  // Worth catching here rather than letting someone build a plan that can't
  // legally happen.
  const bindingCount = (apps ?? []).filter(
    (a) => (a.plan === "ED" || a.plan === "ED2") && a.status !== "withdrawn"
  ).length;

  const add = async () => {
    if (!addUni) return;
    setAdding(true);
    setError(null);
    try {
      const created = await api.trackApplication(student.id, {
        universityId: Number(addUni),
        plan: addPlan,
      });
      setApps((prev) => [...(prev ?? []), created]);
      setAddUni("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const patch = async (
    app: Application,
    body: Parameters<typeof api.updateApplication>[2],
    optimistic?: Partial<Application>
  ) => {
    // Checklist ticks and status changes should feel instant; we reconcile
    // with the server's copy when it answers, and refetch if it rejects.
    if (optimistic) {
      setApps((prev) => prev?.map((a) => (a.id === app.id ? { ...a, ...optimistic } : a)) ?? null);
    }
    try {
      const updated = await api.updateApplication(student.id, app.id, body);
      setApps((prev) => prev?.map((a) => (a.id === app.id ? updated : a)) ?? null);
    } catch (e) {
      setError((e as Error).message);
      const fresh = await api.applications(student.id).catch(() => null);
      if (fresh) setApps(fresh.applications);
    }
  };

  const remove = async (app: Application) => {
    const previous = apps;
    setApps((prev) => prev?.filter((a) => a.id !== app.id) ?? null);
    try {
      await api.untrackApplication(student.id, app.id);
    } catch (e) {
      setError((e as Error).message);
      setApps(previous);
    }
  };

  if (error && !apps) {
    return (
      <div className="empty">
        <h3>Couldn&apos;t load your tracker</h3>
        <p>{error}</p>
      </div>
    );
  }

  if (!apps || !meta) return <div className="spinner" aria-label="Loading your tracker" />;

  const ordered = [...apps].sort(byDeadline);
  const open = ordered.filter((a) => !CLOSED.includes(a.status));
  const next = open.find((a) => a.deadline && daysUntil(a.deadline) >= 0) ?? null;
  const submitted = apps.filter((a) => a.status !== "planning" && a.status !== "in-progress").length;

  return (
    <div>
      <div className="view-head">
        <span className="eyebrow">Application tracker</span>
        <h2 className="section-title">
          {apps.length === 0
            ? "Every deadline, in one place."
            : `${apps.length} application${apps.length === 1 ? "" : "s"} in the ${meta.cycleYear}–${
                meta.cycleYear + 1
              } cycle.`}
        </h2>
        <p className="lead">
          Track what you owe each school and when it&apos;s due. Dates start as the usual
          convention for each plan — replace them with the real date from the school&apos;s
          admissions page as you confirm it.
        </p>
      </div>

      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}

      {bindingCount > 1 && (
        <div className="banner banner-warn" role="alert">
          <span>
            You have <strong>{bindingCount} binding applications</strong> (Early Decision). ED is a
            commitment to enroll if admitted, so you can only hold one — switch the others to EA or
            Regular Decision.
          </span>
        </div>
      )}

      {/* ---- Add a school ---- */}
      <div className="panel track-add">
        <div className="field">
          <label htmlFor="track-uni">Add a school</label>
          <select
            id="track-uni"
            value={addUni}
            onChange={(e) => setAddUni(e.target.value)}
            disabled={untracked.length === 0}
          >
            <option value="">
              {untracked.length === 0 ? "Every school is tracked" : "Choose a university…"}
            </option>
            {untracked.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} — {u.city}, {u.state}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="track-plan">Decision plan</label>
          <select
            id="track-plan"
            value={addPlan}
            onChange={(e) => setAddPlan(e.target.value as DecisionPlan)}
          >
            {meta.plans.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
                {p.binding ? " (binding)" : ""}
              </option>
            ))}
          </select>
        </div>

        <button className="btn btn-primary" onClick={add} disabled={!addUni || adding}>
          {adding ? "Adding…" : "Track it"}
        </button>

        <p className="track-plan-note">
          {meta.plans.find((p) => p.key === addPlan)?.note}
        </p>
      </div>

      {apps.length === 0 ? (
        <div className="empty">
          <h3>Nothing tracked yet</h3>
          <p>
            Add a school above, or start from the list Compass built for you — your reach, target,
            and safety matches are the natural place to begin.
          </p>
          <button className="btn btn-primary" onClick={onGoMatches}>
            See my matches <span className="btn-arrow">→</span>
          </button>
        </div>
      ) : (
        <>
          <div className="rec-summary track-summary">
            <div className="rec-stat track-stat-open">
              <div className="num">{open.length}</div>
              <div className="label">Still open</div>
              <div className="desc">Not yet submitted or decided.</div>
            </div>
            <div className="rec-stat track-stat-done">
              <div className="num">{submitted}</div>
              <div className="label">Sent or decided</div>
              <div className="desc">Off your plate.</div>
            </div>
            <div className="rec-stat track-stat-next">
              <div className="num">
                {next?.deadline ? dayMonth.format(parseLocalDate(next.deadline)) : "—"}
              </div>
              <div className="label">Next deadline</div>
              <div className="desc">
                {next?.university ? `${next.university.shortName} · ${countdown(next.deadline)}` : "Nothing upcoming."}
              </div>
            </div>
          </div>

          <Timeline applications={ordered} />

          <div className="sec-hd">Your applications</div>
          <div className="track-list">
            {ordered.map((app) => (
              <ApplicationCard
                key={app.id}
                app={app}
                meta={meta}
                onPatch={patch}
                onRemove={remove}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Timeline */

function Timeline({ applications }: { applications: Application[] }) {
  const dated = applications.filter((a) => a.deadline);
  const rolling = applications.filter((a) => !a.deadline);

  // Group by calendar month so the timeline reads the way a wall calendar
  // does, rather than as one undifferentiated list of dates.
  const months: { key: string; label: string; items: Application[] }[] = [];
  for (const app of dated) {
    const date = parseLocalDate(app.deadline!);
    const key = `${date.getFullYear()}-${date.getMonth()}`;
    let bucket = months.find((m) => m.key === key);
    if (!bucket) {
      bucket = { key, label: monthYear.format(date), items: [] };
      months.push(bucket);
    }
    bucket.items.push(app);
  }

  if (months.length === 0 && rolling.length === 0) return null;

  return (
    <section className="timeline" aria-label="Deadline timeline">
      <div className="sec-hd">Timeline</div>

      {months.map((month) => (
        <div className="tl-month" key={month.key}>
          <h4 className="tl-month-label">{month.label}</h4>
          <ol className="tl-items">
            {month.items.map((app) => {
              const urgency = urgencyOf(app.deadline);
              const done = CLOSED.includes(app.status);
              return (
                <li
                  key={app.id}
                  className="tl-item"
                  data-urgency={done ? "done" : urgency}
                >
                  <span className="tl-date">{dayMonth.format(parseLocalDate(app.deadline!))}</span>
                  <span className="tl-dot" aria-hidden="true" />
                  <span className="tl-name">{app.university?.name ?? "Unknown school"}</span>
                  <span className="tl-plan">{app.plan}</span>
                  <span className="tl-count">{done ? STATUS_LABEL[app.status] : countdown(app.deadline)}</span>
                </li>
              );
            })}
          </ol>
        </div>
      ))}

      {rolling.length > 0 && (
        <div className="tl-month">
          <h4 className="tl-month-label">Rolling — no fixed date</h4>
          <ol className="tl-items">
            {rolling.map((app) => (
              <li key={app.id} className="tl-item" data-urgency="rolling">
                <span className="tl-date">—</span>
                <span className="tl-dot" aria-hidden="true" />
                <span className="tl-name">{app.university?.name ?? "Unknown school"}</span>
                <span className="tl-plan">{app.plan}</span>
                <span className="tl-count">Apply early</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

/* ----------------------------------------------------------- Application card */

function ApplicationCard({
  app,
  meta,
  onPatch,
  onRemove,
}: {
  app: Application;
  meta: ApplicationMeta;
  onPatch: (
    app: Application,
    body: Parameters<typeof api.updateApplication>[2],
    optimistic?: Partial<Application>
  ) => void;
  onRemove: (app: Application) => void;
}) {
  const [showNotes, setShowNotes] = useState(false);
  const [notes, setNotes] = useState(app.notes);

  const doneCount = meta.checklist.filter((c) => app.checklist[c.key]).length;
  const total = meta.checklist.length;
  const closed = CLOSED.includes(app.status);
  const urgency = urgencyOf(app.deadline);

  return (
    <article className="track-card" data-urgency={closed ? "done" : urgency}>
      <div className="track-card-top">
        <div className="track-head">
          <h4>{app.university?.name ?? "Unknown school"}</h4>
          <div className="loc">
            {app.university ? `${app.university.city}, ${app.university.state}` : ""}
            {app.university ? ` · ${app.university.acceptanceRate}% admit rate` : ""}
          </div>
        </div>

        <div className="track-when">
          <span className="track-countdown">{closed ? STATUS_LABEL[app.status] : countdown(app.deadline)}</span>
          {app.deadlineIsTypical && app.deadline && (
            <span className="track-typical" title="This is the usual date for this plan, not a date confirmed with the school.">
              typical date — confirm
            </span>
          )}
        </div>
      </div>

      <div className="track-controls">
        <div className="field">
          <label htmlFor={`plan-${app.id}`}>Plan</label>
          <select
            id={`plan-${app.id}`}
            value={app.plan}
            onChange={(e) => onPatch(app, { plan: e.target.value as DecisionPlan })}
          >
            {meta.plans.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor={`deadline-${app.id}`}>Deadline</label>
          <input
            id={`deadline-${app.id}`}
            type="date"
            value={app.deadline ?? ""}
            onChange={(e) =>
              onPatch(app, { deadline: e.target.value || null }, {
                deadline: e.target.value || null,
                deadlineIsTypical: false,
              })
            }
          />
        </div>

        <div className="field">
          <label htmlFor={`status-${app.id}`}>Status</label>
          <select
            id={`status-${app.id}`}
            value={app.status}
            onChange={(e) =>
              onPatch(app, { status: e.target.value as ApplicationStatus }, {
                status: e.target.value as ApplicationStatus,
              })
            }
          >
            {meta.statuses.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>

        <span className={`status-pill status-${app.status}`}>{STATUS_LABEL[app.status]}</span>
      </div>

      <div className="track-progress">
        <div className="track-progress-bar">
          <div
            className="track-progress-fill"
            style={{ width: `${(doneCount / total) * 100}%` }}
          />
        </div>
        <span className="track-progress-lbl">
          {doneCount} of {total} done
        </span>
      </div>

      <ul className="track-checklist">
        {meta.checklist.map((item) => (
          <li key={item.key}>
            <label>
              <input
                type="checkbox"
                checked={app.checklist[item.key]}
                onChange={(e) =>
                  onPatch(
                    app,
                    { checklist: { [item.key]: e.target.checked } as Record<ChecklistKey, boolean> },
                    { checklist: { ...app.checklist, [item.key]: e.target.checked } }
                  )
                }
              />
              <span>{item.label}</span>
            </label>
          </li>
        ))}
      </ul>

      <div className="track-foot">
        <button className="btn btn-ghost btn-sm" onClick={() => setShowNotes((s) => !s)}>
          {showNotes ? "Hide notes" : app.notes ? "Notes ✓" : "Add notes"}
        </button>
        <button
          className="btn btn-ghost btn-sm track-remove"
          onClick={() => onRemove(app)}
          aria-label={`Stop tracking ${app.university?.name ?? "this school"}`}
        >
          Remove
        </button>
      </div>

      {showNotes && (
        <textarea
          className="track-notes"
          value={notes}
          placeholder="Supplemental prompts, who's writing your recs, portal login reminders…"
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== app.notes && onPatch(app, { notes })}
        />
      )}
    </article>
  );
}
