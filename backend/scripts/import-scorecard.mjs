#!/usr/bin/env node
// Rebuilds backend/data/universities.json from the U.S. Department of Education's
// College Scorecard institution file.
//
//   npm run data:import -- --csv ~/Downloads/Most-Recent-Cohorts-Institution.csv
//
// Why a generated file rather than a live API call: the dataset is imported into
// the Worker bundle at build time (see src/store/staticData.ts — a Worker has no
// filesystem), so the data has to be *in the repo*. Scorecard also updates about
// once a year, which makes a request-time fetch all cost and no freshness.
//
// The 42 hand-curated schools are preserved byte-for-byte. They are matched by
// UNITID, never by name: an earlier attempt at fuzzy name matching paired Georgia
// Tech with *Florida* Tech, Columbia with *Carolina University*, and — because
// normalising away "University"/"College" makes them identical strings — Boston
// University with Boston College. Hence CURATED_UNITIDS below, which is
// hand-verified and is the only trustworthy join key here.
//
// Source: https://collegescorecard.ed.gov/data/ (public domain, U.S. federal data)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, "../data/universities.json");

// ---------------------------------------------------------------------------
// Selection rules
// ---------------------------------------------------------------------------

/**
 * Why not a plain enrollment floor: it is the wrong knife. `UGDS >= 2000` alone
 * drops Swarthmore, Pomona and Harvey Mudd — schools a college advisor exists to
 * surface — while keeping every large regional campus. So a school qualifies by
 * being *either* big enough to be a realistic destination for many students, or
 * selective enough to be worth naming regardless of size.
 */
const DEFAULTS = {
  minEnrollment: 2000,
  maxAdmitRate: 0.35,
  majorThreshold: 0.005, // ≥0.5% of degrees awarded in a CIP family
  maxMajors: 8,
};

// ---------------------------------------------------------------------------
// GPA estimation
// ---------------------------------------------------------------------------

/**
 * Scorecard carries no GPA — neither does IPEDS. Only each school's Common Data
 * Set (item C12) reports one, and those are PDFs, frequently left blank, and
 * ambiguous about weighting. So every imported school's GPA is ESTIMATED from its
 * SAT average and tagged `gpaSource: "estimated"`, which is what lets the UI keep
 * an inferred number visually distinct from a reported one.
 *
 * Why a hand-anchored curve and not a regression: a least-squares fit on the 42
 * curated schools scores well in-domain (R²=0.69 on SAT alone, 0.76 adding
 * ln(admit rate)) but those 42 all sit between SAT 1220 and 1545. Extrapolated
 * down to an open-access school it predicts a 3.19 (SAT-only) or 3.49 (two-var)
 * average admit GPA, which is plainly wrong — the two-variable model is the worse
 * extrapolator precisely because it fit the narrow band better.
 *
 * The error direction matters more than its size: classifyTier() sends anything
 * with gpaGap >= 0.15 to "reach", so an inflated GPA at the low end turns a
 * genuine safety into a target and quietly costs a student their safety schools.
 * These anchors are therefore deliberately conservative below 1200.
 *
 * Validated against the 42 curated schools: bias -0.016, RMSE 0.090. Below SAT
 * 1220 there is no validation data, and the numbers there are domain judgement.
 * Tune this table, not the call sites.
 */
const GPA_ANCHORS = [
  [800, 2.6],
  [950, 2.9],
  [1050, 3.1],
  [1150, 3.3],
  [1250, 3.52],
  [1350, 3.7],
  [1450, 3.84],
  [1550, 3.95],
];

/** Piecewise-linear interpolation over an ascending anchor table, clamped at both ends. */
function interpolate(anchors, x) {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 0; i < anchors.length - 1; i++) {
    const [x0, y0] = anchors[i];
    const [x1, y1] = anchors[i + 1];
    if (x >= x0 && x <= x1) return round(y0 + ((y1 - y0) * (x - x0)) / (x1 - x0), 2);
  }
  return last[1];
}

