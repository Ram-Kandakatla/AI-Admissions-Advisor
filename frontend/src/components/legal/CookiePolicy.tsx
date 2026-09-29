import { Link } from "react-router-dom";
import LegalPage, { LegalTable, type LegalSection } from "./LegalPage";
import { REPO_URL } from "../../legal";

/**
 * Lists every cookie and storage key by name; keep it complete. No
 * Accept/Reject because the only cookie is strictly necessary. Adding
 * analytics would require a real opt-in gate (see CookieNotice.tsx).
 */
export default function CookiePolicy() {
  const sections: LegalSection[] = [
    {
      id: "cookies",
      title: "The one cookie",
      body: (
        <>
          <p>
            Compass sets a single cookie. It is what keeps you signed in from one page to
            the next, and it exists for no other purpose.
          </p>
          <LegalTable
            caption="Cookies set by Compass"
            head={["Name", "What it holds", "Why", "How long"]}
            rows={[
              [
                <code key="n">__Host-compass_session</code>,
                "A random session identifier. Nothing about you — the identifier points at a row on the server, and carries no information itself.",
                "Keeps you signed in, and tells the server which account a request belongs to. Without it, every page load would be a stranger arriving.",
                "30 days from sign-in, or until you sign out. Not extended by use, so a stolen cookie has a definite expiry rather than an indefinite one.",
              ],
            ]}
          />
          <p>Its settings, which are the part that matters for your safety:</p>
          <ul className="legal-list">
            <li>
              <strong>
                <code>httpOnly</code>
              </strong>{" "}
              — JavaScript cannot read it, so a script injected into the page cannot steal
              your session.
            </li>
            <li>
              <strong>
                <code>SameSite=Lax</code>
              </strong>{" "}
              — another website cannot use it to make a request as you, while an ordinary
              link into Compass still works.
            </li>
            <li>
              <strong>
                <code>Secure</code>
              </strong>{" "}
              — sent only over HTTPS whenever the app is served over HTTPS.
            </li>
            <li>
              <strong>
                <code>__Host-</code> prefix
              </strong>{" "}
              — the browser accepts the cookie only from this exact host, never from a
              subdomain, so no other page can plant a session of its own choosing on you.
            </li>
            <li>
              <strong>First-party.</strong> It is set by Compass, readable only by Compass,
              and follows you nowhere.
            </li>
          </ul>
          <p>
            Signing out deletes the cookie <em>and</em> the session row on the server, so it
            is a real revocation rather than the browser politely forgetting a key that
            would still open the door.
          </p>
        </>
      ),
    },
    {
      id: "local-storage",
      title: "Two things in local storage",
      body: (
        <>
          <p>
            These are not cookies — they are stored by your browser, never sent to the
            server, and never seen by anyone but you. They are listed because &ldquo;we only
            use one cookie&rdquo; would be a technically true sentence hiding two other
            things, and that is precisely the move this page is trying not to make.
          </p>
          <LegalTable
            caption="Local storage keys used by Compass"
            head={["Key", "What it holds", "Why", "How long"]}
            rows={[
              [
                <code key="t">compass-theme</code>,
                <>
                  The word <code>light</code> or <code>dark</code>.
                </>,
                "Remembers your theme so dark mode does not flash white on every page load.",
                "Until you clear your browser storage.",
              ],
              [
                <code key="n">compass-night</code>,
                "A palette name, set only if you have visited a ?night= preview URL.",
                "A temporary switch left over from choosing the dark-mode palette. Harmless, and due for removal.",
                "Until you clear your browser storage.",
              ],
            ]}
          />
          <p>
            The cookie notice you dismissed also leaves a mark here — a single{" "}
            <code>compass-cookie-notice</code> key recording that you have seen it, so it
            does not reappear on every page. Storing a dismissal is the one way to avoid
            showing you a banner forever.
          </p>
        </>
      ),
    },
    {
      id: "no-consent",
      title: "Why Compass does not ask you to accept cookies",
      body: (
        <>
          <p>
            Because there is nothing here to consent to. Under EU and UK rules, consent is
            required for storage that is <em>not</em> strictly necessary — analytics,
            advertising, profiling. Storage that a service genuinely cannot work without is
            exempt.
          </p>
          <p>
            <code>__Host-compass_session</code> is exactly that: it <em>is</em> being signed in.
            A banner offering you a Reject button for it would be offering a choice that
            does not exist, and a consent record produced that way would mean nothing.
          </p>
          <p className="legal-check">
            <strong>Compass has no analytics, no advertising, and no third-party scripts.</strong>{" "}
            Not &ldquo;none currently enabled&rdquo; — none present. You can confirm it in
            your browser&apos;s network tab, or read{" "}
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
              the source
            </a>
            .
          </p>
          <p>
            If that ever changes, this page changes with it and the notice becomes a real
            consent gate that blocks the script until you opt in — not a banner that says
            &ldquo;by continuing you agree&rdquo;, which is not consent under any of these
            laws.
          </p>
        </>
      ),
    },
    {
      id: "third-party",
      title: "No third-party requests",
      body: (
        <>
          <p>
            Loading a page in Compass fetches nothing from anyone else. No fonts from a
            CDN, no scripts, no analytics beacons, no tracking pixels, no embedded images
            from other domains.
          </p>
          <p>
            This used to be one item long. Compass loaded its two typefaces from Google
            Fonts, which set no cookie and ran no script but did make your browser call{" "}
            <code>fonts.googleapis.com</code> and <code>fonts.gstatic.com</code> on every
            page load — and an IP address is personal data in the EU whether or not a
            cookie came with it. The fonts are now served from Compass&apos;s own origin,
            so that request is gone rather than merely disclosed.
          </p>
          <p className="legal-check">
            This is the easiest claim on the page to check and the easiest to break. Open
            your browser&apos;s network tab, reload, and sort by domain: everything should
            come from the address in your URL bar.
          </p>
        </>
      ),
    },
    {
      id: "control",
      title: "Clearing or blocking any of this",
      body: (
        <>
          <p>
            Every browser lets you view, delete, and block cookies and site data per site —
            usually under Settings, Privacy, or the padlock in the address bar. Clearing
            Compass&apos;s data signs you out, forgets your theme, and brings the cookie
            notice back.
          </p>
          <p className="legal-warn">
            Blocking the session cookie specifically means you cannot sign in and your work
            will not survive a page reload. Compass will still let you browse schools and
            majors.
          </p>
          <p>
            Private or incognito windows work fine and discard everything when the window
            closes — which also means a profile built in one is gone when you close it.
          </p>
          <p>
            Compass does not respond differently to Global Privacy Control or Do Not Track
            signals, for a simple reason: there is no tracking to turn off. Sending one
            changes nothing here because nothing here was collecting anything to begin with.
          </p>
        </>
      ),
    },
  ];

  return (
    <LegalPage
      eyebrow="Cookies"
      title="Cookie Policy"
      lead="A complete list, which is short enough to actually be complete: one cookie and two local-storage keys. No third-party requests, and nothing that tracks you."
      sections={sections}
      summary={
        <ul className="legal-tldr">
          <li>
            <strong>One cookie</strong> — <code>__Host-compass_session</code>, which is what keeps
            you signed in.
          </li>
          <li>
            <strong>No analytics, advertising, or tracking cookies.</strong> None. That is
            why there is no Accept / Reject banner.
          </li>
          <li>
            Two <code>localStorage</code> keys remember your theme. They never leave your
            browser.
          </li>
          <li>
            <strong>No requests to anyone else</strong> — the fonts are served from here,
            so nothing off-site sees your IP.
          </li>
          <li>
            Clearing your site data undoes all of it — and signs you out. Full detail in the{" "}
            <Link to="/privacy">Privacy Policy</Link>.
          </li>
        </ul>
      }
    />
  );
}
