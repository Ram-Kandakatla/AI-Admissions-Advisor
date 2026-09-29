import type { University } from "../types";

type GpaSource = University["gpaSource"];

/**
 * Estimated GPAs must never look like reported ones. The errors (RMSE .090,
 * .152) must match the importer's published figures.
 */
const TOOLTIP: Record<string, string> = {
  "estimated-sat":
    "Estimated from this school's average SAT — no federal dataset publishes average GPA, and this school has not reported one.",
  "estimated-profile":
    "Estimated from this school's admission rate and first-year retention, because it is test-blind and reports no SAT average.",
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

/** "Test-blind" rather than a blank, which would read as missing data. */
export function SatValue({ value }: { value: number | null }) {
  if (value !== null) return <>{value}</>;
  return (
    <span className="sat-none" title="This school is test-blind — it does not consider SAT scores.">
      test-blind
    </span>
  );
}
