// Client-side exports. CSV is built here; "Save as PDF" is window.print()
// styled by the @media print block in global.css.

import type {
  Recommendation,
  RecommendationResponse,
  Scholarship,
  ScholarshipResponse,
  SchoolNote,
  StudentRecord,
} from "./types";
import { TIER_LABEL, TIER_ORDER } from "./tiers";

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
    // A saved CSV outlives the page it came from, so the estimate marker has to
    // travel in the value itself — there is no tooltip in a spreadsheet.
    uni.gpaSource?.startsWith("estimated") ? `${uni.avgGPA} (est)` : uni.avgGPA,
    // Test-blind schools have no SAT average; say so rather than leaving a blank
    // cell that reads as a gap in the export.
    uni.avgSAT ?? "test-blind",
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
 * RFC 4180, plus a leading apostrophe on strings a spreadsheet would run as a
 * formula (CSV injection). Numbers skip it so they stay sortable.
 */
function cell(value: string | number): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Says what the API's per-tier cap left out, so the file doesn't pass as complete. */
function truncationNote(data: RecommendationResponse): string {
  const trimmed = TIER_ORDER.filter(
    (tier) => data.recommendations[tier].length < data.counts[tier]
  );
  if (trimmed.length === 0) return "";
  const parts = trimmed.map(
    (tier) =>
      `${data.recommendations[tier].length} of ${data.counts[tier]} ${TIER_LABEL[tier].toLowerCase()}`
  );
  return `This export holds the strongest matches, not all of them: ${parts.join(", ")}. Open Compass to browse every school.`;
}

export function recommendationsToCsv(data: RecommendationResponse): string {
  const lines = [HEADERS.map(cell).join(",")];
  for (const tier of TIER_ORDER) {
    for (const uni of data.recommendations[tier]) {
      lines.push(row(uni).map(cell).join(","));
    }
  }
  const note = truncationNote(data);
  // After a blank line, so the rows above stay a clean rectangle that sorts and
  // filters like any other sheet.
  if (note) lines.push("", cell(note));
  // CRLF is what the spec asks for and what Excel is happiest with.
  return lines.join("\r\n");
}

// ---- Scholarships ----

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

/** For filenames (shared with calendar.ts); slugifyMajor is for URLs. */
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

/** The BOM stops Excel reading UTF-8 as the local codepage and mangling accents. */
export function downloadCsv(filename: string, csv: string): void {
  downloadFile(filename, `﻿${csv}`, "text/csv;charset=utf-8");
}
