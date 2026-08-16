// Shared date handling for anything that puts a deadline on screen.
//
// Deadlines are date-only strings. Passing one straight to `new Date()` parses
// it as UTC midnight, which renders as the *previous day* anywhere west of
// Greenwich — a tracker that says an application is due Oct 31 when it's due
// Nov 1 is worse than no tracker. So we build local dates by hand and compare
// against local midnight. The server deliberately sends no urgency of its
// own for the same reason: only the client knows what "today" is here.

export function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function localMidnight(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function daysUntil(iso: string): number {
  const ms = parseLocalDate(iso).getTime() - localMidnight().getTime();
  return Math.round(ms / 86_400_000);
}

export const dayMonth = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
export const monthYear = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

export type Urgency = "past" | "urgent" | "soon" | "later";

export function urgencyOf(iso: string | null): Urgency | null {
  if (!iso) return null;
  const d = daysUntil(iso);
  if (d < 0) return "past";
  if (d <= 7) return "urgent";
  if (d <= 30) return "soon";
  return "later";
}

export function countdown(iso: string | null): string {
  if (!iso) return "No fixed date";
  const d = daysUntil(iso);
  if (d === 0) return "Due today";
  if (d === 1) return "Due tomorrow";
  if (d < 0) return `${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} ago`;
  return `${d} days left`;
}
