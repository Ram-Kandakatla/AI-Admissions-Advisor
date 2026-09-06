// Turning a college list into something a student can keep.
//
// Both exports run entirely in the browser. The recommendations response
// already holds every field worth exporting, so a round trip to the server
// would only add a way for the download to fail. CSV is assembled here and
// handed over as a Blob; "Save as PDF" is the browser's own print dialog
// driven by the @media print block in global.css, which is what keeps the
// printed page in the app's type and color rather than a library's.

import type {
  Recommendation,
  RecommendationResponse,
  Scholarship,
  ScholarshipResponse,
  SchoolNote,
  StudentRecord,
  Tier,
} from "./types";

const TIER_ORDER: Tier[] = ["reach", "target", "safety"];

const TIER_LABEL: Record<Tier, string> = {
  reach: "Reach",
  target: "Target",
  safety: "Safety",
};

const HEADERS = [
  "Tier",
  "University",
  "City",
  "State",
  "Region",
  "Type",
  "Setting",
  "Match score",
  "Avg GPA",
  "Avg SAT",
  "Acceptance rate %",
  "Tuition (USD)",
  "GPA gap",
  "Affordable",
  "Region fit",
  "Matched majors",
  "Why it fits",
];

function row(uni: Recommendation): (string | number)[] {
  return [
    TIER_LABEL[uni.tier],
    uni.name,
    uni.city,
    uni.state,
    uni.region,
    uni.type ?? "",
    uni.setting ?? "",
    uni.matchScore,
    uni.avgGPA,
    uni.avgSAT,
    uni.acceptanceRate,
    uni.tuition,
    uni.gpaGap,
    uni.affordable ? "yes" : "no",
    uni.regionFit ? "yes" : "no",
    uni.matchedMajors.join("; "),
    uni.reasons.join(" · "),
  ];
}

/**
 * Escape one value for RFC 4180.
 *
 * Strings also get a leading apostrophe when they start with a character a
 * spreadsheet would read as the start of a formula. A college list is a file
 * students mail around, and `=`-prefixed text in a shared sheet is the one
 * way a plain data export can misbehave. Numbers skip the guard so figures
 * stay sortable.
 */
function cell(value: string | number): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function recommendationsToCsv(data: RecommendationResponse): string {
  const lines = [HEADERS.map(cell).join(",")];
  for (const tier of TIER_ORDER) {
    for (const uni of data.recommendations[tier]) {
      lines.push(row(uni).map(cell).join(","));
    }
  }
  // CRLF is what the spec asks for and what Excel is happiest with.
  return lines.join("\r\n");
}

// ---- Scholarships ----
//
// A separate sheet rather than more columns on the college one: the two lists
// are worked at different times, and a student pasting deadlines into a
// spreadsheet wants the awards on their own tab.

const SCHOLARSHIP_HEADERS = [
  "Tier",
  "Scholarship",
  "Sponsor",
  "Amount",
  "Renewable",
  "Awards per year",
  "Min GPA",
  "Need",
  "Effort",
  "Typical deadline",
  "Deadline is unconfirmed",
  "Deadline note",
  "Eligibility to confirm",
  "Match score",
  "Why it fits",
  "Official page",
];

function scholarshipRow(s: Scholarship): (string | number)[] {
  return [
    TIER_LABEL[s.tier],
    s.name,
    s.sponsor,
    s.amountLabel,
    s.award.renewable ? "yes" : "no",
    s.awardsPerYear ?? "",
    s.minGPA ?? "",
    s.need,
    s.effort,
    s.deadline.label,
    // Every date in this file is the program's usual month, not a date the
    // sponsor has published for this cycle. Saying so in the export matters
    // more than in the UI, because the spreadsheet outlives the page.
    "yes — confirm on the official page",
    s.deadline.note,
    s.eligibilityToConfirm.join("; "),
    s.matchScore,
    s.reasons.join(" · "),
    s.url,
  ];
}

export function scholarshipsToCsv(data: ScholarshipResponse): string {
  const lines = [SCHOLARSHIP_HEADERS.map(cell).join(",")];
  for (const tier of TIER_ORDER) {
    for (const s of data.scholarships[tier]) {
      lines.push(scholarshipRow(s).map(cell).join(","));
    }
  }
  return lines.join("\r\n");
}

// ---- Saved schools ----

const NOTE_HEADERS = [
  "Starred",
  "University",
  "City",
  "State",
  "Region",
  "Acceptance rate %",
  "Tuition (USD)",
  "Admissions officer",
  "Their role",
  "Your note",
  "Last written",
];

export function notesToCsv(rows: SchoolNote[]): string {
  const lines = [NOTE_HEADERS.map(cell).join(",")];
  for (const row of rows) {
    const u = row.university;
    lines.push(
      [
        row.starred ? "yes" : "no",
        u?.name ?? `University ${row.universityId}`,
        u?.city ?? "",
        u?.state ?? "",
        u?.region ?? "",
        u?.acceptanceRate ?? "",
        u?.tuition ?? "",
        row.contactName,
        row.contactRole,
        row.note,
        // Date only: the time of day you typed a note is noise in a sheet.
        (row.updatedAt ?? row.createdAt ?? "").slice(0, 10),
      ]
        .map(cell)
        .join(",")
    );
  }
  return lines.join("\r\n");
}

/**
 * "Ada Lovelace" → "ada-lovelace"; empty or punctuation-only names fall back.
 *
 * Exported since Phase 6 so calendar.ts names its .ics the same way — every
 * file Compass hands over should look like it came from the same app. Not to
 * be confused with slugifyMajor() in slug.ts, which builds URL segments; this
 * one only ever builds filenames.
 */
export function filenameSlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "student";
}

export function filenameStamp(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`;
}

export function csvFilename(student: StudentRecord, now = new Date()): string {
  return `compass-college-list-${filenameSlug(student.name)}-${filenameStamp(now)}.csv`;
}

export function scholarshipCsvFilename(student: StudentRecord, now = new Date()): string {
  return `compass-scholarships-${filenameSlug(student.name)}-${filenameStamp(now)}.csv`;
}

export function savedCsvFilename(student: StudentRecord, now = new Date()): string {
  return `compass-saved-schools-${filenameSlug(student.name)}-${filenameStamp(now)}.csv`;
}

/**
 * Hand a generated file to the browser's download machinery.
 *
 * Split out of downloadCsv in Phase 6 so the .ics export shares one
 * implementation of this rather than growing a second one that forgets the
 * Safari note below. The BOM stays in downloadCsv, where it belongs — it is
 * an Excel workaround, not a property of downloading a file.
 */
export function downloadFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Safari reads the blob asynchronously after click(); revoking in the same
  // tick cancels the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Download a CSV.
 *
 * The BOM is there for Excel, which otherwise reads a UTF-8 CSV as the local
 * codepage and mangles any school name with an accent in it.
 */
export function downloadCsv(filename: string, csv: string): void {
  downloadFile(filename, `﻿${csv}`, "text/csv;charset=utf-8");
}
