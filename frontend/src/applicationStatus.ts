// One definition of "this application is settled".
//
// Submitted or decided, so the deadline has stopped being a countdown and
// become a fact. Four places in the app branch on this — the tracker greys the
// card, the timeline drops the urgency colour, the .ics export omits the
// reminder, and the shared view labels the date rather than counting down to
// it — and until Phase 6 each of them carried its own copy of the list, under
// two different names (`CLOSED` and `SETTLED`).
//
// Four copies of one rule is one edit away from a state that is settled on
// three pages and counting down on the fourth, which is the kind of bug nobody
// reports because each page looks self-consistent. Adding a status is now one
// line here.

import type { ApplicationStatus } from "./types";

export const SETTLED_STATUSES: ApplicationStatus[] = [
  "submitted",
  "accepted",
  "waitlisted",
  "denied",
  "withdrawn",
];

/** Has this application stopped being something to work on? */
export function isSettled(status: string): boolean {
  return (SETTLED_STATUSES as string[]).includes(status);
}
