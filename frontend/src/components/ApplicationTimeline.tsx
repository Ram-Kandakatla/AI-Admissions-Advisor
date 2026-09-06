import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { isSettled } from "../applicationStatus";
import { CYCLE_MONTHS, KIND_LABEL, MILESTONES } from "../data/milestones";
import type { Milestone, MilestoneKind } from "../data/milestones";
import { countdown, dayMonth, localMidnight, parseLocalDate, urgencyOf } from "../dates";
import type { Application, StudentRecord } from "../types";

// The application year as one scroll.
//
// The month rails are the same for everyone — they're the conventions of a US
// cycle, not anyone's personal plan — so this page works with no profile at
// all. When a profile *and* tracked applications exist, the student's own
// deadlines get pinned onto the same rails, which is the whole point: their
// Nov 1 sits next to everybody's Nov 1.

const MONTH_NAME = new Intl.DateTimeFormat(undefined, { month: "long" });

/** Same rule as the server's currentCycleYear: July is the changeover. */
function localCycleYear(now = new Date()): number {
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

type Row =
  | { kind: "milestone"; id: string; day: number | null; milestone: Milestone }
  | { kind: "own"; id: string; day: number; app: Application; iso: string };

export default function ApplicationTimeline({
  student,
}: {
  student: StudentRecord | null;
}) {
  const [cycleYear, setCycleYear] = useState<number>(localCycleYear);
  const [apps, setApps] = useState<Application[]>([]);

  // application-meta needs no student, so the cycle year is available even to
  // a first-time visitor. Falling back to the local computation keeps the page
  // rendering if the backend is down — the milestones don't need a server.
  useEffect(() => {
    let live = true;
    api
      .applicationMeta()
      .then((meta) => live && setCycleYear(meta.cycleYear))
      .catch(() => {
        /* the local fallback is already in state */
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!student) {
      setApps([]);
      return;
    }
    let live = true;
    api
      .applications(student.id)
      .then((data) => live && setApps(data.applications))
      .catch(() => live && setApps([]));
    return () => {
      live = false;
    };
  }, [student]);

  const dated = useMemo(() => apps.filter((a) => a.deadline), [apps]);
  const rolling = useMemo(() => apps.filter((a) => !a.deadline), [apps]);

  const today = localMidnight();
  const thisMonthKey = `${today.getFullYear()}-${today.getMonth() + 1}`;

  const months = useMemo(
    () =>
      CYCLE_MONTHS.map(([month, offset]) => {
        const year = cycleYear + offset;

        const rows: Row[] = MILESTONES.filter(
          (m) => m.month === month && m.offsetYears === offset
        ).map((m) => ({ kind: "milestone" as const, id: m.id, day: m.day ?? null, milestone: m }));

        for (const app of dated) {
          const d = parseLocalDate(app.deadline!);
          if (d.getFullYear() !== year || d.getMonth() + 1 !== month) continue;
          rows.push({
            kind: "own",
            id: `own-${app.id}`,
            day: d.getDate(),
            app,
            iso: app.deadline!,
          });
        }

        // Dated items run in order; the "sometime this month" habits settle
        // underneath them, where they read as context rather than as a date
        // you've somehow missed.
        rows.sort((a, b) => {
          if (a.day === null && b.day === null) return 0;
          if (a.day === null) return 1;
          if (b.day === null) return -1;
          if (a.day !== b.day) return a.day - b.day;
          return a.kind === b.kind ? 0 : a.kind === "own" ? -1 : 1;
        });

        const lastOfMonth = new Date(year, month, 0);
        return {
          key: `${year}-${month}`,
          year,
          month,
          label: `${MONTH_NAME.format(new Date(year, month - 1, 1))} ${year}`,
          rows,
          past: lastOfMonth < today,
          current: `${year}-${month}` === thisMonthKey,
        };
      }),
    [cycleYear, dated, today, thisMonthKey]
  );

  const ownCount = dated.length + rolling.length;

  return (
    <div>
      <div className="view-head">
        <span className="eyebrow">Cycle {cycleYear}–{String(cycleYear + 1).slice(2)}</span>
        <h1 className="section-title">The application year, September to May.</h1>
        <p className="lead">
          What happens when, in the order it happens. These are the conventions of a US cycle — the
          dates most schools cluster around — so treat them as a rhythm to plan against, then
          confirm every real deadline on the college&apos;s own admissions page.
        </p>
      </div>

      <div className="rm-legend">
        {(Object.keys(KIND_LABEL) as MilestoneKind[]).map((k) => (
          <span className="rm-key" key={k} data-kind={k}>
            <i />
            {KIND_LABEL[k]}
          </span>
        ))}
        {student && (
          <span className="rm-key rm-key-own">
            <i />
            Your deadlines
          </span>
        )}
      </div>

      {student ? (
        ownCount === 0 ? (
          <div className="rm-callout">
            <div>
              <strong>Nothing on your tracker yet.</strong> Add the schools you&apos;re applying to
              and their deadlines will drop onto these rails alongside the common ones.
            </div>
            <Link className="btn btn-sm btn-primary" to={student ? "/tracker" : "/profile"}>
              Open the tracker <span className="btn-arrow">→</span>
            </Link>
          </div>
        ) : (
          <div className="rm-callout">
            <div>
              <strong>
                {dated.length} of your {ownCount} tracked application{ownCount === 1 ? "" : "s"}
              </strong>{" "}
              {dated.length === 1 ? "is" : "are"} pinned below.
              {rolling.length > 0 &&
                ` ${rolling.length} rolling application${
                  rolling.length === 1 ? "" : "s"
                } ${rolling.length === 1 ? "has" : "have"} no fixed date — earlier is genuinely better there.`}
            </div>
            <Link className="btn btn-sm btn-ghost" to={student ? "/tracker" : "/profile"}>
              Edit deadlines
            </Link>
          </div>
        )
      ) : (
        <div className="rm-callout">
          <div>
            <strong>This roadmap is the same for everyone.</strong> Build a profile and track a few
            schools, and your own deadlines will appear on these rails next to the common ones.
          </div>
        </div>
      )}

      <div className="roadmap">
        {months.map((m) => (
          <section className="rm-month" key={m.key} data-past={m.past || undefined}>
            <div className="rm-month-head">
              <h2>{m.label}</h2>
              {m.current && <span className="rm-now">You are here</span>}
            </div>

            <ul className="rm-items">
              {m.rows.map((row) =>
                row.kind === "milestone" ? (
                  <MilestoneRow key={row.id} milestone={row.milestone} year={m.year} />
                ) : (
                  <OwnRow key={row.id} app={row.app} iso={row.iso} />
                )
              )}
            </ul>
          </section>
        ))}
      </div>

      {rolling.length > 0 && (
        <section className="rm-rolling">
          <h2>No fixed date</h2>
          <p className="md-lede">
            Rolling applications are read as they arrive, so they never land on a month — but the
            seats and the aid do run out.
          </p>
          <ul className="rm-rolling-list">
            {rolling.map((a) => (
              <li key={a.id}>
                <span className="rm-name">{a.university?.name ?? "Unknown school"}</span>
                <span className="rm-plan">Rolling</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="md-note">
        Deadlines, aid forms, and testing policies all change between cycles. Compass tracks the
        pattern, not any one college&apos;s calendar — always confirm on the official site, and
        check anything that matters with your school counselor.
      </p>
    </div>
  );
}

function MilestoneRow({ milestone, year }: { milestone: Milestone; year: number }) {
  const iso = milestone.day
    ? `${year}-${String(milestone.month).padStart(2, "0")}-${String(milestone.day).padStart(2, "0")}`
    : null;
  const passed = iso ? parseLocalDate(iso) < localMidnight() : false;

  return (
    <li className="rm-item" data-kind={milestone.kind} data-passed={passed || undefined}>
      <span className="rm-date">{iso ? dayMonth.format(parseLocalDate(iso)) : "All month"}</span>
      <span className="rm-dot" />
      <div className="rm-body">
        <div className="rm-title">
          {milestone.title}
          <span className="rm-kind">{KIND_LABEL[milestone.kind]}</span>
        </div>
        <p className="rm-detail">{milestone.detail}</p>
      </div>
    </li>
  );
}


function OwnRow({ app, iso }: { app: Application; iso: string }) {
  const settled = isSettled(app.status);
  const urgency = settled ? "done" : urgencyOf(iso);

  return (
    <li className="rm-item rm-own" data-urgency={urgency ?? undefined}>
      <span className="rm-date">{dayMonth.format(parseLocalDate(iso))}</span>
      <span className="rm-dot" />
      <div className="rm-body">
        <div className="rm-title">
          {app.university?.name ?? "Unknown school"}
          <span className="rm-kind rm-mine">Yours · {app.plan}</span>
        </div>
        <p className="rm-detail">
          {settled ? `Status: ${app.status}.` : `${countdown(iso)}.`}
          {app.deadlineIsTypical
            ? " This is the usual date for that plan, not one we've confirmed with the school — check their site and set the real one on your tracker."
            : ""}
        </p>
      </div>
    </li>
  );
}
