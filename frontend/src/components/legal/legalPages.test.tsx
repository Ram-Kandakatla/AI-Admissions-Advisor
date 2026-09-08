import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import Terms from "./Terms";
import Privacy from "./Privacy";
import CookiePolicy from "./CookiePolicy";
import Security from "./Security";
import { SECURITY_ADVISORY_URL } from "../../legal";
// The real index.html, as text, through Vite rather than through node:fs —
// this is a browser app with no Node types, and `?raw` needs neither.
import rawIndexHtml from "../../../index.html?raw";

/**
 * What these tests are for, and what they are deliberately not for.
 *
 * They do not assert on prose. Legal copy gets rewritten, and a test that
 * pins a sentence turns every improvement into a failing test that gets
 * updated without being read — which is worse than no coverage, because it
 * launders a change past review.
 *
 * What they pin instead is the small set of claims that are load-bearing
 * because they are *promises about the code*: no analytics, no sale of data,
 * one cookie, a working report link, an admitted limitation. If someone adds
 * an analytics script, the honest move is to change the policy — and these
 * tests are what make forgetting to change it a failure rather than a silent
 * lie on a page nobody reads twice. The rest is structure: every page has a
 * summary, and every contents entry points at a section that exists.
 */

const PAGES = [
  { name: "Terms", Page: Terms },
  { name: "Privacy", Page: Privacy },
  { name: "Cookies", Page: CookiePolicy },
  { name: "Security", Page: Security },
] as const;

function renderPage(Page: () => JSX.Element) {
  return render(
    <MemoryRouter>
      <Page />
    </MemoryRouter>
  );
}

