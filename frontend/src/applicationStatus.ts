// "Settled" (submitted or decided): the deadline is no longer a countdown.
// Shared by the tracker, timeline, .ics export and shared view.

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
