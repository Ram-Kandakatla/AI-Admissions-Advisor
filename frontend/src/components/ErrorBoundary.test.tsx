import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ErrorBoundary from "./ErrorBoundary";

/**
 * React logs every caught error to console.error itself, on top of the one the
 * boundary writes. Left alone, a passing suite prints several screens of red
 * stack traces and a real failure gets lost in them.
 */
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Annotated `: never` deliberately. A function declaration whose body only
 * throws infers `void`, which is not a valid JSX element type — so without
 * this the suite runs green under Vitest and the build fails on `tsc -b`.
 */
function Boom({ message = "Cannot read properties of null" }: { message?: string }): never {
  throw new Error(message);
}

describe("catching", () => {
  it("shows the crash card instead of unmounting to a blank page", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Compass lost its bearing.")).toBeInTheDocument();
  });

  it("renders its children untouched when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>the actual page</p>
      </ErrorBoundary>
    );
    expect(screen.getByText("the actual page")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says the student's work is safe, which is the actual question", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText(/saved to your account, not to this page/)).toBeInTheDocument();
  });

  it("keeps the message reachable for anyone reporting the bug", async () => {
    render(
      <ErrorBoundary>
        <Boom message="student.gpa is undefined" />
      </ErrorBoundary>
    );
    // Collapsed, not omitted: "what did it say?" is the first question asked.
    await userEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("student.gpa is undefined")).toBeInTheDocument();
  });

  it("logs the failure with its component stack", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    // Until Sentry lands (deferred to Phase 7 by PHASE-4.md) the console is
    // the whole of the reporting story, so it has to actually carry the where.
    expect(console.error).toHaveBeenCalledWith(
      "Unhandled error in a component",
      expect.any(Error),
      expect.stringContaining("Boom")
    );
  });
});

describe("recovering", () => {
  it("clears the error when resetKey changes", () => {
    // What happens when someone clicks another nav link after a page throws.
    // Without this the boundary stays broken and every link looks dead.
    const { rerender } = render(
      <ErrorBoundary resetKey="/matches">
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKey="/timeline">
        <p>a different page</p>
      </ErrorBoundary>
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("a different page")).toBeInTheDocument();
  });

  it("stays broken while resetKey is unchanged", () => {
    // The other half of the same contract: a re-render for any other reason
    // must not silently retry a component that is still going to throw.
    const { rerender } = render(
      <ErrorBoundary resetKey="/matches">
        <Boom />
      </ErrorBoundary>
    );
    rerender(
      <ErrorBoundary resetKey="/matches">
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("offers a way home that leaves the app entirely", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    // A plain anchor, not a Link: a full load discards whatever state caused
    // this, and this boundary also mounts outside the router.
    expect(screen.getByRole("link", { name: /Back to the start/ })).toHaveAttribute("href", "/");
  });
});

describe("a stale chunk after a deploy", () => {
  // Code-splitting created this failure: a tab open across a deploy asks for a
  // chunk hash the server no longer has. Nothing is broken and nothing is
  // lost, so telling someone "something went wrong" would be both unhelpful
  // and untrue — the fix is one reload.
  const messages = [
    "Failed to fetch dynamically imported module: /assets/ChatBot-BiS5iFt0.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
  ];

  it.each(messages)("recognises it from %s", (message) => {
    render(
      <ErrorBoundary>
        <Boom message={message} />
      </ErrorBoundary>
    );
    expect(screen.getByText("Compass updated while this tab was open.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reload Compass/ })).toBeInTheDocument();
  });

  it("offers a reload rather than a retry, since re-rendering cannot fix it", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });

    render(
      <ErrorBoundary>
        <Boom message="Failed to fetch dynamically imported module: /assets/x.js" />
      </ErrorBoundary>
    );
    expect(screen.queryByRole("button", { name: /Try this page again/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Reload Compass/ }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("treats an ordinary error as an ordinary error", () => {
    render(
      <ErrorBoundary>
        <Boom message="Cannot read properties of undefined (reading 'map')" />
      </ErrorBoundary>
    );
    expect(screen.getByText("Compass lost its bearing.")).toBeInTheDocument();
  });
});