function estimateGpa(sat) {
  return interpolate(GPA_ANCHORS, sat);
}

/**
 * GPA anchors for schools that report no SAT at all, keyed on admission rate.
 *
 * These exist because a whole state does not report SAT: California is test-blind,
 * so the UC and CSU systems and Caltech carry no SAT average and were invisible to
 * an SAT-keyed filter. Admission rate is the only academic signal left for them.
 *
 * Critically, these anchors are NOT fitted to the 42 curated schools. Fitting them
 * there bottoms the curve out at 3.42 for an open-admission school, because every
 * curated school is selective — while the SAT curve gives ~2.90 for a comparable
 * one. That would hand two similar schools very different GPAs based only on
 * whether they happen to report SAT, which is an artefact of our own pipeline.
 *
 * Instead they are the *observed median* SAT-derived GPA per admit-rate band across
 * the schools that do report SAT, so both paths agree at the population level.
 * Smoothed to be monotonic: the raw 50-60% band inverts against 60-70% on a sample
 * of 35 against 66.
 *
 * Accuracy is materially worse than the SAT path — RMSE 0.222 against the imported
 * population, versus 0.090 for GPA_ANCHORS. Admit rate conflates a selective school
 * that admits many strong applicants with an open-access one. Hence the separate
 * `gpaSource` value, so the difference is visible rather than averaged away.
 */
const ADMIT_GPA_ANCHORS = [
  [5, 3.93],
  [15, 3.87],
  [25, 3.79],
  [35, 3.72],
  [45, 3.62],
  [55, 3.52],
  [65, 3.45],
  [75, 3.37],
  [85, 3.3],
  [95, 3.18],
];

/** GPA for a school with no SAT average, from its admission rate (percent). */
function estimateGpaFromAdmitRate(admitPercent) {
  return interpolate(ADMIT_GPA_ANCHORS, admitPercent);
}

// ---------------------------------------------------------------------------
// Field mappings
// ---------------------------------------------------------------------------

/**
 * Census Bureau regions, keyed by state.
 *
 * Deliberately NOT Scorecard's own REGION column: that column puts Arizona and
 * Texas in one bucket ("Southwest"), while the curated data — correctly, and
 * following Census — calls Arizona West and Texas South. Checked against all 42
 * curated rows: 41 agree. The one exception is Maryland, hand-classed Northeast
 * here but South by Census; the curated value is preserved rather than "fixed",
 * since it is a judgement call about a Mid-Atlantic school, not an error.
 */
const CENSUS_REGION = {};
for (const s of "CT ME MA NH RI VT NJ NY PA".split(" ")) CENSUS_REGION[s] = "Northeast";
for (const s of "IL IN MI OH WI IA KS MN MO NE ND SD".split(" ")) CENSUS_REGION[s] = "Midwest";
for (const s of "DE FL GA MD NC SC VA DC WV AL KY MS TN AR LA OK TX".split(" ")) CENSUS_REGION[s] = "South";
for (const s of "AZ CO ID MT NV NM UT WY AK CA HI OR WA".split(" ")) CENSUS_REGION[s] = "West";

/**
 * IPEDS locale code → the `setting` vocabulary.
 *
 * Note this is coarser than the curated data: LOCALE cannot tell MIT (12, "Urban"
 * by hand) from Michigan (also 12, "College Town" by hand), because whether a
 * school *dominates* its town is a human judgement no federal column encodes. New
 * rows therefore classify mechanically — a Town locale becomes "College Town" —
 * while the curated 42 keep their hand-set values. "Rural" is a new value, safe to
 * add because `setting` is display-only (SchoolCompare, MajorDeepDive, CSV export)
 * and is not a filter with a hardcoded option list.
 */
function settingFor(locale) {
  const n = Number(locale);
  if (n >= 11 && n <= 13) return "Urban";
  if (n >= 21 && n <= 23) return "Suburban";
  if (n >= 31 && n <= 33) return "College Town";
  if (n >= 41 && n <= 43) return "Rural";
  return "Urban";
}

