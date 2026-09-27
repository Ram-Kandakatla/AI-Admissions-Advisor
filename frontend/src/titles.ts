// Per-route document titles. " — Compass" is a suffix so the distinguishing
// word survives a narrow tab.

const SUFFIX = " — Compass";

const TITLES: Record<string, string> = {
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
  "/account": `Your account${SUFFIX}`,
  "/forgot": `Reset your password${SUFFIX}`,
  "/reset": `Choose a new password${SUFFIX}`,
  "/verify": `Confirm your email${SUFFIX}`,
  "/signin": `Sign in${SUFFIX}`,
  "/signup": `Create an account${SUFFIX}`,
  "/terms": `Terms of Service${SUFFIX}`,
  "/privacy": `Privacy Policy${SUFFIX}`,
  "/cookies": `Cookie Policy${SUFFIX}`,
  "/security": `Security & disclosure${SUFFIX}`,
};

/**
 * Lossy on punctuation, but needs no catalog fetch, so the title doesn't
 * change a beat after the page loads. Fine for a tab, not for page content.
 */
function unslug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Unknown paths get the 404 title. `search` only matters for /chat?mode=essay,
 * which is a different page; /compare?ids= is the same page with other schools.
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
