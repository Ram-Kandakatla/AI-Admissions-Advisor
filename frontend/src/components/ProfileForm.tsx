import { useState } from "react";
import { api } from "../api";
import type { FinancialNeed, Meta, ProfileInput, StudentRecord } from "../types";

const FALLBACK_MAJORS = [
  "CS", "Engineering", "Business", "Biology", "Physics", "Math", "Data Science",
  "Nursing", "Psychology", "English", "Economics", "Political Science", "Art",
  "Communications", "Education", "Chemistry", "Environmental Science", "Finance",
  "Pre-Med", "Pre-Law",
];
const FALLBACK_REGIONS = ["Northeast", "South", "Midwest", "West"];

const NEED_LABELS: Record<FinancialNeed, string> = {
  high: "High need",
  medium: "Some need",
  low: "Low / none",
};

export default function ProfileForm({
  meta,
  existing,
  onSaved,
}: {
  meta: Meta | null;
  existing: StudentRecord | null;
  onSaved: (record: StudentRecord) => void;
}) {
  const majors = meta?.majors ?? FALLBACK_MAJORS;
  const regions = meta?.regions ?? FALLBACK_REGIONS;

  const [form, setForm] = useState<ProfileInput>({
    name: existing?.name ?? "",
    gpa: existing?.gpa ?? "",
    satScore: existing?.satScore ?? "",
    actScore: existing?.actScore ?? "",
    interestedMajors: existing?.interestedMajors ?? [],
    extracurriculars: existing?.extracurriculars ?? [],
    careerGoals: existing?.careerGoals ?? "",
    financialNeed: existing?.financialNeed ?? "medium",
    preferredRegions: existing?.preferredRegions ?? [],
  });
  const [ecInput, setEcInput] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof ProfileInput>(key: K, value: ProfileInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const toggle = (key: "interestedMajors" | "preferredRegions", value: string) =>
    setForm((f) => {
      const has = f[key].includes(value);
      return { ...f, [key]: has ? f[key].filter((v) => v !== value) : [...f[key], value] };
    });

  const addEc = () => {
    const v = ecInput.trim();
    if (v && !form.extracurriculars.includes(v)) {
      set("extracurriculars", [...form.extracurriculars, v]);
    }
    setEcInput("");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clientErrors: string[] = [];
    if (!form.name.trim()) clientErrors.push("Please enter your name.");
    if (form.gpa === "" || Number(form.gpa) < 0 || Number(form.gpa) > 5)
      clientErrors.push("Enter a GPA between 0 and 5.0.");
    if (form.interestedMajors.length === 0)
      clientErrors.push("Pick at least one intended major.");
    if (clientErrors.length) {
      setErrors(clientErrors);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    setSaving(true);
    setErrors([]);
    try {
      // An account holds one profile, so an edit updates the row it already
      // has. Before Phase 2 this always POSTed, which quietly created a second
      // student on every edit and left the first one — with its notes and
      // tracked applications still attached — stranded.
      const record = existing
        ? await api.updateStudent(existing.id, form)
        : await api.createStudent(form);
      onSaved(record);
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="view-head">
        <span className="eyebrow">Your profile</span>
        <h1 className="section-title">Tell us who you are as an applicant.</h1>
        <p className="lead">
          The more honest and specific you are, the sharper your matches. This stays private to
          your account — it is never shown to other students and never sold.
        </p>
      </div>

      {errors.length > 0 && (
        <div className="form-error" role="alert">
          {errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}

      <form className="panel" onSubmit={submit} noValidate>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="name">Name</label>
            <input
              id="name"
              type="text"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Jordan Rivera"
            />
          </div>

          <div className="field">
            <label htmlFor="gpa">
              Unweighted GPA <span className="hint">(0–4.0, weighted up to 5.0)</span>
            </label>
            <input
              id="gpa"
              type="number"
              step="0.01"
              min="0"
              max="5"
              value={form.gpa}
              onChange={(e) => set("gpa", e.target.value === "" ? "" : parseFloat(e.target.value))}
              placeholder="3.8"
            />
          </div>

          <div className="field">
            <label htmlFor="sat">
              SAT <span className="hint">optional · 400–1600</span>
            </label>
            <input
              id="sat"
              type="number"
              min="400"
              max="1600"
              value={form.satScore}
              onChange={(e) => set("satScore", e.target.value === "" ? "" : parseInt(e.target.value))}
              placeholder="1450"
            />
          </div>

          <div className="field">
            <label htmlFor="act">
              ACT <span className="hint">optional · 1–36</span>
            </label>
            <input
              id="act"
              type="number"
              min="1"
              max="36"
              value={form.actScore}
              onChange={(e) => set("actScore", e.target.value === "" ? "" : parseInt(e.target.value))}
              placeholder="32"
            />
          </div>

          <div className="field full">
            <label id="majors-label">
              Intended majors <span className="hint">— pick all that interest you</span>
            </label>
            <div className="chips" role="group" aria-labelledby="majors-label">
              {majors.map((m) => (
                <button
                  type="button"
                  key={m}
                  className="chip"
                  aria-pressed={form.interestedMajors.includes(m)}
                  onClick={() => toggle("interestedMajors", m)}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="field full">
            <label htmlFor="ec">
              Extracurriculars &amp; coursework <span className="hint">— clubs, sports, AP/IB classes, jobs</span>
            </label>
            <div className="tag-input-row">
              <input
                id="ec"
                type="text"
                value={ecInput}
                onChange={(e) => setEcInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addEc();
                  }
                }}
                placeholder="e.g. Robotics captain, AP Calculus, part-time job"
              />
              <button type="button" className="btn btn-ghost" onClick={addEc}>
                Add
              </button>
            </div>
            {form.extracurriculars.length > 0 && (
              <div className="tag-list">
                {form.extracurriculars.map((ec) => (
                  <span className="tag" key={ec}>
                    {ec}
                    <button
                      type="button"
                      aria-label={`Remove ${ec}`}
                      onClick={() =>
                        set(
                          "extracurriculars",
                          form.extracurriculars.filter((x) => x !== ec)
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="field full">
            <label htmlFor="career">Career goal or dream job <span className="hint">optional</span></label>
            <textarea
              id="career"
              value={form.careerGoals}
              onChange={(e) => set("careerGoals", e.target.value)}
              placeholder="e.g. I want to design sustainable buildings, or I'm not sure yet but I love biology."
            />
          </div>

          <div className="field">
            <label id="need-label">Financial need</label>
            <div className="segmented" role="group" aria-labelledby="need-label">
              {(["high", "medium", "low"] as FinancialNeed[]).map((n) => (
                <button
                  type="button"
                  key={n}
                  aria-pressed={form.financialNeed === n}
                  onClick={() => set("financialNeed", n)}
                >
                  {NEED_LABELS[n]}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label id="regions-label">Preferred regions <span className="hint">optional</span></label>
            <div className="chips" role="group" aria-labelledby="regions-label">
              {regions.map((r) => (
                <button
                  type="button"
                  key={r}
                  className="chip"
                  aria-pressed={form.preferredRegions.includes(r)}
                  onClick={() => toggle("preferredRegions", r)}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="form-footer">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving
              ? existing
                ? "Saving…"
                : "Finding matches…"
              : existing
                ? "Save changes"
                : "Get my matches"}{" "}
            <span className="btn-arrow">→</span>
          </button>
          <span className="hero-note">You can edit this any time.</span>
        </div>
      </form>
    </div>
  );
}