/**
 * CIP 2-digit family → majors in Compass's existing 22-major vocabulary.
 *
 * Constraining the output to that vocabulary is the whole point. `knownMajors()`
 * is derived from this file and feeds BOTH the profile form's dropdown and
 * validateProfile()'s allowlist, so letting 600 schools introduce raw CIP labels
 * would blow up the form and the validator together.
 *
 * The mapping is necessarily lossy — CIP's 2-digit families are coarser than the
 * vocabulary. Physics and Chemistry share family 40; Economics and Political
 * Science share 45; Business and Finance share 52. A school with any of family 40
 * is credited with both Physics and Chemistry, which is nearly always true at
 * bachelor's-granting institutions and is the best this data supports.
 *
 * Pre-Med and Pre-Law are tracks, not CIP fields, and are proxied by Biology (26)
 * and Social Sciences (45) respectively — the majors those tracks are actually
 * taken through. Data Science has no 2-digit family at all and is credited only
 * where a school has both Computer Science (11) and Mathematics/Statistics (27).
 */
const CIP_TO_MAJORS = {
  PCIP01: ["Agriculture"],
  PCIP03: ["Environmental Science"],
  PCIP09: ["Communications"],
  PCIP11: ["CS"],
  PCIP13: ["Education"],
  PCIP14: ["Engineering"],
  PCIP23: ["English"],
  PCIP26: ["Biology", "Pre-Med"],
  PCIP27: ["Math"],
  PCIP40: ["Physics", "Chemistry"],
  PCIP42: ["Psychology"],
  PCIP45: ["Economics", "Political Science", "Pre-Law"],
  PCIP50: ["Art"],
  PCIP51: ["Nursing"],
  PCIP52: ["Business", "Finance"],
  PCIP54: ["History"],
};

/**
 * Why the list is capped rather than "everything above the threshold": the two
 * sources mean different things. A curated list is ~6 *notable* programs; a CIP
 * list is every field the school grants any degree in, which runs to 20. That
 * asymmetry is not cosmetic — evaluate() scores `min(matchedMajors, 3) * 4`, so
 * uncapped imports would systematically out-score the curated schools on major
 * fit. Ranking by share of degrees awarded and keeping the top few approximates
 * "what this school is known for", which is what the curated lists encode.
 */
function majorsFor(readColumn, threshold, cap) {
  const scored = new Map();
  for (const [col, majors] of Object.entries(CIP_TO_MAJORS)) {
    const p = numberOrNull(readColumn(col));
    if (p === null || p < threshold) continue;
    for (const m of majors) scored.set(m, Math.max(scored.get(m) ?? 0, p));
  }
  const cs = numberOrNull(readColumn("PCIP11"));
  const math = numberOrNull(readColumn("PCIP27"));
  if (cs !== null && math !== null && cs >= threshold && math >= threshold) {
    scored.set("Data Science", Math.min(cs, math));
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([m]) => m);
}

/**
 * IPEDS suffixes that name a campus rather than the school students say.
 *
 * The separator is optional because IPEDS is not consistent about it: Ohio State
 * is "Ohio State University-Main Campus" but Arizona State is "Arizona State
 * University Campus Immersion", with a space. Requiring the hyphen silently left
 * "Campus Immersion" in the display name.
 */
const NAME_NOISE = /\s*-?\s*(Main Campus|Campus Immersion)$/i;

function cleanName(instnm) {
  return instnm.replace(NAME_NOISE, "").trim();
}

/**
 * A display abbreviation. Purely cosmetic — nothing joins on it — so the rules
 * stay simple and fall back to the full name rather than inventing an acronym
 * nobody uses.
 */
