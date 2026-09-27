import { Link, useLocation } from "react-router-dom";

/** Names the missing path, so it's clear which link was broken. */
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
