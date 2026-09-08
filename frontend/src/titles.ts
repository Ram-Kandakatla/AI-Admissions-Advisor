// What the browser tab says.
//
// Before the router there was one title for the whole app, and it was correct:
// there was one URL. Now there are thirteen, and every one of them can be
// bookmarked, reopened from history, or sat in a row of tabs during an
// afternoon of applications — none of which works if they all read "Compass".
//
// The suffix is " — Compass" rather than a prefix so the distinguishing word
// survives a narrow tab, where a browser truncates from the right.

const SUFFIX = " — Compass";

const TITLES: Record<string, string> = {
  // The homepage keeps the full name: it is the one page where the tab is
  // doing introductions rather than telling you which of five tabs is which.
  "/": "Compass — College Admissions Advisor",
  "/profile": `Your profile${SUFFIX}`,
  "/matches": `Your matches${SUFFIX}`,
  "/scholarships": `Scholarships${SUFFIX}`,
  "/saved": `Saved schools${SUFFIX}`,
  "/tracker": `Application tracker${SUFFIX}`,
  "/timeline": `Deadline timeline${SUFFIX}`,
  "/compare": `Compare schools${SUFFIX}`,
  "/majors": `Majors${SUFFIX}`,
  "/explore": `Explore schools${SUFFIX}`,
  "/chat": "Ask Compass",
  "/share": `Share your plan${SUFFIX}`,
  "/signin": `Sign in${SUFFIX}`,
  "/signup": `Create an account${SUFFIX}`,
  // The legal and trust pages. These are the titles most likely to be read in
  // a history list rather than a tab bar — someone hunting for "that page that
  // said what they do with my data" weeks later — so each names the document
  // rather than the section it belongs to.
  "/terms": `Terms of Service${SUFFIX}`,
  "/privacy": `Privacy Policy${SUFFIX}`,
  "/cookies": `Cookie Policy${SUFFIX}`,
  "/security": `Security & disclosure${SUFFIX}`,
};

/**
 * "computer-science" → "Computer Science".
 *
 * Deliberately not routed through the catalog, even though `majorFromSlug`
 * could give the exact name: that would make the title wait on a fetch, so the
 * tab would read "Majors" for a beat and then change under someone who is
 * already scanning their tab bar. This is lossy where a name carries
 * punctuation — "Business / Economics" comes back as "Business Economics" —
 * which is the right trade for a tab label, and would not be for anything the
 * app displayed on the page.
 */
function unslug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The document title for a location. Unknown paths get the 404's title.
 *
 * `search` matters for exactly one route so far. Phase 6.3 put the chatbot's
 * two assistants on `/chat` and `/chat?mode=essay` — two separately
 * bookmarkable pages, which is the same situation this module exists to fix,
 * only inside one path instead of across fourteen. `/compare?ids=` is
 * deliberately not treated this way: the query there is a set of schools, not
 * a different page.
 */
export function titleFor(pathname: string, search = ""): string {
  if (pathname === "/chat" && new URLSearchParams(search).get("mode") === "essay") {
    return `Essay brainstorm${SUFFIX}`;
  }

  const exact = TITLES[pathname];
  if (exact) return exact;

  if (pathname.startsWith("/majors/")) {
    const major = unslug(pathname.slice("/majors/".length));
    if (major) return `${major}${SUFFIX}`;
  }

  return `Page not found${SUFFIX}`;
}
