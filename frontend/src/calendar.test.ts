import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applicationsToIcs,
  deadlinesIcsFilename,
  downloadIcs,
  escapeText,
  foldLine,
} from "./calendar";
import { application, applicationMeta, student } from "./test/factories";

const meta = applicationMeta();

/** Split on CRLF and rejoin folded continuations, the way a parser would. */
function unfold(ics: string): string[] {
  const out: string[] = [];
  for (const line of ics.split("\r\n")) {
    if (line.startsWith(" ") && out.length > 0) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

/** The one property named, unfolded. */
function prop(ics: string, name: string): string | undefined {
  return unfold(ics)
    .find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`))
    ?.replace(new RegExp(`^${name}[;:]`), "");
}

describe("applicationsToIcs — file structure", () => {
  it("wraps events in a well-formed VCALENDAR", () => {
    const ics = applicationsToIcs([application()], meta);
    const lines = unfold(ics);

    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain("CALSCALE:GREGORIAN");
    expect(lines.some((l) => l.startsWith("PRODID:-//Compass//"))).toBe(true);
    // The last entry is the empty string after the trailing CRLF.
    expect(lines[lines.length - 2]).toBe("END:VCALENDAR");
  });

  it("uses CRLF throughout and ends with one", () => {
    const ics = applicationsToIcs([application()], meta);
    // No bare LF anywhere: every newline must be preceded by a CR.
    expect(/[^\r]\n/.test(ics)).toBe(false);
    expect(ics.endsWith("\r\n")).toBe(true);
  });

  it("names the calendar, so an import isn't 'Untitled'", () => {
    const ics = applicationsToIcs([application()], meta);
    expect(prop(ics, "X-WR-CALNAME")).toContain("Compass");
  });

  it("orders events by deadline regardless of input order", () => {
    const ics = applicationsToIcs(
      [
        application({ id: "b", deadline: "2027-01-05" }),
        application({ id: "a", deadline: "2026-11-01" }),
        application({ id: "c", deadline: "2027-02-01" }),
      ],
      meta
    );
    const uids = unfold(ics)
      .filter((l) => l.startsWith("UID:"))
      .map((l) => l.slice(4));
    expect(uids).toEqual(["a@compass", "b@compass", "c@compass"]);
  });
});

describe("applicationsToIcs — dates", () => {
  // The single most common .ics bug. DTEND is EXCLUSIVE for an all-day event,
  // so a one-day deadline ends on the *following* date. Writing the same date
  // for both makes a zero-length event that clients render as a sliver or drop.
  it("gives an all-day event an exclusive DTEND on the next day", () => {
    const ics = applicationsToIcs([application({ deadline: "2026-11-01" })], meta);
    expect(prop(ics, "DTSTART")).toBe("VALUE=DATE:20261101");
    expect(prop(ics, "DTEND")).toBe("VALUE=DATE:20261102");
  });

  it("rolls DTEND over a month end, a year end, and a leap day", () => {
    const cases: [string, string][] = [
      ["2027-01-31", "20270201"],
      ["2026-12-31", "20270101"],
      // 2028 is a leap year, so Feb 28 is followed by the 29th, not by March.
      ["2028-02-28", "20280229"],
    ];
    for (const [deadline, expected] of cases) {
      const ics = applicationsToIcs([application({ deadline })], meta);
      expect(prop(ics, "DTEND")).toBe(`VALUE=DATE:${expected}`);
    }
  });

  // The suite runs pinned to America/New_York for exactly this. `new
  // Date("2027-01-01")` is UTC midnight, which is Dec 31 here — so a naive
  // implementation exports every deadline one day early for anyone west of
  // Greenwich, and a UTC-running CI would never notice.
  it("does not shift a date west of Greenwich", () => {
    const ics = applicationsToIcs([application({ deadline: "2027-01-01" })], meta);
    expect(prop(ics, "DTSTART")).toBe("VALUE=DATE:20270101");
  });

  it("stamps DTSTAMP in UTC basic format", () => {
    const ics = applicationsToIcs([application()], meta, new Date("2026-09-05T04:15:30.000Z"));
    expect(prop(ics, "DTSTAMP")).toBe("20260905T041530Z");
  });
});

describe("applicationsToIcs — event content", () => {
  it("keys UID on the application id so a re-import updates rather than duplicates", () => {
    const ics = applicationsToIcs([application({ id: "3f9c-uuid" })], meta);
    expect(prop(ics, "UID")).toBe("3f9c-uuid@compass");
  });

  it("puts the school and its decision plan in the summary", () => {
    const ics = applicationsToIcs([application({ plan: "EA" })], meta);
    expect(prop(ics, "SUMMARY")).toBe("Coastal State — Early Action due");
  });

  it("marks an unconfirmed date TENTATIVE and says so in the body", () => {
    const ics = applicationsToIcs([application({ deadlineIsTypical: true })], meta);
    expect(prop(ics, "STATUS")).toBe("TENTATIVE");
    expect(prop(ics, "DESCRIPTION")).toContain("the usual date for Regular Decision");
  });

  it("marks a date the student confirmed CONFIRMED, with no caveat", () => {
    const ics = applicationsToIcs([application({ deadlineIsTypical: false })], meta);
    expect(prop(ics, "STATUS")).toBe("CONFIRMED");
    expect(prop(ics, "DESCRIPTION")).not.toContain("the usual date");
  });

  it("lists what is still outstanding on the checklist", () => {
    const ics = applicationsToIcs(
      [
        application({
          checklist: {
            essay: true,
            supplements: false,
            recommendations: false,
            transcript: true,
            testScores: true,
            fee: true,
            aid: true,
          },
        }),
      ],
      meta
    );
    const description = prop(ics, "DESCRIPTION")!;
    expect(description).toContain("Still to do: Supplements\\, Recommendations.");
    expect(description).not.toContain("Personal essay");
  });

  it("does not mark you busy for the day", () => {
    const ics = applicationsToIcs([application()], meta);
    expect(prop(ics, "TRANSP")).toBe("TRANSPARENT");
  });
});

describe("applicationsToIcs — alarms", () => {
  it("sets one reminder a week ahead of an open deadline", () => {
    const ics = applicationsToIcs([application({ status: "planning" })], meta);
    const lines = unfold(ics);
    expect(lines).toContain("BEGIN:VALARM");
    expect(lines).toContain("TRIGGER:-P7D");
    expect(lines).toContain("ACTION:DISPLAY");
    expect(lines.filter((l) => l === "BEGIN:VALARM")).toHaveLength(1);
  });

  // A reminder about a deadline you already met is how a student learns to
  // ignore every other reminder in the file.
  it("drops the alarm once the application is settled, keeping the event", () => {
    for (const status of ["submitted", "accepted", "waitlisted", "denied", "withdrawn"] as const) {
      const ics = applicationsToIcs([application({ status })], meta);
      expect(unfold(ics)).toContain("BEGIN:VEVENT");
      expect(unfold(ics)).not.toContain("BEGIN:VALARM");
    }
  });

  it("drops the outstanding-checklist line for a settled application too", () => {
    const ics = applicationsToIcs([application({ status: "submitted" })], meta);
    expect(prop(ics, "DESCRIPTION")).not.toContain("Still to do");
  });
});

describe("applicationsToIcs — rolling applications", () => {
  it("gives them no event, since there is no date to invent", () => {
    const ics = applicationsToIcs(
      [application({ id: "r", plan: "ROLLING", deadline: null })],
      meta
    );
    expect(unfold(ics)).not.toContain("BEGIN:VEVENT");
  });

  it("names them in the calendar description rather than silently omitting them", () => {
    const ics = applicationsToIcs(
      [application({ plan: "ROLLING", deadline: null })],
      meta
    );
    expect(prop(ics, "X-WR-CALDESC")).toContain("Coastal State University");
  });

  it("says nothing about rolling applications when there are none", () => {
    const ics = applicationsToIcs([application()], meta);
    expect(prop(ics, "X-WR-CALDESC")).not.toContain("Not included");
  });

  it("produces a valid, empty calendar when nothing has a date", () => {
    const ics = applicationsToIcs([application({ deadline: null })], meta);
    expect(unfold(ics)[0]).toBe("BEGIN:VCALENDAR");
    const closing = unfold(ics);
    expect(closing[closing.length - 2]).toBe("END:VCALENDAR");
  });
});

describe("escapeText", () => {
  // Without this a school named "Washington University in St. Louis, MO"
  // splits at the comma and the import truncates or fails outright.
  it("escapes the four characters RFC 5545 reserves in TEXT", () => {
    expect(escapeText("a,b")).toBe("a\\,b");
    expect(escapeText("a;b")).toBe("a\\;b");
    expect(escapeText("a\\b")).toBe("a\\\\b");
    expect(escapeText("a\nb")).toBe("a\\nb");
    expect(escapeText("a\r\nb")).toBe("a\\nb");
  });

  // Backslash has to go first, or the escapes added afterwards get escaped in
  // turn and every comma arrives as a literal backslash-comma.
  it("escapes a backslash before the characters it will introduce", () => {
    expect(escapeText("\\,")).toBe("\\\\\\,");
  });

  it("leaves a colon alone, so a URL in a note survives", () => {
    expect(escapeText("https://mit.edu")).toBe("https://mit.edu");
  });
});

describe("foldLine", () => {
  const octets = (s: string) => new TextEncoder().encode(s).length;

  it("leaves a short line alone", () => {
    expect(foldLine("SUMMARY:short")).toBe("SUMMARY:short");
  });

  it("folds a long line into continuations that start with a space", () => {
    const folded = foldLine(`DESCRIPTION:${"x".repeat(300)}`);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts.slice(1)) expect(part.startsWith(" ")).toBe(true);
    for (const part of parts) expect(octets(part)).toBeLessThanOrEqual(75);
  });

  it("rejoins to exactly the original content", () => {
    const line = `DESCRIPTION:${"abcde ".repeat(60)}`;
    const rejoined = foldLine(line)
      .split("\r\n")
      .map((p, i) => (i === 0 ? p : p.slice(1)))
      .join("");
    expect(rejoined).toBe(line);
  });

  // The limit is octets, not characters, and a fold landing mid-character
  // produces mojibake in every client that reads the file.
  it("counts octets and never splits a multi-byte character", () => {
    const line = `SUMMARY:${"é".repeat(60)}`; // 2 octets each
    const parts = foldLine(line).split("\r\n");
    for (const part of parts) {
      expect(octets(part)).toBeLessThanOrEqual(75);
      // A split character would decode to U+FFFD on the way back out.
      expect(part).not.toContain("�");
    }
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join("")).toBe(line);
  });

  it("folds real event lines to spec", () => {
    const ics = applicationsToIcs(
      [
        application({
          university: {
            id: 9,
            name: "Washington University in St. Louis, Missouri",
            shortName: "WashU",
            city: "St. Louis",
            state: "MO",
            acceptanceRate: 12,
          },
          notes: "Ask about the Danforth scholarship; the deadline is earlier than the main one.",
        }),
      ],
      meta
    );
    for (const line of ics.split("\r\n")) {
      expect(octets(line)).toBeLessThanOrEqual(75);
    }
  });
});

describe("deadlinesIcsFilename", () => {
  it("names the file after the student and the day", () => {
    expect(deadlinesIcsFilename(student(), new Date(2026, 8, 5))).toBe(
      "compass-deadlines-jordan-rivera-2026-09-05.ics"
    );
  });

  it("falls back when a name has nothing sluggable in it", () => {
    expect(deadlinesIcsFilename(student({ name: "!!!" }), new Date(2026, 8, 5))).toBe(
      "compass-deadlines-student-2026-09-05.ics"
    );
  });
});

describe("downloadIcs", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("hands over text/calendar with no BOM", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:fake");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    vi.useFakeTimers();

    let clicked: HTMLAnchorElement | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicked = this;
    });

    downloadIcs("compass-test.ics", "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");

    expect(clicked!.download).toBe("compass-test.ics");
    const blob = createObjectURL.mock.calls[0]![0];
    expect(blob.type).toBe("text/calendar;charset=utf-8");

    // The CSV path prepends a BOM for Excel. A calendar client reading UTF-8
    // per the spec has no use for one, and some choke on it.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes).startsWith("BEGIN:VCALENDAR")).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });
});
