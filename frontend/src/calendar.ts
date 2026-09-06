// The tracker's deadlines, as a calendar the student actually lives in.
//
// Phase 6.1 — deadline reminder emails — is blocked on a sending domain and an
// email provider. This is the other half of the same idea and needs neither:
// an .ics file imports into Google Calendar, Apple Calendar, or Outlook, and
// the VALARM on each event is what makes the reminder fire. It arrives from
// the student's own calendar, on the device they already check, with no server
// and no address list involved at all.
//
// Everything below is RFC 5545. Four of its rules are easy to get wrong and
// each one is load-bearing here:
//
//   * DTEND is EXCLUSIVE for an all-day event. A deadline on Nov 1 is
//     DTSTART 20261101 / DTEND 20261102. Writing the same date for both makes
//     a zero-length event, which some clients render as a sliver and others
//     drop outright.
//   * TEXT values escape backslash, semicolon, comma, and newline. Without it
//     "Washington University in St. Louis, MO" splits at the comma into two
//     properties and the import fails or silently truncates.
//   * Lines fold at 75 OCTETS, not characters, and a fold must never land
//     inside a multi-byte character.
//   * The whole file is CRLF, including a trailing one.
//
// The dates are date-only, and stay that way. Giving a deadline a time would
// mean inventing one, and an invented time is a timezone bug waiting to
// happen — the exact failure dates.ts exists to prevent, arriving in someone's
// calendar as an application due the day before it is due.

import { isSettled } from "./applicationStatus";
import { dayMonth, parseLocalDate } from "./dates";
import { downloadFile, filenameSlug, filenameStamp } from "./exportList";
import type { Application, ApplicationMeta, StudentRecord } from "./types";

const PRODID = "-//Compass//College application deadlines//EN";
const CALENDAR_NAME = "Compass — application deadlines";

/** RFC 5545 §3.1: "Lines of text SHOULD NOT be longer than 75 octets". */
const MAX_OCTETS = 75;

/** How far ahead the reminder fires. Seven days is enough to still act. */
const ALARM_LEAD = "-P7D";

// Once an application is submitted or decided, its deadline is a fact rather
// than a countdown — so it keeps its place in the calendar as a record, and
// loses its alarm. Reminding someone about a deadline they have already met is
// the fastest way to teach them to ignore the reminders.
//
// The rule itself now lives in applicationStatus.ts, shared with the tracker,
// the timeline and the shared view. It was a fourth private copy here first.

/* ------------------------------------------------------------ Primitives */

const encoder = new TextEncoder();

/**
 * Escape one TEXT value.
 *
 * Order matters: backslash first, or the escapes added below get escaped in
 * turn and every comma arrives as a literal `\\,`. Colon is deliberately not
 * escaped — RFC 5545 only requires it inside a quoted parameter value, and
 * escaping it here breaks any URL in a note.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Fold one content line to 75 octets.
 *
 * Iterating with `for...of` walks code points rather than UTF-16 units, which
 * is what keeps a fold from landing inside a character. The continuation limit
 * is one lower than the first line's because the leading space a fold inserts
 * counts toward that line's 75.
 */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= MAX_OCTETS) return line;

  const parts: string[] = [];
  let current = "";
  let octets = 0;
  let limit = MAX_OCTETS;

  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (octets + size > limit) {
      parts.push(current);
      current = "";
      octets = 0;
      limit = MAX_OCTETS - 1; // the continuation's leading space
    }
    current += ch;
    octets += size;
  }
  parts.push(current);

  return parts.join("\r\n ");
}

/** "2026-11-01" → "20261101". */
function icsDate(iso: string): string {
  return iso.replace(/-/g, "");
}

/**
 * The day after `iso`, as an ICS date — an all-day event's exclusive DTEND.
 *
 * Built through parseLocalDate rather than string arithmetic so month ends,
 * year ends, and leap days are the Date object's problem rather than ours.
 */
