import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { formatLegalDate, isUnfilled, LEGAL_UPDATED } from "../../legal";

/**
 * The shared frame for the four legal pages, so contents, headings and date
 * work the same everywhere. Headings carry ids so sections can be linked.
 */

export interface LegalSection {
  id: string;
  title: string;
  body: ReactNode;
}

export default function LegalPage({
  eyebrow,
  title,
  lead,
  summary,
  sections,
  footer,
}: {
  eyebrow: string;
  title: string;
  lead: ReactNode;
  /** Plain-language summary. Required, and not labelled non-binding: it must be as true as the rest. */
  summary: ReactNode;
  sections: LegalSection[];
  footer?: ReactNode;
}) {
  return (
    <article className="legal">
      <header className="legal-head">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="section-title">{title}</h1>
        <p className="lead">{lead}</p>
        <p className="legal-dates">
          Last updated <time dateTime={LEGAL_UPDATED}>{formatLegalDate(LEGAL_UPDATED)}</time>
        </p>
      </header>

      <div className="legal-summary panel">
        <h2 className="legal-summary-title">In short</h2>
        {summary}
      </div>

      {/* A real nav landmark, not a styled list: this is the second way to get
          around the page and a screen reader should be able to jump to it. */}
      <nav className="legal-toc" aria-label="On this page">
        <h2 className="legal-toc-title">On this page</h2>
        <ol>
          {sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`}>{s.title}</a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="legal-body">
        {sections.map((s, i) => (
          <section key={s.id} id={s.id} className="legal-section">
            <h2>
              {/* Numbered in the markup rather than by a CSS counter, because
                  these numbers get cited out loud and in email — "section 7" —
                  and a number that exists only in a ::before is invisible to
                  copy-paste, to search, and to a screen reader. */}
              <span className="legal-num" aria-hidden="true">
                {i + 1}
              </span>
              {s.title}
            </h2>
            {s.body}
          </section>
        ))}
      </div>

      {footer && <div className="legal-foot">{footer}</div>}

      <p className="legal-siblings">
        Also here: <Link to="/terms">Terms of Service</Link> ·{" "}
        <Link to="/privacy">Privacy Policy</Link> ·{" "}
        <Link to="/cookies">Cookie Policy</Link> · <Link to="/security">Security</Link>
      </p>
    </article>
  );
}

/** Highlighted so an unfilled placeholder can't ship looking finished. */
export function Unfilled({ children }: { children: string }) {
  if (!isUnfilled(children)) return <>{children}</>;
  return (
    <mark className="legal-todo" title="Placeholder — fill this in before deploying. See src/legal.ts.">
      {children}
    </mark>
  );
}

/** Scrolls inside its own container on narrow screens. */
export function LegalTable({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: string[];
  rows: ReactNode[][];
}) {
  return (
    <div className="legal-table-wrap">
      <table className="legal-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) =>
                j === 0 ? (
                  <th key={j} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={j}>{cell}</td>
                )
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
