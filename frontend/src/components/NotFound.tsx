import { Link, useLocation } from "react-router-dom";

/**
 * A URL that isn't a page.
 *
 * New in Phase 5 and unavoidable: before the router there was no such thing
 * as a wrong address here, because every destination was a click. Now that
 * they're all typeable, mistyped and stale ones need somewhere to land that
 * isn't a blank screen.
 *
 * It names the path it couldn't find rather than saying "page not found" and
 * leaving you to guess which link was broken — and it offers the two
 * destinations that are useful from anywhere, not a link to every page in
 * the app, which is what the nav directly above is already for.
 */
export default function NotFound() {
  const { pathname } = useLocation();

  return (
    <div className="empty">
      <h1>No page at that address</h1>
      <p>
        Nothing lives at <code>{pathname}</code>. It may have been a typo, or a link from an
        older version of Compass.
      </p>
      <div className="empty-actions">
        <Link className="btn btn-primary" to="/">
          Back to the start <span className="btn-arrow">→</span>
        </Link>
        <Link className="btn btn-ghost" to="/chat">
          Ask Compass something
        </Link>
      </div>
    </div>
  );
}
