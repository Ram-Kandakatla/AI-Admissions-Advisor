import type { University } from "../types";

type GpaSource = University["gpaSource"];

/**
 * A school's average GPA, marked when Compass inferred it rather than read it.
 *
 * Most of the dataset comes from the federal College Scorecard, which — like
 * IPEDS behind it — publishes no GPA at all. Only a school's own Common Data Set
 * reports one, and those are PDFs that are often left blank. So imported schools
 * carry an estimate and the hand-curated ones carry a real figure.
 *
 * Marking the difference is the same rule the scholarship pages follow with
 * `usually` on a deadline month: a number Compass worked out for itself must not
 * render identically to one a school published, because a student reads both as
 * the school's own bar.
 *
 * The two estimate bases are not equally good, and the tooltip says which one is
 * in play. An SAT-derived figure fits the reported data at RMSE 0.090; an
 * admit-rate one, used for test-blind schools, at 0.222 — admission rate alone
 * cannot separate a selective school from an open-access one with many
 * applicants.
 */
const TOOLTIP: Record<string, string> = {
  "estimated-sat":
    "Estimated from this school's average SAT — no federal dataset publishes average GPA, and this school has not reported one.",
  "estimated-admit":
    "Estimated from this school's admission rate, because it is test-blind and reports no SAT average. A rougher estimate than the others.",
};

export function GpaValue({ value, source }: { value: number; source?: GpaSource }) {
  const tooltip = source ? TOOLTIP[source] : undefined;
  if (!tooltip) return <>{value.toFixed(2)}</>;
  return (
    <>
      {value.toFixed(2)}
      <span className="gpa-est" title={tooltip}>
        est
      </span>
    </>
  );
}

/**
 * A school's average SAT, or an explicit "test-blind" for the schools that have
 * none. Rendering a blank cell there would read as missing data; the point is
 * that the school does not use the SAT, which is information a student applying
 * with a weak score actively wants.
 */
export function SatValue({ value }: { value: number | null }) {
  if (value !== null) return <>{value}</>;
  return (
    <span className="sat-none" title="This school is test-blind — it does not consider SAT scores.">
      test-blind
    </span>
  );
}
