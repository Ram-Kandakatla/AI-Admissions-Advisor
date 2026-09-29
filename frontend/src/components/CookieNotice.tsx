import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

/** localStorage, not a cookie, so the notice doesn't add to the cookie list. */
const SEEN_KEY = "compass-cookie-notice";

/** If storage throws (Safari private mode), show the notice rather than hide it. */
function alreadySeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * A notice, not a consent gate: the only cookie is the strictly necessary
 * session cookie, so there is no choice to offer. Adding analytics would need
 * a real opt-in gate that blocks the script, which is a different component.
 */
export default function CookieNotice() {
  const [dismissed, setDismissed] = useState(alreadySeen);
  const barRef = useRef<HTMLElement>(null);

  // Publishes the bar's measured height so the footer's legal links aren't
  // hidden under it. The height varies with width and font loading, hence
  // ResizeObserver rather than a fixed value.
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
      root.style.removeProperty("--cookie-notice-h");
    };
  }, [dismissed]);

  if (dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Storage unavailable; the notice just shows again next visit.
    }
  };

  return (
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
