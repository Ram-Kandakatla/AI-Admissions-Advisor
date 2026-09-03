import { afterEach, describe, expect, it, vi } from "vitest";
import {
  csvFilename,
  downloadCsv,
  notesToCsv,
  recommendationsToCsv,
  savedCsvFilename,
  scholarshipCsvFilename,
  scholarshipsToCsv,
} from "./exportList";
import {
  recommendation,
  recommendationResponse,
  scholarship,
  scholarshipResponse,
  schoolNote,
  student,
} from "./test/factories";

/** Split on the CRLF the exporter is specified to emit, not on any newline. */
function rows(csv: string): string[] {
  return csv.split("\r\n");
}

/** The last column of a record. Written out rather than `.at(-1)`, which the
 *  app's ES2020 lib target does not have. */
function lastCell(row: string): string {
  const cells = row.split(",");
  return cells[cells.length - 1]!;
}

describe("recommendationsToCsv", () => {
  it("emits a header even when nothing matched", () => {
    const csv = recommendationsToCsv(recommendationResponse());
    expect(rows(csv)).toHaveLength(1);
    expect(rows(csv)[0]).toMatch(/^Tier,University,City,State,Region,Type,Setting,Match score,/);
  });

  it("writes reach, then target, then safety", () => {
    // A student reads this list top-down as an ambition ladder. Object key
    // order is not a guarantee, so the exporter walks an explicit tier order.
    const csv = recommendationsToCsv(
      recommendationResponse({
        safety: [recommendation({ tier: "safety", name: "Safety U" })],
        reach: [recommendation({ tier: "reach", name: "Reach U" })],
        target: [recommendation({ tier: "target", name: "Target U" })],
      })
    );
    expect(rows(csv).slice(1).map((r) => r.split(",")[1])).toEqual([
      "Reach U",
      "Target U",
      "Safety U",
    ]);
  });

  it("separates records with CRLF, as RFC 4180 asks", () => {
    const csv = recommendationsToCsv(
      recommendationResponse({ target: [recommendation()] })
    );
    expect(csv).toContain("\r\n");
    expect(csv.split("\n").every((line) => line === "" || !line.endsWith("\r\r"))).toBe(true);
  });

  it("renders booleans as yes/no and joins the list columns", () => {
    const csv = recommendationsToCsv(
      recommendationResponse({
        target: [
          recommendation({
            affordable: false,
            regionFit: true,
            matchedMajors: ["CS", "Data Science"],
            reasons: ["Strong CS", "In your region"],
          }),
        ],
      })
    );
    const row = rows(csv)[1]!;
    expect(row).toContain(",no,yes,");
    expect(row).toContain("CS; Data Science");
    expect(row).toContain("Strong CS · In your region");
  });

  it("quotes a value containing a comma and doubles embedded quotes", () => {
    const csv = recommendationsToCsv(
      recommendationResponse({
        target: [recommendation({ name: 'Smith, Jones & Co "Tech"' })],
      })
    );
    expect(rows(csv)[1]).toContain('"Smith, Jones & Co ""Tech"""');
  });

  it("quotes a value containing a newline so the row stays one record", () => {
    const csv = recommendationsToCsv(
      recommendationResponse({ target: [recommendation({ reasons: ["line one\nline two"] })] })
    );
    expect(csv).toContain('"line one\nline two"');
    // Still one header + one record, despite the newline inside a field.
    expect(rows(csv)).toHaveLength(2);
  });

  it("defuses a value a spreadsheet would run as a formula", () => {
    // The file is meant to be mailed around. `=`-prefixed text in a shared
    // sheet is the one way a plain data export can misbehave.
    const csv = recommendationsToCsv(
      recommendationResponse({
        target: [
          recommendation({
            name: "=HYPERLINK(\"http://evil\",\"click\")",
            reasons: ["@SUM(A1:A9)", "+1 for research", "-see notes"],
          }),
        ],
      })
    );
    const row = rows(csv)[1]!;
    expect(row).toContain("'=HYPERLINK");
    expect(row).toContain("'@SUM(A1:A9) · +1 for research · -see notes");
  });

  it("leaves numbers unguarded so figures stay sortable", () => {
    // gpaGap is negative when the school's average is above the student's.
    // A leading apostrophe here would turn every such cell into text and
    // break sorting on the column that matters most.
    const csv = recommendationsToCsv(
      recommendationResponse({ target: [recommendation({ gpaGap: -0.3, matchScore: 64 })] })
    );
    const cells = rows(csv)[1]!.split(",");
    expect(cells).toContain("-0.3");
    expect(cells).toContain("64");
    expect(rows(csv)[1]).not.toContain("'-0.3");
  });

  it("writes an empty cell for a number that isn't finite", () => {
    const csv = recommendationsToCsv(
      recommendationResponse({ target: [recommendation({ matchScore: NaN })] })
    );
    expect(rows(csv)[1]!.split(",")[7]).toBe("");
  });

  it("tolerates a school with no type or setting", () => {
    const csv = recommendationsToCsv(
      recommendationResponse({
        target: [recommendation({ type: undefined, setting: undefined })],
      })
    );
    expect(rows(csv)[1]!.split(",").slice(5, 7)).toEqual(["", ""]);
  });
});

