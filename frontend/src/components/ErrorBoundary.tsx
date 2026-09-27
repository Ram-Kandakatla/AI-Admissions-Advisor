import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * A tab open across a deploy requests route chunks that no longer exist; a
 * reload fixes it. Matched loosely across the three engines' messages, since a
 * false positive only offers an unneeded reload.
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
  /** Changing this clears the error; Layout passes the pathname so navigation recovers. */
  resetKey?: string;
}

interface State {
  error: Error | null;
  resetKey?: string;
}

/**
 * Used twice: inside Layout, so the nav survives a page crash, and around the
 * whole app in main.tsx for a crash in Layout itself.
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
    // No error tracker yet, so the console is the only report.
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

/** Says their work is safe (it lives on the server), since that's what people worry about. */
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

/** The brand mark with its needle knocked off true. */
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