/**
 * Multi-campus systems whose colloquial abbreviation no rule can derive.
 *
 * The generic reductions below turn "University of California-Davis" into
 * "California-Davis", which nobody says, and leave "California State
 * University-Bakersfield" untouched because it does not *end* in "State
 * University". Between them that is 21 schools in the two largest public systems
 * in the country, and a student searching "UC Davis" should find UC Davis.
 *
 * This is a display-only lookup, not a join key — nothing breaks if a system is
 * missing, the name just stays long. Add entries as they prove worth it.
 */
const SYSTEM_PREFIXES = [
  [/^University of California-(.+)$/i, "UC "],
  [/^California State University-(.+)$/i, "Cal State "],
  [/^State University of New York (?:at |College at )?(.+)$/i, "SUNY "],
];

function shortNameFor(name) {
  const s = name.replace(/^The\s+/i, "").trim();
  for (const [re, prefix] of SYSTEM_PREFIXES) {
    const m = s.match(re);
    if (m) return `${prefix}${m[1].trim()}`;
  }
  // Ordered most specific first: "X State University" has to be tried before the
  // bare "X University" rule, or Bridgewater State becomes "Bridgewater State"
  // via the wrong branch and Ohio State becomes "Ohio".
  const rules = [
    [/^(.+?) State University$/i, (m) => `${m[1]} State`],
    [/^University of (.+)$/i, (m) => m[1]],
    [/^(.+?) University$/i, (m) => m[1]],
    [/^(.+?) College$/i, (m) => m[1]],
  ];
  for (const [re, build] of rules) {
    const m = s.match(re);
    if (!m) continue;
    const candidate = build(m).trim();
    // A reduction that leaves almost nothing ("Union", "Trinity") is still fine —
    // it is what people say. One that leaves a fragment longer than the original
    // is not a reduction at all.
    if (candidate.length > 0 && candidate.length < s.length) return candidate;
  }
  // Deliberately no ellipsis truncation: "Washington University in St…" is worse
  // than the full name, and shortName is display-only so length is a layout
  // problem, not a data one.
  return s;
}

/**
 * ADMCON7 is the admission-test requirement. It matters here because SAT_AVG is
 * computed over *submitters only*, so at a test-optional school the average is
 * biased upward relative to the class as a whole — and every GPA in this import
 * is derived from that average. Carrying the flag lets the UI say so instead of
 * presenting a submitter-only average as the whole story.
 */
