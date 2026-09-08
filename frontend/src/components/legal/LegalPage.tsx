import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { formatLegalDate, isUnfilled, LEGAL_UPDATED } from "../../legal";

/**
 * The frame the four legal pages share: title, date, contents, sections.
 *
 * WHY A SHARED FRAME AND NOT FOUR HAND-BUILT PAGES
 *
 * These documents are read in a particular way — nobody reads one end to end.
 * Someone arrives from a footer link with one question ("does this sell my
 * data", "can I delete my account", "who do I email about a bug") and needs to
 * find the paragraph that answers it. That makes the furniture — a contents
 * list of real anchors, a stable heading rhythm, a visible last-changed date —
 * the functional part of the page rather than decoration, and it has to be
 * identical across all four or the reader has to relearn it each time.
 *
 * WHY THE HEADINGS CARRY IDS
 *
 * So a paragraph can be linked to. "See /privacy#ai" in a support reply, or in
 * a school's own handout, is worth more than "see the privacy policy", and a
 * legal document that cannot be cited at the section level tends not to be
 * cited at all.
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
  /**
   * The plain-language précis, above the contents.
   *
   * Not optional by accident — every one of these pages has one. A legal
   * document aimed at sixteen-year-olds and their parents that opens with
   * defined terms has already lost most of the people it is written for, and
   * the summary is the only part many readers will read. It is deliberately
   * *not* marked as non-binding boilerplate ("this summary is for convenience
   * only and the full terms govern"): that sentence exists to let the summary
   * be less true than the document, which is not a trade this app wants.
   */
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

/**
 * A value that has not been filled in yet, rendered so it cannot be skimmed
 * past.
 *
 * The alternative was to leave the placeholder as plain text, and the reason
 * not to is that plain text is exactly what gets deployed by accident. A legal
 * page that says "governed by the laws of [YOUR STATE]" in the same type as
 * everything around it looks finished at a glance; the same string with a
 * marked background does not. It also carries a title attribute so anyone
 * hovering in a review gets told what to do about it, and it is a <mark>,
 * which means assistive technology announces it as highlighted rather than
 * reading it as ordinary prose.
 */
export function Unfilled({ children }: { children: string }) {
  if (!isUnfilled(children)) return <>{children}</>;
  return (
    <mark className="legal-todo" title="Placeholder — fill this in before deploying. See src/legal.ts.">
      {children}
    </mark>
  );
}

/**
 * A small definition-style table, used by the cookie inventory and the
 * security scope list.
 *
 * A real <table> rather than a grid of divs: this is tabular data with a
 * header row, and the semantics are what let a screen reader announce "Purpose,
 * column 2" instead of reading nine unlabelled cells in a row. It scrolls
 * inside its own container on a narrow screen so the page body never scrolls
 * sideways.
 */
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
