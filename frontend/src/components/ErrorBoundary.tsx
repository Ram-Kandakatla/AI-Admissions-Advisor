import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Did this error come from a route chunk that is no longer on the server?
 *
 * Code-splitting bought a smaller first load and, with it, one new way to
 * fail: a tab left open across a deploy holds an index.js that names chunks by
 * a content hash the server no longer has, so the next navigation asks for a
 * file that 404s. Nothing is wrong with the app or with the tab's data — the
 * page is simply out of date, and a reload fixes it completely.
 *
 * The three strings are the same failure in the three engines. None of them is
 * a stable API, so the check is deliberately loose: matching too eagerly costs
 * a wrong-but-harmless offer to reload, while matching too narrowly leaves
 * someone staring at "something broke" when one button would have fixed it.
 */
function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /importing a module script failed/i.test(message)
  );
}

interface Props {
  children: ReactNode;
  /**
   * Changing this clears a caught error. Layout passes the pathname, so
   * navigating away from a page that threw gets you a working app again —
   * without it the boundary stays broken until a full reload, and every link
   * in the nav would look dead.
   */
  resetKey?: string;
}

interface State {
  error: Error | null;
  resetKey?: string;
}

/**
 * Catches a render error under it and shows something designed instead of
 * unmounting the tree to a blank page.
 *
 * A class, because `componentDidCatch` has no hook equivalent — this is the
 * one thing React still has no function-component API for.
 *
 * Used twice, deliberately: once inside Layout around the routed page, where
 * catching an error leaves the header, nav and footer on screen so the app is
 * still navigable; and once around the whole app in main.tsx, for the case the
 * inner one cannot catch — Layout itself throwing. The inner boundary is the
 * one that will fire in practice; the outer one exists so that "in practice"
 * is not load-bearing.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (state.error && props.resetKey !== state.resetKey) {
      return { error: null, resetKey: props.resetKey };
    }
    if (props.resetKey !== state.resetKey) return { resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The only console call in the frontend that is not a mistake. There is no
    // error tracker here yet on purpose — PHASE-4.md defers Sentry until this
    // app has users who are not the person who wrote it — so the browser
    // console is the whole of the reporting story, and it should at least
    // carry the component stack that says *where*.
    console.error("Unhandled error in a component", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <CrashState
        error={this.state.error}
        onRetry={() => this.setState({ error: null })}
      />
    );
  }
}

/**
 * The designed error state.
 *
 * Not a red wall: an error the student did not cause and cannot fix does not
 * need to look like an alarm. It is the same card every other surface in the
 * app uses, and the red is confined to the mark — enough to say "this is not
 * a normal page", not enough to say "you have done something wrong".
 *
 * The one thing it goes out of its way to say is that their work is safe,
 * because that is the actual question. Since Phase 2 the profile, notes, and
 * tracker live in D1 behind a session cookie, so a page that crashed took
 * nothing with it — and saying so is only fair given the app spends the rest
 * of its copy telling guests their list is fragile.
 */
function CrashState({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const stale = isStaleChunkError(error);

  return (
    <div className="crash panel" role="alert">
      <LostBearing />

      {stale ? (
        <>
          <h1 className="crash-title">Compass updated while this tab was open.</h1>
          <p className="crash-body">
            This page&apos;s code changed on the server, so the tab is running a version that
            isn&apos;t there any more. Reloading picks up the new one.
          </p>
          <div className="crash-actions">
            {/* A reload, not a re-render: the whole point is to fetch the
                index that names the chunks this deploy actually has. */}
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              Reload Compass <span className="btn-arrow">→</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <h1 className="crash-title">Compass lost its bearing.</h1>
          <p className="crash-body">
            Something on this page broke. Your profile, your notes, and everything in your
            tracker are unaffected — they&apos;re saved to your account, not to this page.
          </p>
          <div className="crash-actions">
            <button className="btn btn-primary" onClick={onRetry}>
              Try this page again
            </button>
            {/* A plain anchor rather than a Link: a full load throws away
                whatever state got the app into this, and this boundary also
                runs outside the router, where Link would throw. */}
            <a className="btn btn-ghost" href="/">
              Back to the start
            </a>
          </div>
        </>
      )}

      {/* Collapsed rather than hidden. Nobody wants a stack trace, but the
          first thing anyone is asked when they report a bug is what it said,
          and a React render error contains nothing private. */}
      <details className="crash-details">
        <summary>Technical details</summary>
        <pre>{error.message || String(error)}</pre>
      </details>
    </div>
  );
}

/**
 * The brand mark with its needle knocked loose.
 *
 * The app's own compass rose, drawn once here with the north needle swung off
 * true and greyed. It says what happened in the app's own vocabulary, which a
 * generic warning triangle could not.
 */
function LostBearing() {
  return (
    <svg className="crash-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="14.5" stroke="var(--red)" strokeWidth="1.5" opacity="0.55" />
      <circle cx="16" cy="16" r="2" fill="var(--red)" />
      <g transform="rotate(38 16 16)">
        <path d="M16 4.5 L19 15 L16 16 L13 15 Z" fill="var(--red)" />
        <path d="M16 27.5 L13 17 L16 16 L19 17 Z" fill="var(--txf)" />
      </g>
    </svg>
  );
}
