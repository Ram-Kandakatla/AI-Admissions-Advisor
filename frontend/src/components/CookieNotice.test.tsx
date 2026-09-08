import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CookieNotice from "./CookieNotice";

const KEY = "compass-cookie-notice";

function renderNotice() {
  return render(
    <MemoryRouter>
      <CookieNotice />
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("what it says", () => {
  it("shows on a first visit", () => {
    renderNotice();
    expect(screen.getByRole("region", { name: /cookie notice/i })).toBeInTheDocument();
  });

  /**
   * The load-bearing assertion of the whole component.
   *
   * Compass sets one strictly-necessary cookie, which is exempt from the
   * consent requirement — so there is nothing to accept or reject, and buttons
   * offering that choice would be presenting one that does not exist. If
   * someone later adds an Accept/Reject pair without also adding the consent
   * machinery behind it, this fails, which is exactly when it should.
   */
  it("offers no accept-or-reject choice, because there is nothing to consent to", () => {
    renderNotice();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName("Got it");
    expect(screen.queryByRole("button", { name: /reject|decline|accept|manage/i })).toBeNull();
  });

  it("says what is actually stored and links to the policy", () => {
    renderNotice();
    expect(screen.getByText(/uses one cookie/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /cookie policy/i })).toHaveAttribute(
      "href",
      "/cookies"
    );
  });

  it("is not a modal — it never blocks the page", () => {
    // A notice that asks nothing must not demand an answer before the page can
    // be used, so it is a region rather than a dialog and traps no focus.
    renderNotice();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("dismissing", () => {
  it("goes away when dismissed, and stays gone on the next visit", async () => {
    const user = userEvent.setup();
    const { unmount } = renderNotice();

    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("region", { name: /cookie notice/i })).toBeNull();
    expect(localStorage.getItem(KEY)).toBe("1");

    unmount();
    renderNotice();
    expect(screen.queryByRole("region", { name: /cookie notice/i })).toBeNull();
  });

  it("does not flash for a returning visitor", () => {
    // Read in the state initializer rather than an effect, so the bar is never
    // painted and then removed.
    localStorage.setItem(KEY, "1");
    renderNotice();
    expect(screen.queryByRole("region", { name: /cookie notice/i })).toBeNull();
  });
});

describe("clearing the footer", () => {
  /**
   * The bug these cover: the bar is fixed, so on a page too short to scroll it
   * covered the footer's legal row — which is where the link to the cookie
   * policy lives. The notice was hiding the one thing it pointed at, and no
   * amount of scrolling could reveal it.
   *
   * jsdom has no layout, so offsetHeight is always 0 and the *number* cannot
   * be asserted here — that was checked in a real browser. What is worth
   * pinning is the contract the CSS depends on: the property exists while the
   * bar does, and is gone the moment it is not.
   */
  const varName = "--cookie-notice-h";
  const published = () => document.documentElement.style.getPropertyValue(varName);

  it("publishes its height for the footer to clear", () => {
    renderNotice();
    expect(published()).not.toBe("");
  });

  it("hands the space back when dismissed", async () => {
    const user = userEvent.setup();
    renderNotice();
    await user.click(screen.getByRole("button", { name: "Got it" }));
    // Not "0px" — removed. A leftover property would leave every page holding
    // a strip of reserved emptiness under its footer forever.
    expect(published()).toBe("");
  });

  it("hands the space back on unmount too", () => {
    const { unmount } = renderNotice();
    unmount();
    expect(published()).toBe("");
  });

  it("publishes nothing at all for a returning visitor", () => {
    localStorage.setItem(KEY, "1");
    renderNotice();
    expect(published()).toBe("");
  });
});

describe("when storage is unavailable", () => {
  it("shows the notice rather than silently hiding it", () => {
    // Safari in private mode throws on access. Between the two failure modes,
    // showing an already-dismissed notice is an annoyance and hiding one that
    // was never shown is a disclosure that did not happen — so it fails toward
    // showing.
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    renderNotice();
    expect(screen.getByRole("region", { name: /cookie notice/i })).toBeInTheDocument();
  });

  it("still dismisses for the rest of the visit when the write throws", async () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const user = userEvent.setup();
    renderNotice();

    await user.click(screen.getByRole("button", { name: "Got it" }));
    // The dismissal cannot persist, but it must at least work now — a button
    // that visibly does nothing is worse than one that forgets.
    expect(screen.queryByRole("region", { name: /cookie notice/i })).toBeNull();
  });
});
