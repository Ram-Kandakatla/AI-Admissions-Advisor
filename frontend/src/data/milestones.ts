// The application year, September through May.
//
// IMPORTANT — same rule the application tracker plays by (see
// backend/models/application.js): nothing here is a promise about a specific
// college. These are the *conventions* of a US application cycle, and every
// item that names a date says so in language a student can check. Dates that
// have genuinely moved between cycles — the FAFSA open date most of all —
// point at the authority rather than asserting a day. A roadmap students plan
// around earns its keep by being honest about what it does not know.

export type MilestoneKind = "apply" | "essays" | "tests" | "aid" | "decide";

export interface Milestone {
  id: string;
  /** Calendar month, 1-indexed. */
  month: number;
  /** 0 = the autumn the student submits, 1 = the spring they hear back. */
  offsetYears: 0 | 1;
  /** Omitted when the item is a "sometime this month" habit, not a deadline. */
  day?: number;
  kind: MilestoneKind;
  title: string;
  detail: string;
}

export const KIND_LABEL: Record<MilestoneKind, string> = {
  apply: "Applications",
  essays: "Essays",
  tests: "Testing",
  aid: "Money",
  decide: "Decisions",
};

/** The nine months the page draws, as [month, offsetYears]. */
export const CYCLE_MONTHS: [number, 0 | 1][] = [
  [9, 0],
  [10, 0],
  [11, 0],
  [12, 0],
  [1, 1],
  [2, 1],
  [3, 1],
  [4, 1],
  [5, 1],
];