function icsDayAfter(iso: string): string {
  const d = parseLocalDate(iso);
  d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** UTC timestamp in ICS basic format: 20260905T041530Z. */
function icsStamp(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
}

/* ---------------------------------------------------------------- Events */

function schoolName(app: Application): string {
  return app.university?.name ?? "Unknown school";
}

/** Short enough to survive a month grid, which truncates hard. */
function calendarName(app: Application): string {
  return app.university?.shortName || app.university?.name || "Application";
}

/**
 * What the event body says.
 *
 * Three things, in the order a student needs them: which deadline this is,
 * what is still outstanding on it, and — when the date is only the convention
 * for the plan — that the date itself is not confirmed. That last one matters
 * more in an exported file than on the page it came from: the calendar entry
 * outlives the session, and nothing around it repeats the caveat.
 */
function describe(app: Application, meta: ApplicationMeta): string {
  const planLabel = meta.plans.find((p) => p.key === app.plan)?.label ?? app.plan;
  const lines = [`${planLabel} deadline for ${schoolName(app)}.`];

  const outstanding = meta.checklist
    .filter((item) => !app.checklist[item.key])
    .map((item) => item.label);
  if (outstanding.length > 0 && !isSettled(app.status)) {
    lines.push("", `Still to do: ${outstanding.join(", ")}.`);
  }

  if (app.deadlineIsTypical) {
    lines.push(
      "",
      `Heads up: ${dayMonth.format(
        parseLocalDate(app.deadline!)
      )} is the usual date for ${planLabel}, not one confirmed with the school. Check their admissions page and set the real date on your Compass tracker.`
    );
  }

  if (app.notes.trim()) lines.push("", `Your note: ${app.notes.trim()}`);

  return lines.join("\n");
}

function event(app: Application, meta: ApplicationMeta, stamp: string): string[] {
  const deadline = app.deadline!;
  const settled = isSettled(app.status);
  const summary = `${calendarName(app)} — ${
    meta.plans.find((p) => p.key === app.plan)?.label ?? app.plan
  } due`;

  const lines = [
    "BEGIN:VEVENT",
    // The application's own id, which is a UUID from the server. Stable across
    // exports on purpose: a calendar keys on UID, so re-importing after
    // changing a deadline updates the existing entry instead of leaving the
    // student with two of every school.
    `UID:${app.id}@compass`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${icsDate(deadline)}`,
    `DTEND;VALUE=DATE:${icsDayAfter(deadline)}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(describe(app, meta))}`,
    // An unconfirmed date is a tentative event in the most literal sense the
    // format has, so `deadlineIsTypical` maps straight onto it — clients that
    // render TENTATIVE differently will show the caveat without reading it.
    `STATUS:${app.deadlineIsTypical ? "TENTATIVE" : "CONFIRMED"}`,
    // A deadline does not make you unavailable all day.
    "TRANSP:TRANSPARENT",
  ];

  if (!settled) {
    lines.push(
      "BEGIN:VALARM",
      `TRIGGER:${ALARM_LEAD}`,
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(`${schoolName(app)} — one week to the deadline`)}`,
      "END:VALARM"
    );
  }

  lines.push("END:VEVENT");
  return lines;
}

/* ------------------------------------------------------------------ File */

/**
 * The whole calendar.
 *
 * Only applications with a real date become events — a rolling application has
 * no day to sit on, and picking one would be exactly the invention
 * `deadlineIsTypical` exists to avoid. They are named in the calendar's own
 * description instead, so the file says what it left out rather than quietly
 * being short.
 */
export function applicationsToIcs(
  applications: Application[],
  meta: ApplicationMeta,
  now = new Date()
): string {
  const dated = applications
    .filter((a) => a.deadline)
    .sort((a, b) => a.deadline!.localeCompare(b.deadline!));
  const rolling = applications.filter((a) => !a.deadline);

  const stamp = icsStamp(now);

  let description = `Application deadlines from Compass, exported ${
    now.toISOString().slice(0, 10)
  }. Dates marked tentative are the usual date for that decision plan, not one confirmed with the school.`;
  if (rolling.length > 0) {
    description += ` Not included, because rolling admission has no fixed date: ${rolling
      .map(schoolName)
      .join(", ")}.`;
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    // X-WR-* are not in the spec, but Google, Apple, and Outlook all read them
    // and there is no standard property that names an imported calendar.
    // Without them the import lands as "Untitled" next to everything else.
    `X-WR-CALNAME:${escapeText(CALENDAR_NAME)}`,
    `X-WR-CALDESC:${escapeText(description)}`,
    ...dated.flatMap((app) => event(app, meta, stamp)),
    "END:VCALENDAR",
  ];

  // Trailing CRLF included: the spec's grammar ends every content line with
  // one, and a few strict parsers reject a file whose last line has none.
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

export function deadlinesIcsFilename(student: StudentRecord, now = new Date()): string {
  return `compass-deadlines-${filenameSlug(student.name)}-${filenameStamp(now)}.ics`;
}

/**
 * Hand the .ics to the browser.
 *
 * No BOM, unlike the CSV path: that prefix is there for Excel, and a calendar
 * client reading UTF-8 per the spec has no use for it. The media type is what
 * gets a phone to offer "Add to Calendar" rather than a text preview.
 */
export function downloadIcs(filename: string, ics: string): void {
  downloadFile(filename, ics, "text/calendar;charset=utf-8");
}