describe.each(PAGES)("$name — structure", ({ Page }) => {
  it("has exactly one h1", () => {
    renderPage(Page);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("opens with a plain-language summary", () => {
    // The part most readers will read, and the reason none of these pages
    // starts with defined terms.
    renderPage(Page);
    expect(screen.getByRole("heading", { name: "In short", level: 2 })).toBeInTheDocument();
  });

  it("every contents link points at a section that exists", () => {
    // The failure this catches is a renamed or deleted section leaving a dead
    // anchor behind — which turns the one navigation aid on a long document
    // into a link that silently does nothing.
    const { container } = renderPage(Page);
    const toc = screen.getByRole("navigation", { name: /on this page/i });
    const links = within(toc).getAllByRole("link");
    expect(links.length).toBeGreaterThan(3);

    for (const link of links) {
      const id = link.getAttribute("href")!.slice(1);
      expect(container.querySelector(`#${id}`), `no section #${id}`).not.toBeNull();
    }
  });

  it("links to its three siblings, so any one is reachable from any other", () => {
    renderPage(Page);
    for (const href of ["/terms", "/privacy", "/cookies", "/security"]) {
      expect(
        document.querySelector(`a[href="${href}"]`),
        `no link to ${href}`
      ).not.toBeNull();
    }
  });
});

describe("Privacy — the claims that are promises about the code", () => {
  it("says there is no analytics and no third-party tracking", () => {
    renderPage(Privacy);
    expect(screen.getByText(/No analytics and no advertising trackers/i)).toBeInTheDocument();
  });

  it("says data is never sold", () => {
    renderPage(Privacy);
    expect(screen.getByText(/No sale of data, ever/i)).toBeInTheDocument();
  });

  it("claims no third-party requests", () => {
    renderPage(Privacy);
    expect(
      screen.getByText(/makes no request to any other\s+company/i)
    ).toBeInTheDocument();
  });

  it("points at the page that actually deletes everything", () => {
    // This replaced an admitted gap — the policy used to say deletion was a
    // manual email. Both the claim and the link are asserted, because a claim
    // whose link rots is worse than no claim.
    renderPage(Privacy);
    expect(screen.getByText(/Delete everything, yourself, right now/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /your account page/i })
    ).toHaveAttribute("href", "/account");
  });

  it("tells under-13s not to use Compass, and says why", () => {
    renderPage(Privacy);
    expect(
      screen.getByText(/If you are under 13, please do not use Compass/i)
    ).toBeInTheDocument();
  });
});

/**
 * The claim "Compass makes no third-party requests" is the one on these pages
 * that a single careless line of HTML can falsify, and nothing about the app
 * would look broken when it did — the page would render fine and the policy
 * would simply be lying.
 *
 * So it is checked against the file rather than the prose. This is what caught
 * the original problem: index.html loaded two typefaces from Google's CDN,
 * which set no cookie and ran no script but handed every visitor's IP address
 * to Google on every page load. The fix was to self-host the fonts
 * (scripts/fetch-fonts.mjs); this is what stops them drifting back.
 */
describe("the no-third-parties claim, checked against index.html", () => {
  // Comments stripped first. index.html explains *why* the Google Fonts link
  // was removed, and naming the hosts it no longer contacts is the clearest
  // way to write that — but a host named in a comment is not a request, and a
  // check that cannot tell the difference would force the explanation to be
  // written in euphemisms to keep a test green. What matters is what the
  // browser acts on.
  const html = rawIndexHtml.replace(/<!--[\s\S]*?-->/g, "");

  it("loads no fonts, styles, or scripts from another origin", () => {
    // Every href/src that is absolute — a protocol-relative "//host" counts,
    // which is the spelling an audit that only greps for "https://" misses.
    const external = [...html.matchAll(/(?:href|src)\s*=\s*"((?:https?:)?\/\/[^"]+)"/g)]
      .map((m) => m[1])
      // og:url, og:image and canonical are metadata *about* the page for link
      // previews. They are strings a scraper reads, not requests a visitor's
      // browser makes, so they are not third parties in this sense.
      .filter((url) => !html.includes(`content="${url}"`));

    expect(external).toEqual([]);
  });

  it("mentions neither Google Fonts host anywhere in the document", () => {
    // Belt and braces: catches a preconnect, a dns-prefetch, or an @import
    // inside an inline <style>, none of which the attribute scan above sees.
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("fonts.gstatic.com");
  });

  it("serves both preloaded fonts from this origin, with crossorigin", () => {
    // A font preload without `crossorigin` is treated as a separate request
    // from the CORS-mode fetch the CSS makes, so the file downloads twice —
    // a performance bug that is invisible unless you are watching the network
    // tab, which is exactly why it gets a test.
    const preloads = [...html.matchAll(/<link\s+rel="preload"[^>]*>/gs)];
    expect(preloads.length).toBe(2);
    for (const [tag] of preloads) {
      expect(tag).toContain('as="font"');
      expect(tag).toContain("crossorigin");
      expect(tag).toMatch(/href="\/fonts\/[a-z-]+\.woff2"/);
    }
  });
});

describe("Cookies — the inventory", () => {
  it("names the one cookie and its lifetime", () => {
    renderPage(CookiePolicy);
    expect(screen.getAllByText("compass_session").length).toBeGreaterThan(0);
    expect(screen.getByText(/30 days from sign-in/i)).toBeInTheDocument();
  });

  it("explains why there is no accept-or-reject prompt", () => {
    renderPage(CookiePolicy);
    expect(
      screen.getByRole("heading", { name: /why compass does not ask you to accept cookies/i })
    ).toBeInTheDocument();
  });

  it("lists the local-storage keys too, not just the cookie", () => {
    // "We only use one cookie" is technically true while hiding two other
    // things, which is the exact move this page exists not to make.
    renderPage(CookiePolicy);
    expect(screen.getByText("compass-theme")).toBeInTheDocument();
    expect(screen.getByText("compass-night")).toBeInTheDocument();
  });
});

describe("Security — the parts a researcher needs", () => {
  it("gives a working private-reporting link", () => {
    // The single most important element on the page. A disclosure page whose
    // report link is wrong is worse than no page.
    renderPage(Security);
    const report = screen.getByRole("link", { name: /report privately on github/i });
    expect(report).toHaveAttribute("href", SECURITY_ADVISORY_URL);
    expect(report).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("states safe harbour, which is what actually unblocks a report", () => {
    renderPage(Security);
    expect(screen.getByText(/is\s+authorised/i)).toBeInTheDocument();
  });

  it("keeps the known-limitations section, which is what makes the rest credible", () => {
    // Scoped to the section rather than the page: the summary names some of
    // these gaps too, and an assertion that passes on the summary alone would
    // survive the section itself being deleted — which is the removal this
    // test exists to catch.
    const { container } = renderPage(Security);
    const section = within(container.querySelector("#limitations") as HTMLElement);
    expect(
      section.getByRole("heading", { name: /known limitations/i })
    ).toBeInTheDocument();
    expect(section.getByText(/No independent security audit/i)).toBeInTheDocument();
    expect(section.getByText(/No two-factor authentication/i)).toBeInTheDocument();
    // The gap that got closed rather than reworded — if this string comes
    // back, the page and the app disagree.
    expect(section.queryByText(/no self-serve account deletion/i)).toBeNull();
  });

  it("points at security.txt for machines", () => {
    renderPage(Security);
    expect(
      screen.getByRole("link", { name: /well-known\/security\.txt/i })
    ).toHaveAttribute("href", "/.well-known/security.txt");
  });
});

describe("Terms — the disclaimers that change behaviour", () => {
  it("says plainly that Compass is not a counselor and predicts nothing", () => {
    // Said twice on purpose — once in the summary, once in the body — because
    // it is the single most important sentence on the page. Asserting on both
    // is what keeps the body copy from being the one that gets trimmed.
    const { container } = renderPage(Terms);
    expect(
      within(container.querySelector(".legal-summary") as HTMLElement).getByText(
        /not a substitute for your school counselor/i
      )
    ).toBeInTheDocument();
    expect(
      within(container.querySelector("#what-compass-is") as HTMLElement).getByText(
        /not a substitute for your school counselor/i
      )
    ).toBeInTheDocument();
  });

  it("warns that deadlines here are conventions, not a college's calendar", () => {
    renderPage(Terms);
    expect(
      screen.getByText(/Deadlines shown in Compass are conventions, not calendars/i)
    ).toBeInTheDocument();
  });

  it("says the AI can be wrong, in its own section rather than a footnote", () => {
    renderPage(Terms);
    expect(
      screen.getByRole("heading", { name: /the ai can be wrong/i })
    ).toBeInTheDocument();
  });

  it("keeps what students write theirs, and out of model training", () => {
    renderPage(Terms);
    expect(screen.getByText(/none of it is used to train any model/i)).toBeInTheDocument();
  });
});

describe("unfilled operator details", () => {
  it("renders every placeholder as a visible mark, not as ordinary prose", () => {
    // The whole point of the convention: "[YOUR STATE, COUNTRY]" set in body
    // type looks finished at a glance and would ship. Highlighted, it cannot.
    renderPage(Terms);
    const marks = document.querySelectorAll("mark.legal-todo");
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(mark.textContent).toMatch(/^\[.+\]$/);
    }
  });
});