describe("scholarshipsToCsv", () => {
  it("says every deadline is unconfirmed, on every row", () => {
    // The dataset holds the program's usual month, never a date the sponsor
    // has published for this cycle. The spreadsheet outlives the page that
    // explains that, so the caveat has to travel with the data.
    const csv = scholarshipsToCsv(
      scholarshipResponse({
        reach: [scholarship({ tier: "reach", name: "Big Award" })],
        target: [scholarship({ tier: "target", name: "Mid Award" })],
      })
    );
    const records = rows(csv).slice(1);
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r).toContain("yes — confirm on the official page");
    }
  });

  it("keeps the award's own fields, including a blank optional one", () => {
    const csv = scholarshipsToCsv(
      scholarshipResponse({
        target: [scholarship({ awardsPerYear: null, minGPA: null, url: "https://example.edu/x" })],
      })
    );
    const row = rows(csv)[1]!;
    expect(row).toContain("Coastal Merit Award");
    expect(row).toContain("https://example.edu/x");
    expect(row).toContain(",yes,,,"); // renewable, then two empty optionals
  });

  it("is a separate sheet from the college list", () => {
    const header = rows(scholarshipsToCsv(scholarshipResponse()))[0]!;
    expect(header).toContain("Sponsor");
    expect(header).toContain("Official page");
    expect(header).not.toContain("Avg GPA");
  });
});

describe("notesToCsv", () => {
  it("writes the school's details when it knows them", () => {
    const csv = notesToCsv([schoolNote()]);
    const row = rows(csv)[1]!;
    expect(row).toContain("Coastal State University");
    expect(row).toContain("Monterey");
    expect(row).toMatch(/^yes,/);
  });

  it("falls back to the id when the school didn't come back with the note", () => {
    const csv = notesToCsv([schoolNote({ universityId: 42, university: null })]);
    expect(rows(csv)[1]).toContain("University 42");
  });

  it("keeps the date and drops the time", () => {
    const csv = notesToCsv([schoolNote({ updatedAt: "2026-10-09T18:05:00.000Z" })]);
    expect(lastCell(rows(csv)[1]!)).toBe("2026-10-09");
  });

  it("falls back to createdAt, then to blank", () => {
    expect(
      lastCell(rows(notesToCsv([schoolNote({ updatedAt: undefined, createdAt: "2026-10-02T14:20:00.000Z" })]))[1]!)
    ).toBe("2026-10-02");
    expect(
      lastCell(rows(notesToCsv([schoolNote({ updatedAt: undefined, createdAt: undefined })]))[1]!)
    ).toBe("");
  });
});

describe("filenames", () => {
  const now = new Date(2026, 8, 5); // 5 Sep 2026 — single-digit month and day

  it("slugs the student's name and zero-pads the date", () => {
    expect(csvFilename(student({ name: "Ada Lovelace" }), now)).toBe(
      "compass-college-list-ada-lovelace-2026-09-05.csv"
    );
  });

  it("collapses punctuation and trims stray hyphens", () => {
    expect(csvFilename(student({ name: "  Ana-María O'Brien Jr. " }), now)).toBe(
      "compass-college-list-ana-mar-a-o-brien-jr-2026-09-05.csv"
    );
  });

  it("falls back rather than producing a nameless file", () => {
    expect(csvFilename(student({ name: "!!!" }), now)).toBe(
      "compass-college-list-student-2026-09-05.csv"
    );
  });

  it("names each export distinctly", () => {
    const s = student({ name: "Ada Lovelace" });
    expect(scholarshipCsvFilename(s, now)).toContain("compass-scholarships-");
    expect(savedCsvFilename(s, now)).toContain("compass-saved-schools-");
  });
});

describe("downloadCsv", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("hands the browser a UTF-8 CSV with a BOM, then cleans up after itself", async () => {
    // jsdom implements neither of these; without the BOM assertion the Excel
    // mojibake bug the prefix exists to prevent would be untestable.
    const createObjectURL = vi.fn((_blob: Blob) => "blob:fake");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    vi.useFakeTimers();

    let clicked: HTMLAnchorElement | null = null;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked = this;
      });

    downloadCsv("compass-test.csv", "a,b\r\n1,2");

    expect(clickSpy).toHaveBeenCalledOnce();
    expect(clicked!.download).toBe("compass-test.csv");
    expect(clicked!.href).toBe("blob:fake");
    // The link is removed synchronously, so it never shows up in the layout.
    expect(document.querySelector("a")).toBeNull();

    const blob = createObjectURL.mock.calls[0]![0];
    expect(blob.type).toBe("text/csv;charset=utf-8");
    // Asserted as bytes, not via blob.text(): the Blob text decoder strips a
    // BOM per spec, so it would report a pass whether the prefix is there or
    // not — and bytes on disk are exactly what Excel is reading.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes.slice(3))).toBe("a,b\r\n1,2");

    // Safari reads the blob asynchronously after click(); revoking in the same
    // tick cancels the download.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });
});
