import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

/**
 * Where the dismissal is remembered.
 *
 * localStorage rather than a cookie, which is a small joke with a real reason
 * behind it: setting a cookie in order to record that someone read a notice
 * about cookies adds an entry to the very inventory the notice exists to keep
 * short. localStorage does the same job, never travels to the server, and is
 * already listed on the cookie policy page alongside the theme keys.
 */
const SEEN_KEY = "compass-cookie-notice";

/**
 * Has this browser already seen the notice?
 *
 * Read eagerly, inside the initializer, so a returning visitor never sees the
 * bar flash in and out on the first paint. Wrapped because Safari in private
 * mode throws on access rather than returning null — and the failure mode
 * chosen there matters: on a throw this returns false, so the notice is shown.
 * Showing an already-dismissed notice is a small annoyance; hiding one that
 * was never shown is a disclosure that did not happen.
 */
function alreadySeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The cookie notice.
 *
 * WHY THIS IS A NOTICE AND NOT A CONSENT GATE
 *
 * Compass sets exactly one cookie, compass_session, and it is what being
 * signed in *is*. Strictly-necessary storage is exempt from the consent
 * requirement in the ePrivacy Directive and the GDPR, so there is nothing here
 * to consent to — and offering Accept / Reject buttons for a cookie the app
 * cannot work without would be presenting a choice that does not exist. The
 * consent record it produced would be worthless, and the pattern trains people
 * to click through real consent prompts elsewhere without reading them.
 *
 * So this tells you what is stored and gets out of the way. There is one
 * button and it says "Got it", because that is the only thing the button
 * actually does.
 *
 * WHAT WOULD HAVE TO CHANGE IF ANALYTICS ARRIVE
 *
 * All of it, and deliberately so. Analytics storage is not strictly necessary,
 * needs prior opt-in in the EU and UK, and "by continuing you agree" is not
 * consent under any reading of those rules. That version of this component
 * blocks the script until someone opts in, records the decision with a
 * timestamp, offers a way to change it later, and treats Reject and ignoring
 * the banner identically. It is a different component, not a prop on this one,
 * and the fork should be taken on purpose rather than by adding a checkbox
 * here.
 *
 * WHY IT IS NOT A MODAL
 *
 * Nothing is being asked, so nothing needs to be answered before the page can
 * be used. It does not trap focus, does not dim the page, and does not block
 * the content — it is a region at the bottom of the document that a keyboard
 * user reaches in the ordinary tab order and can skip past. A modal would make
 * a required interaction out of something that is purely informational.
 */
export default function CookieNotice() {
  const [dismissed, setDismissed] = useState(alreadySeen);
  const barRef = useRef<HTMLElement>(null);

  /**
   * Publish the bar's height so the footer can get out from under it.
   *
   * A fixed bar floats over the end of the document, and on a short page —
   * the 404, a signed-out home — the page does not scroll, so anything it
   * covers is unreachable rather than merely hidden. What it covers is the
   * footer, which is where the legal links live, including the link to the
   * cookie policy this notice is pointing at. So the bar hid the one thing it
   * was asking you to read.
   *
   * Measured rather than hard-coded, because the height genuinely varies: 55px
   * on a wide screen, 63px once the text wraps, and past 120px on a phone
   * where the layout turns into a column with a full-width button. Every fixed
   * value is wrong at some width, and the widths in between are exactly where
   * nobody looks.
   *
   * A ResizeObserver rather than a resize listener: the bar also changes height
   * when the *font* loads, which fires no resize event at all and would
   * otherwise leave the reserved space a few pixels short on every first visit.
   */
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    const root = document.documentElement;
    const publish = () => {
      root.style.setProperty("--cookie-notice-h", `${bar.offsetHeight}px`);
    };
    publish();

    const observer = new ResizeObserver(publish);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      // Dismissed or unmounted: give the space straight back, or every page
      // would keep a strip of reserved emptiness under its footer forever.
      root.style.removeProperty("--cookie-notice-h");
    };
  }, [dismissed]);

  if (dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Private mode, or storage disabled. The notice reappears next visit,
      // which is the harmless direction for this to fail in.
    }
  };

  return (
    // A region rather than a dialog: this is a landmark to be found, not a
    // question to be answered. `no-print` because a saved PDF of a college
    // list should not carry a cookie banner across its footer.
    <section className="cookie-notice no-print" aria-label="Cookie notice" ref={barRef}>
      <div className="cookie-notice-inner">
        <p className="cookie-notice-text">
          <strong>Compass uses one cookie</strong> — the one that keeps you signed in.
          There&apos;s no analytics, no advertising, and no tracking here, so there&apos;s
          nothing to opt out of.{" "}
          <Link to="/cookies" className="cookie-notice-link">
            Read the cookie policy
          </Link>
        </p>
        <button className="btn btn-primary btn-sm cookie-notice-ok" onClick={dismiss}>
          Got it
        </button>
      </div>
    </section>
  );
}