export const MILESTONES: Milestone[] = [
  // ── September ──
  {
    id: "sep-list",
    month: 9,
    offsetYears: 0,
    kind: "apply",
    title: "Lock in a balanced list",
    detail:
      "Most counselors land on 8–12 schools with a real spread of reach, target, and safety. Your Matches page is a starting point, not the finished list.",
  },
  {
    id: "sep-essay",
    month: 9,
    offsetYears: 0,
    kind: "essays",
    title: "Full draft of the personal essay",
    detail:
      "The Common App and Coalition applications open August 1. A complete draft now leaves room for the rewrites that actually make it good.",
  },
  {
    id: "sep-recs",
    month: 9,
    offsetYears: 0,
    day: 15,
    kind: "apply",
    title: "Ask for recommendation letters",
    detail:
      "Teachers get buried in October. Ask at least four weeks before your earliest deadline, and give them your résumé and a note on what you'd like them to speak to.",
  },
  {
    id: "sep-test-reg",
    month: 9,
    offsetYears: 0,
    kind: "tests",
    title: "Register for your last fall SAT or ACT",
    detail:
      "Registration closes roughly a month before each sitting. If you want one more attempt before early deadlines, this is the month to book it.",
  },

  // ── October ──
  {
    id: "oct-fafsa",
    month: 10,
    offsetYears: 0,
    day: 1,
    kind: "aid",
    title: "FAFSA opens",
    detail:
      "The federal aid form has historically opened October 1, but the date has shifted in recent cycles — confirm the current one at studentaid.gov and file as soon as it's live. Some aid is first-come.",
  },
  {
    id: "oct-css",
    month: 10,
    offsetYears: 0,
    day: 1,
    kind: "aid",
    title: "CSS Profile opens",
    detail:
      "Many private colleges require this on top of the FAFSA to award their own institutional aid. Check each school's aid page for whether it applies to you.",
  },
  {
    id: "oct-test",
    month: 10,
    offsetYears: 0,
    kind: "tests",
    title: "Final test sitting for early deadlines",
    detail:
      "Scores from an October date usually reach colleges in time for November 1, but the reporting window is tight. Verify the deadline each school sets for scores, which can differ from the application deadline.",
  },
  {
    id: "oct-supplements",
    month: 10,
    offsetYears: 0,
    kind: "essays",
    title: "Finish supplements for your early schools",
    detail:
      "The \"Why us?\" essays are the ones that reward research. Write them while you still have time to read past the marketing pages.",
  },

  // ── November ──
  {
    id: "nov-early",
    month: 11,
    offsetYears: 0,
    day: 1,
    kind: "apply",
    title: "Early Decision and Early Action deadlines",
    detail:
      "November 1 is the most common early date, with November 15 close behind. ED is binding — one school only, and you withdraw the rest if admitted.",
  },
  {
    id: "nov-send",
    month: 11,
    offsetYears: 0,
    kind: "apply",
    title: "Send transcripts and test scores",
    detail:
      "Your counselor sends the transcript; you order scores from College Board or ACT. Both take time to arrive, so submitting the application isn't the last step.",
  },
  {
    id: "nov-public",
    month: 11,
    offsetYears: 0,
    day: 30,
    kind: "apply",
    title: "Several large public systems close",
    detail:
      "A number of big state systems use a late-November deadline with no early round at all. If a public university is on your list, check its date now rather than assuming January.",
  },

  // ── December ──
  {
    id: "dec-priority",
    month: 12,
    offsetYears: 0,
    day: 1,
    kind: "apply",
    title: "Priority deadlines",
    detail:
      "Not a hard cutoff, but applying by it typically improves your odds for merit aid, honors programs, and housing. Common at rolling-admission schools.",
  },
  {
    id: "dec-early-results",
    month: 12,
    offsetYears: 0,
    kind: "decide",
    title: "Early Decision and Early Action results",
    detail:
      "Most early results land mid-December. An ED admit means you enroll and withdraw your other applications. A deferral means your file moves to the regular round — send an update letter.",
  },
  {
    id: "dec-rd-essays",
    month: 12,
    offsetYears: 0,
    kind: "essays",
    title: "Keep the regular-round supplements moving",
    detail:
      "Winter break is short and January 1 is a holiday. Finishing these in December is the single biggest favor you can do yourself.",
  },

  // ── January ──
  {
    id: "jan-rd",
    month: 1,
    offsetYears: 1,
    day: 1,
    kind: "apply",
    title: "Regular Decision deadlines",
    detail:
      "January 1 is the classic date, but January 5 and January 15 are just as widespread. Confirm every school's own deadline — this is the one to get wrong at your peril.",
  },
  {
    id: "jan-ed2",
    month: 1,
    offsetYears: 1,
    day: 1,
    kind: "apply",
    title: "Early Decision II deadlines",
    detail:
      "A second binding round, usually early-to-mid January. Worth considering if your first ED didn't land and you have a clear favorite left.",
  },
  {
    id: "jan-midyear",
    month: 1,
    offsetYears: 1,
    kind: "apply",
    title: "Midyear grades go out",
    detail:
      "Your counselor sends a midyear report with first-semester senior grades. Colleges do read it.",
  },

  // ── February ──
  {
    id: "feb-state-aid",
    month: 2,
    offsetYears: 1,
    kind: "aid",
    title: "State and institutional aid deadlines",
    detail:
      "These are separate from the FAFSA and often fall in February or earlier. Check your state's grant agency and each college's own aid page — missing one costs real money.",
  },
  {
    id: "feb-ed2-results",
    month: 2,
    offsetYears: 1,
    kind: "decide",
    title: "Early Decision II results",
    detail: "Binding, same as the first round. If you're in, you're going.",
  },
  {
    id: "feb-grades",
    month: 2,
    offsetYears: 1,
    kind: "apply",
    title: "Hold your grades",
    detail:
      "Every offer is conditional on your final transcript. Colleges do rescind for a collapsed second semester, and it happens every year.",
  },

  // ── March ──
  {
    id: "mar-decisions",
    month: 3,
    offsetYears: 1,
    kind: "decide",
    title: "Regular Decision results begin",
    detail:
      "Most regular decisions release between mid-March and early April. They arrive on wildly different days, so expect a scattered few weeks.",
  },
  {
    id: "mar-aid-letters",
    month: 3,
    offsetYears: 1,
    kind: "aid",
    title: "Compare aid letters as they land",
    detail:
      "Line up the net price — cost after grants, not after loans. Two schools with the same sticker can differ by tens of thousands in what you'd actually pay.",
  },

  // ── April ──
  {
    id: "apr-last",
    month: 4,
    offsetYears: 1,
    kind: "decide",
    title: "Final decisions and waitlist offers",
    detail:
      "Waitlist movement starts after May 1 and can run into the summer. Accepting a waitlist spot doesn't stop you from depositing elsewhere.",
  },
  {
    id: "apr-visit",
    month: 4,
    offsetYears: 1,
    kind: "decide",
    title: "Visit or revisit your finalists",
    detail:
      "Admitted-student days are the one time you see the place as a student rather than a prospect. Go if you can; join the virtual version if you can't.",
  },
  {
    id: "apr-appeal",
    month: 4,
    offsetYears: 1,
    kind: "aid",
    title: "Appeal an aid package if things changed",
    detail:
      "If your family's finances shifted since you filed, or another school offered more, aid offices will look again. Ask in writing, with documentation.",
  },

  // ── May ──
  {
    id: "may-decision-day",
    month: 5,
    offsetYears: 1,
    day: 1,
    kind: "decide",
    title: "National College Decision Day",
    detail:
      "Deposit at one school and decline the rest. May 1 is the standard date; a few schools set their own, so confirm yours.",
  },
  {
    id: "may-ap",
    month: 5,
    offsetYears: 1,
    kind: "tests",
    title: "AP exams",
    detail:
      "Scores can convert into college credit or placement, which is worth real tuition. Each college publishes its own credit policy.",
  },
  {
    id: "may-final-transcript",
    month: 5,
    offsetYears: 1,
    kind: "apply",
    title: "Request your final transcript",
    detail:
      "The last administrative step. Ask your counselor to send it to the school you're enrolling at once grades are final.",
  },
];
