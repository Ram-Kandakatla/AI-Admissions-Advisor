// Tracker deadlines as an .ics file, with VALARM reminders, so reminders come
// from the student's own calendar with no server involved.
//
// RFC 5545 rules that are easy to get wrong:
//   * An all-day event's DTEND is exclusive (Nov 1 ends 20261102).
//   * TEXT escapes backslash, semicolon, comma and newline.
//   * Lines fold at 75 octets, never inside a multi-byte character.
//   * CRLF line endings throughout, including a trailing one.
// Dates stay date-only: adding a time would mean inventing one.

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

// Submitted or decided applications keep their event but lose the alarm.

/* ------------------------------------------------------------ Primitives */

const encoder = new TextEncoder();

/** Backslash first, or later escapes get re-escaped. Colons stay, so URLs survive. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * `for...of` walks code points, so a fold never splits a character.
 * Continuation lines hold one octet less: the leading space counts.
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

/** The exclusive DTEND of an all-day event on `iso`. */
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

/** Includes the "date not confirmed" caveat, since nothing else in a calendar repeats it. */
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
    // Stable across exports, so a re-import updates events instead of duplicating.
    `UID:${app.id}@compass`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${icsDate(deadline)}`,
    `DTEND;VALUE=DATE:${icsDayAfter(deadline)}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(describe(app, meta))}`,
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

/** Undated (rolling) applications aren't events; the calendar description names them. */
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
    // Non-standard, but the major clients read it to name the calendar.
    `X-WR-CALNAME:${escapeText(CALENDAR_NAME)}`,
    `X-WR-CALDESC:${escapeText(description)}`,
    ...dated.flatMap((app) => event(app, meta, stamp)),
    "END:VCALENDAR",
  ];

  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

export function deadlinesIcsFilename(student: StudentRecord, now = new Date()): string {
  return `compass-deadlines-${filenameSlug(student.name)}-${filenameStamp(now)}.ics`;
}

/** No BOM (that's for Excel). The media type makes phones offer "Add to Calendar". */
export function downloadIcs(filename: string, ics: string): void {
  downloadFile(filename, ics, "text/calendar;charset=utf-8");
}
