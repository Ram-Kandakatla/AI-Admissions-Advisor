import { useEffect, useState } from "react";
import { api } from "../api";
import type { MajorInsights, MajorSchool, StudentRecord, Tier } from "../types";

// Everything on this page is computed from the university dataset. There is
// deliberately no prose about what a given program is *like* — that isn't in
// the data, and inventing it would put false specifics into someone's essay.
// The qualitative half is handled two ways: a checklist of questions to answer
// on the school's own site, and a handoff to the chatbot.

const money = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const TIER_LABEL: Record<Tier, string> = {
  reach: "Reach",
  target: "Target",
  safety: "Safety",
};

export default function MajorDeepDive({
  student,
  onAsk,
}: {
  student: StudentRecord | null;
  onAsk: (question: string) => void;
}) {
  const [catalog, setCatalog] = useState<{ major: string; schoolCount: number }[]>([]);
  const [major, setMajor] = useState<string | null>(null);
  const [data, setData] = useState<MajorInsights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api
      .majors()
      .then((res) => {
        setCatalog(res.majors);
        // Open on the student's first intended major when there is one.
        const preferred = student?.interestedMajors?.[0];
        const known = res.majors.some((m) => m.major === preferred);
        setMajor(known && preferred ? preferred : res.majors[0]?.major ?? null);
      })
      .catch((e) => setError((e as Error).message));
  }, [student?.interestedMajors]);

  useEffect(() => {
    if (!major) return;
    let live = true;
    setLoading(true);
    setError(null);
    api
      .majorInsights(major, student?.id)
      .then((res) => live && setData(res))
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [major, student?.id]);

  const mine = new Set(student?.interestedMajors ?? []);
  // The student's own majors first, then everything else.
  const ordered = [...catalog].sort((a, b) => {
    const am = mine.has(a.major) ? 0 : 1;
    const bm = mine.has(b.major) ? 0 : 1;
    return am - bm || a.major.localeCompare(b.major);
  });

  return (
    <div>
      <div className="view-head">
        <span className="eyebrow">Major deep dive</span>
        <h2 className="section-title">What does this field actually look like?</h2>
        <p className="lead">
          How selective the schools offering a major are, what they cost, where they are, and how
          your numbers sit against them — plus the questions worth answering on each school&apos;s
          own site before you write a word of an essay.
        </p>
      </div>

      <div className="major-picker" role="group" aria-label="Choose a major">
        {ordered.map((m) => (
          <button
            key={m.major}
            className="chip"
            aria-pressed={m.major === major}
            onClick={() => setMajor(m.major)}
          >
            {m.major}
            {mine.has(m.major) && <span className="chip-star" aria-label="one of yours"> ★</span>}
            <span className="chip-count">{m.schoolCount}</span>
          </button>
        ))}
      </div>

      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}

      {loading && !data && <div className="spinner" aria-label="Loading major insights" />}

      {data && (
        <>
          <Landscape data={data} />
          {data.position && <Position data={data} />}
          {data.combinations && data.combinations.length > 0 && (
            <Combinations data={data} />
          )}
          <Adjacent data={data} onPick={setMajor} catalog={catalog} />
          <SchoolTable data={data} />
          <Research data={data} student={student} onAsk={onAsk} />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- Landscape */

function Landscape({ data }: { data: MajorInsights }) {
  return (
    <section className="md-section">
      <div className="sec-hd">The landscape</div>
      <div className="md-grid">
        <Stat
          label="Schools offering it"
          value={String(data.schoolCount)}
          sub={`${Math.round(data.shareOfDataset * 100)}% of the set`}
        />
        <Stat
          label="Admit rate"
          value={`${data.selectivity.median}%`}
          sub={`ranges ${data.selectivity.min}% – ${data.selectivity.max}%`}
        />
        <Stat
          label="Tuition (sticker)"
          value={money.format(data.tuition.median)}
          sub={`${money.format(data.tuition.min)} – ${money.format(data.tuition.max)}`}
        />
        <Stat
          label="Typical admit GPA"
          value={data.avgGPA.median.toFixed(2)}
          sub={`${data.avgGPA.min} – ${data.avgGPA.max}`}
        />
      </div>

      <div className="md-bars">
        <BarGroup title="Where they are" items={data.regions} total={data.schoolCount} />
        <BarGroup title="Setting" items={data.settings} total={data.schoolCount} />
        <BarGroup title="Public / private" items={data.types} total={data.schoolCount} />
      </div>
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="md-stat">
      <div className="md-stat-val">{value}</div>
      <div className="md-stat-lbl">{label}</div>
      <div className="md-stat-sub">{sub}</div>
    </div>
  );
}

function BarGroup({
  title,
  items,
  total,
}: {
  title: string;
  items: { key: string; count: number }[];
  total: number;
}) {
  return (
    <div className="md-bargroup">
      <h4>{title}</h4>
      {items.map((item) => (
        <div className="md-bar" key={item.key}>
          <span className="md-bar-lbl">{item.key}</span>
          <span className="md-bar-track">
            <span className="md-bar-fill" style={{ width: `${(item.count / total) * 100}%` }} />
          </span>
          <span className="md-bar-num">{item.count}</span>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- Position */

function Position({ data }: { data: MajorInsights }) {
  const p = data.position!;
  const ahead = p.gpaGapToMedian >= 0;

  return (
    <section className="md-section">
      <div className="sec-hd">Where you stand</div>
      <div className="rec-summary">
        {(["reach", "target", "safety"] as Tier[]).map((t) => (
          <div className={`rec-stat ${t}`} key={t}>
            <div className="num">{p.tiers[t]}</div>
            <div className="label">{TIER_LABEL[t]}</div>
            <div className="desc">
              {t === "reach"
                ? "A stretch on GPA or highly selective."
                : t === "target"
                ? "Squarely in your range."
                : "Very likely admits."}
            </div>
          </div>
        ))}
      </div>

      <div className="panel md-position">
        <p>
          Your <strong>{p.gpa.toFixed(2)}</strong> GPA sits{" "}
          <strong className={ahead ? "md-ahead" : "md-behind"}>
            {ahead ? "+" : ""}
            {p.gpaGapToMedian.toFixed(2)}
          </strong>{" "}
          against the <strong>{p.medianGPA.toFixed(2)}</strong> median for schools offering{" "}
          {data.major}.
          {p.satScore && p.medianSAT
            ? ` Your ${p.satScore} SAT compares with a ${p.medianSAT} median.`
            : ""}
        </p>
        <p className="md-note">
          {p.affordable} of {data.schoolCount} sit inside your stated budget at sticker price — and
          sticker price is not what most families pay. Run each school&apos;s net price calculator
          before ruling it out.
        </p>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------- Combinations */

function Combinations({ data }: { data: MajorInsights }) {
  return (
    <section className="md-section">
      <div className="sec-hd">If you change your mind</div>
      <div className="panel">
        <p className="md-lede">
          Plenty of people switch majors after freshman year. These counts show how many of the{" "}
          {data.schoolCount} schools offering {data.major} also cover your other interests — pick
          one of those and a change of heart doesn&apos;t mean a transfer.
        </p>
        <div className="md-combos">
          {data.combinations!.map((c) => (
            <div className="md-combo" key={c.major}>
              <span className="md-combo-num">{c.count}</span>
              <span className="md-combo-lbl">
                also offer <strong>{c.major}</strong>
              </span>
              <span className="md-combo-bar">
                <span
                  className="md-combo-fill"
                  style={{ width: `${(c.count / data.schoolCount) * 100}%` }}
                />
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- Adjacent */

function Adjacent({
  data,
  onPick,
  catalog,
}: {
  data: MajorInsights;
  onPick: (major: string) => void;
  catalog: { major: string; schoolCount: number }[];
}) {
  const known = new Set(catalog.map((c) => c.major));
  return (
    <section className="md-section">
      <div className="sec-hd">Commonly offered alongside</div>
      <p className="md-lede">
        Of the schools that teach {data.major}, this is how many also teach each of these. A high
        share means the two fields usually live under one roof.
      </p>
      <div className="md-adjacent">
        {data.adjacent.map((a) => (
          <button
            key={a.key}
            className="md-adj"
            onClick={() => known.has(a.key) && onPick(a.key)}
            disabled={!known.has(a.key)}
            title={`See the deep dive for ${a.key}`}
          >
            <span className="md-adj-share">{Math.round(a.share * 100)}%</span>
            <span className="md-adj-name">{a.key}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- School table */

function SchoolTable({ data }: { data: MajorInsights }) {
  return (
    <section className="md-section">
      <div className="sec-hd">
        Every school offering {data.major} · most selective first
      </div>
      <div className="uni-table-wrap">
        <table className="uni-table">
          <thead>
            <tr>
              <th>University</th>
              <th>Location</th>
              {data.schools[0]?.tier && <th>For you</th>}
              <th>Admit rate</th>
              <th>Avg GPA</th>
              <th>Tuition</th>
              <th>Also covers</th>
            </tr>
          </thead>
          <tbody>
            {data.schools.map((s) => (
              <SchoolRow key={s.id} school={s} showTier={!!data.schools[0]?.tier} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SchoolRow({ school, showTier }: { school: MajorSchool; showTier: boolean }) {
  return (
    <tr>
      <td>
        <span className="name">{school.name}</span>
      </td>
      <td>
        {school.city}, {school.state} · {school.setting}
      </td>
      {showTier && (
        <td>
          {school.tier && <span className={`tier-tag tier-${school.tier}`}>{TIER_LABEL[school.tier]}</span>}
        </td>
      )}
      <td>{school.acceptanceRate}%</td>
      <td>{school.avgGPA}</td>
      <td>{money.format(school.tuition)}</td>
      <td>
        {school.alsoCovers.length > 0 ? (
          <span className="md-also">{school.alsoCovers.join(", ")}</span>
        ) : (
          <span className="md-none">—</span>
        )}
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------- Research */

function Research({
  data,
  student,
  onAsk,
}: {
  data: MajorInsights;
  student: StudentRecord | null;
  onAsk: (question: string) => void;
}) {
  const [school, setSchool] = useState("");

  const askAboutSchool = () => {
    const picked = data.schools.find((s) => String(s.id) === school);
    if (!picked) return;
    onAsk(
      `I'm considering studying ${data.major} at ${picked.name}. What should I know about their ` +
        `program — how you get into the major, what the department is known for, and what would ` +
        `make a strong "why this school" essay? Please tell me where you're unsure.`
    );
  };

  return (
    <section className="md-section">
      <div className="sec-hd">Do your own digging</div>
      <div className="panel">
        <p className="md-lede">
          Compass won&apos;t invent details about a specific department — a made-up lab name in an
          interview is worse than saying nothing. These are the questions actually worth answering
          on each school&apos;s admissions and department pages.
        </p>

        <ol className="md-questions">
          {data.researchQuestions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ol>

        <div className="md-ask">
          <div className="field">
            <label htmlFor="md-ask-school">Ask Compass about a specific school</label>
            <select id="md-ask-school" value={school} onChange={(e) => setSchool(e.target.value)}>
              <option value="">Choose a school…</option>
              {data.schools.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" onClick={askAboutSchool} disabled={!school}>
            Ask about {data.major} there <span className="btn-arrow">→</span>
          </button>
        </div>

        {!student && (
          <p className="md-note">
            Build a profile and this page will also show how your GPA and scores sit against these
            schools.
          </p>
        )}
      </div>
    </section>
  );
}