function testPolicyFor(admcon7) {
  switch (String(admcon7).trim()) {
    case "1":
      return "required";
    case "2":
      return "recommended";
    case "3":
      return "not-used";
    case "5":
      return "optional";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Curated schools
// ---------------------------------------------------------------------------

/**
 * shortName → UNITID for the 42 hand-curated schools. Hand-written and verified
 * against the CSV by exact institution name, with city/state agreement as a
 * cross-check (42/42 matched, 0 state mismatches).
 *
 * This exists so a re-import does not duplicate a curated school under its
 * federal id. It is also why curated ids 1-42 stay put: `school_notes` and
 * `applications` both hold `university_id` in D1, so renumbering would silently
 * repoint a student's saved notes at a different school.
 */
const CURATED_UNITIDS = {
  MIT: 166683,
  Stanford: 243744,
  CMU: 211440,
  "UC Berkeley": 110635,
  UCLA: 110662,
  "Georgia Tech": 139755,
  Michigan: 170976,
  UIUC: 145637,
  "UT Austin": 228778,
  Harvard: 166027,
  Princeton: 186131,
  Yale: 130794,
  Cornell: 190415,
  Columbia: 190150,
  UW: 236948,
  "UW-Madison": 240444,
  NYU: 193900,
  BU: 164988,
  USC: 123961,
  UNC: 199120,
  Purdue: 243780,
  "Ohio State": 204796,
  "Penn State": 214777,
  UF: 134130,
  ASU: 104151,
  Arizona: 104179,
  "Michigan State": 171100,
  "CU Boulder": 126614,
  Maryland: 163286,
  Northeastern: 167358,
  UVA: 234076,
  "UC San Diego": 110680,
  "UC Irvine": 110653,
  Rutgers: 186380,
  Indiana: 151351,
  Minnesota: 174066,
  "Texas A&M": 228723,
  SDSU: 122409,
  FSU: 134097,
  Pitt: 215293,
  Oregon: 209551,
  Temple: 216339,
};

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * A minimal RFC 4180 reader. Hand-written because the repo's zero-dependency rule
 * applies to scripts too, and because this needs exactly one feature a split(",")
 * lacks: quoted fields. Institution names contain commas ("Saint Joseph's College,
 * Long Island"), and splitting naively shifts every later column by one — which
 * would not throw, it would just silently mis-assign tuition and SAT.
 *
 * Yields plain arrays; the caller maps them onto header indices. The file is ~100MB
 * and read whole, which Node handles comfortably and keeps this simple.
 */
function* parseCsv(text) {
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      yield row;
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    yield row;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function numberOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  // Scorecard uses both an empty cell and the literal "NULL" for missing data,
  // and Number("") is 0 — which would read as a real zero tuition or admit rate.
  if (s === "" || s.toUpperCase() === "NULL" || s === "PS") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function parseArgs(argv) {
  const args = { ...DEFAULTS, out: DEFAULT_OUT, csv: null, limit: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--csv") args.csv = next();
    else if (a === "--out") args.out = next();
    else if (a === "--limit") args.limit = Number(next());
    else if (a === "--min-enrollment") args.minEnrollment = Number(next());
    else if (a === "--max-admit-rate") args.maxAdmitRate = Number(next());
    else if (a === "--max-majors") args.maxMajors = Number(next());
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const USAGE = `
Rebuild backend/data/universities.json from the College Scorecard institution file.

  node scripts/import-scorecard.mjs --csv <path> [options]

Get the CSV from https://collegescorecard.ed.gov/data/ — the "Most Recent
Institution-Level Data" zip (~23MB, expands to ~100MB).

Options:
  --csv <path>            Scorecard institution CSV (required)
  --out <path>            Output file (default: backend/data/universities.json)
  --limit <n>             Keep at most n imported schools, most selective first
  --min-enrollment <n>    Undergrad floor for the size rule (default 2000)
  --max-admit-rate <r>    Admit rate that qualifies regardless of size (default 0.35)
  --max-majors <n>        Cap on derived majors per school (default 8)
  --dry-run               Report what would change; write nothing
`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.csv) {
    console.log(USAGE.trim());
    process.exit(args.help ? 0 : 1);
  }

  const existing = JSON.parse(readFileSync(args.out, "utf8"));
  // Anything not previously imported is curated. Matched by prefix so the
  // estimated-sat / estimated-admit split does not need a list kept in sync
  // here, and so a first run (where no row has gpaSource at all) still works.
  const curated = existing.filter((u) => !String(u.gpaSource ?? "").startsWith("estimated"));
  if (curated.length === 0) throw new Error("No curated schools found — refusing to overwrite.");

  // Re-attach the federal id to the curated rows so they can be de-duplicated
  // against the feed, and tag their GPAs as reported rather than derived.
  const curatedByUnitid = new Map();
  for (const u of curated) {
    const unitid = CURATED_UNITIDS[u.shortName];
    if (!unitid) throw new Error(`Curated school has no UNITID mapping: ${u.shortName}`);
    u.unitid = unitid;
    u.gpaSource = "curated";
    curatedByUnitid.set(unitid, u);
  }

  const text = readFileSync(args.csv, "utf8");
  const reader = parseCsv(text);
  const header = reader.next().value;
  if (!header) throw new Error("CSV appears to be empty");
  // The header can carry a UTF-8 BOM, which would make the first column name
  // "﻿UNITID" and every lookup of UNITID miss.
  header[0] = header[0].replace(/^﻿/, "");
  const idx = new Map(header.map((h, i) => [h, i]));
  const need = [
    "UNITID", "INSTNM", "CITY", "STABBR", "LOCALE", "CONTROL", "PREDDEG",
    "CURROPER", "MAIN", "ADM_RATE", "SAT_AVG", "TUITIONFEE_IN", "TUITIONFEE_OUT",
    "UGDS", "ADMCON7",
    // The CIP columns are checked too because their absence does not throw — it
    // reads as "this school teaches nothing", which silently drops every row on
    // the no-majors gate and reports a successful import of zero schools.
    ...Object.keys(CIP_TO_MAJORS),
  ];
  for (const col of need) {
    if (!idx.has(col)) throw new Error(`CSV is missing expected column: ${col}`);
  }
  const get = (row, col) => row[idx.get(col)];

  const stats = { rows: 0, pool: 0, selected: 0, replacedCurated: 0, noMajors: 0, noSat: 0 };
  const imported = [];

  for (const row of reader) {
    if (row.length < header.length) continue; // trailing blank line
    stats.rows++;

    // Quality gates. Each one is a decision about what belongs in a college list:
    // open (not closed), a main campus (not a satellite duplicating its parent),
    // predominantly bachelor's-granting, and not for-profit — the last excluded
    // outright rather than surfaced and caveated.
    if (get(row, "CURROPER") !== "1") continue;
    if (get(row, "MAIN") !== "1") continue;
    if (get(row, "PREDDEG") !== "3") continue;
    const control = get(row, "CONTROL");
    if (control !== "1" && control !== "2") continue;

    const sat = numberOrNull(get(row, "SAT_AVG"));
    const admitRate = numberOrNull(get(row, "ADM_RATE"));
    // Out-of-state is the right sticker price for a national list, and matches
    // what the curated rows already used (verified: UF 28658 vs 28659 here).
    const tuition = numberOrNull(get(row, "TUITIONFEE_OUT")) ?? numberOrNull(get(row, "TUITIONFEE_IN"));
    // SAT is deliberately NOT required. Requiring it silently excluded every
    // test-blind school, which is all of the UC and CSU systems plus Caltech —
    // 87 of California's 114 bachelor's-granting schools. Admission rate is the
    // floor: without it there is no academic signal at all.
    if (admitRate === null || tuition === null) continue;
    stats.pool++;
    if (sat === null) stats.noSat++;

    const enrollment = numberOrNull(get(row, "UGDS")) ?? 0;
    if (!(enrollment >= args.minEnrollment || admitRate <= args.maxAdmitRate)) continue;

    const state = get(row, "STABBR");
    const region = CENSUS_REGION[state];
    if (!region) continue; // territories: no region bucket, and out of scope

    const majors = majorsFor((col) => get(row, col), args.majorThreshold, args.maxMajors);
    if (majors.length === 0) {
      // evaluate() treats "offers an intended major" as a hard requirement, so a
      // school with no derived majors can never be recommended — it would be dead
      // weight in the bundle and a confusing blank row in the explorer.
      stats.noMajors++;
      continue;
    }

    const unitid = Number(get(row, "UNITID"));
    const name = cleanName(get(row, "INSTNM"));

    imported.push({
      id: unitid,
      unitid,
      name,
      shortName: shortNameFor(name),
      // A test-blind school's avgSAT is null because that is the truth — it does
      // not have one, rather than having one we failed to find. Inventing a
      // number here would also feed the engine a test score for a school that
      // does not look at test scores.
      avgGPA: sat === null ? estimateGpaFromAdmitRate(admitRate * 100) : estimateGpa(sat),
      gpaSource: sat === null ? "estimated-admit" : "estimated-sat",
      avgSAT: sat === null ? null : Math.round(sat),
      majors,
      acceptanceRate: round(admitRate * 100, 1),
      tuition: Math.round(tuition),
      region,
      city: get(row, "CITY"),
      state,
      setting: settingFor(get(row, "LOCALE")),
      type: control === "1" ? "Public" : "Private",
      testPolicy: testPolicyFor(get(row, "ADMCON7")),
      enrollment: Math.round(enrollment),
    });
  }

  // Most selective first, so --limit cuts the least distinctive schools rather
  // than an arbitrary alphabetical tail.
  imported.sort((a, b) => a.acceptanceRate - b.acceptanceRate || a.name.localeCompare(b.name));

  const kept = [];
  for (const school of imported) {
    const curatedMatch = curatedByUnitid.get(school.unitid);
    if (curatedMatch) {
      // The hand-written row wins on every field. Only enrollment and test policy
      // are adopted, since the curated data never had them.
      curatedMatch.enrollment ??= school.enrollment;
      curatedMatch.testPolicy ??= school.testPolicy;
      stats.replacedCurated++;
      continue;
    }
    if (args.limit !== null && kept.length >= args.limit) break;
    kept.push(school);
  }
  stats.selected = kept.length;

  const out = [...curated, ...kept];

  // Two unrelated schools can share a name — there is a University of St Thomas
  // in both Minnesota and Texas. They are distinct rows with distinct federal
  // ids, so nothing is broken in the data, but a student comparing two
  // identical-looking cards has no way to tell which is which. Disambiguate the
  // display name (and only for the rows that actually collide, so the common
  // case keeps the name the school uses).
  // shortName is disambiguated separately from name, because the reductions above
  // collapse distinct schools onto the same label far more often than the full
  // names collide — several "Trinity University"s reduce to "Trinity".
  const groupBy = (field) => {
    const groups = new Map();
    for (const u of out) {
      if (!groups.has(u[field])) groups.set(u[field], []);
      groups.get(u[field]).push(u);
    }
    return groups;
  };

  for (const [, group] of groupBy("name")) {
    if (group.length > 1) for (const u of group) u.name = `${u.name} (${u.state})`;
  }
  for (const [, group] of groupBy("shortName")) {
    if (group.length > 1) for (const u of group) u.shortName = `${u.shortName} (${u.state})`;
  }
  // A state suffix does not separate two schools in the SAME state — the
  // University of Rhode Island and Rhode Island College both reduce to "Rhode
  // Island (RI)". Whatever still collides falls back to the full name, which the
  // pass above already made unique.
  for (const [, group] of groupBy("shortName")) {
    if (group.length > 1) for (const u of group) u.shortName = u.name;
  }
  const json = JSON.stringify(out, null, 2) + "\n";

  const testBlind = kept.filter((u) => u.avgSAT === null).length;
  console.log(`rows scanned         ${stats.rows}`);
  console.log(`passed quality gates ${stats.pool}  (${stats.noSat} report no SAT)`);
  console.log(`dropped: no majors   ${stats.noMajors}`);
  console.log(`already curated      ${stats.replacedCurated}`);
  console.log(`imported             ${stats.selected}  (${testBlind} test-blind, GPA from admit rate)`);
  console.log(`total in file        ${out.length}`);
  console.log(`bundle size          ${(Buffer.byteLength(json) / 1024).toFixed(0)} KB`);

  if (args.dryRun) {
    console.log("\n--dry-run: nothing written");
    return;
  }
  writeFileSync(args.out, json);
  console.log(`\nwrote ${args.out}`);
}

// Exported for scripts/import-scorecard.test.ts. The pure transforms are the
// part of this script that can fail *quietly* — a CSV parser that mishandles a
// quoted field does not throw, it shifts every later column by one and writes a
// plausible-looking wrong number into the dataset.
export {
  estimateGpa,
  estimateGpaFromAdmitRate,
  ADMIT_GPA_ANCHORS,
  majorsFor,
  shortNameFor,
  settingFor,
  testPolicyFor,
  cleanName,
  numberOrNull,
  parseCsv,
  CENSUS_REGION,
  CURATED_UNITIDS,
  GPA_ANCHORS,
};

// Only run as a CLI, so importing this module for tests does not read a 100MB
// file that is not there and exit(1) on the missing --csv argument.
if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  main();
}
