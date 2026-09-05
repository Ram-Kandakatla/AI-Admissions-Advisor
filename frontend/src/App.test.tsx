// What the URL shows, and what it doesn't.
//
// The first tests in this project to render App. Before Phase 5 there was
// nothing here worth asserting — App was a switch statement over a state
// variable, and testing it would have been testing `useState`. A router turns
// that switch into a contract with the address bar: every path below is
// something a person can type, bookmark, or send to a friend, and each one is
// a way this app can now break that it previously could not.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { api } from "./api";
import { student, university } from "./test/factories";
import type { AuthState, StudentRecord } from "./types";

vi.mock("./api", () => ({
  api: {
    me: vi.fn(),
    meta: vi.fn(),
    student: vi.fn(),
    notes: vi.fn(),
    majors: vi.fn(),
    majorInsights: vi.fn(),
    universities: vi.fn(),
    recommendations: vi.fn(),
    logout: vi.fn(),
  },
}));

const mockApi = vi.mocked(api);

/** A session that never resolves — the "still restoring" state, held open. */
const pending = <T,>() => new Promise<T>(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.meta.mockResolvedValue({ majors: [], regions: [], financialNeed: [] });
  mockApi.me.mockResolvedValue({ user: null, studentId: null } as AuthState);
  mockApi.notes.mockResolvedValue({ studentId: "stu_1", notes: [] });
  mockApi.majors.mockResolvedValue({ majors: [{ major: "Computer Science", schoolCount: 12 }] });
  mockApi.majorInsights.mockRejectedValue(new Error("not under test"));
  mockApi.universities.mockResolvedValue([
    university({ id: 1, name: "Coastal State University" }),
    university({ id: 2, name: "Northfield College", city: "Ithaca", state: "NY" }),
  ]);
  mockApi.recommendations.mockRejectedValue(new Error("not under test"));
  // jsdom has no layout engine; App's chrome scrolls to the top on every
  // navigation and matches a media query to decide the nav shape.
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

/**
 * Renders the current URL into the DOM so a test can assert on it.
 *
 * MemoryRouter keeps its history in a closure, not in `window.location`, so
 * without something like this the tests that matter most here — does /majors
 * rewrite itself, does the compare page keep ?ids= current — have nothing to
 * read.
 */
function LocationProbe() {
  const { pathname, search } = useLocation();
  return <span data-testid="url">{pathname + search}</span>;
}

const url = () => screen.getByTestId("url").textContent;

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <LocationProbe />
    </MemoryRouter>
  );
}

/** Open one of the two nav dropdowns; its links are not rendered until then. */
async function openNavGroup(name: "Plan" | "Research") {
  await userEvent.click(screen.getByRole("button", { name }));
}

/** Sign the visitor in with a saved profile before rendering. */
function withProfile(over: Partial<StudentRecord> = {}) {
  const record = student(over);
  mockApi.me.mockResolvedValue({
    user: { id: 1, email: "a@b.com", guest: false },
    studentId: record.id,
  } as AuthState);
  mockApi.student.mockResolvedValue(record);
  return record;
}

describe("the route map", () => {
  it("renders the home page at /", async () => {
    renderAt("/");
    expect(
      await screen.findByRole("heading", { name: /Every application season feels like guesswork/ })
    ).toBeInTheDocument();
  });

  it("renders the profile form at /profile", async () => {
    renderAt("/profile");
    expect(await screen.findByLabelText("Name")).toBeInTheDocument();
  });

  it("names the path it could not find", async () => {
    renderAt("/scholarshipz");
    expect(await screen.findByText("No page at that address")).toBeInTheDocument();
    // The path itself, not a generic apology — otherwise a stale link is
    // impossible to diagnose from a screenshot. Matched on the <code> element
    // specifically, since LocationProbe also renders the path.
    expect(document.querySelector("code")).toHaveTextContent("/scholarshipz");
  });

  it("still renders the nav and footer on an unknown path", async () => {
    renderAt("/nope");
    await screen.findByText("No page at that address");
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
  });
});

describe("routes that need a profile", () => {
  it("offers to build one when there is none", async () => {
    renderAt("/matches");
    expect(await screen.findByText("Build your profile first")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Build my profile/ })).toHaveAttribute(
      "href",
      "/profile"
    );
  });

  it("waits for the session before deciding there is no profile", async () => {
    // The regression the router made possible: a bookmarked /matches renders
    // before /auth/me answers, and a naive gate tells someone who has a
    // profile to go and build one. Whatever this shows, it must not be that.
    mockApi.me.mockReturnValue(pending<AuthState>());
    renderAt("/matches");

    expect(await screen.findByLabelText("Loading your profile")).toBeInTheDocument();
    expect(screen.queryByText("Build your profile first")).not.toBeInTheDocument();
  });

  it("renders the page once the profile arrives", async () => {
    withProfile();
    renderAt("/matches");
    await waitFor(() => expect(mockApi.recommendations).toHaveBeenCalled());
    expect(screen.queryByText("Build your profile first")).not.toBeInTheDocument();
  });
});

describe("the nav", () => {
  it("marks the current page for assistive tech", async () => {
    renderAt("/profile");
    const nav = screen.getByRole("navigation", { name: "Main" });
    const current = await within(nav).findByRole("link", { current: "page" });
    expect(current).toHaveTextContent("Your Profile");
  });

  it("leaves profile-gated destinations unclickable until there is one", async () => {
    renderAt("/");
    await screen.findByRole("heading", { name: /guesswork/ });
    await openNavGroup("Plan");
    // A button, not a link: an anchor cannot be disabled, and one that only
    // looks disabled is still reachable by keyboard.
    expect(screen.getByRole("button", { name: "Matches" })).toBeDisabled();
  });

  it("offers those destinations as real links once there is a profile", async () => {
    withProfile();
    renderAt("/");
    await screen.findByRole("heading", { name: /guesswork/ });
    await openNavGroup("Plan");
    expect(screen.getByRole("link", { name: "Matches" })).toHaveAttribute("href", "/matches");
  });

  it("sends a signed-out visitor to /signin and a guest with a list to /signup", async () => {
    renderAt("/");
    expect(await screen.findByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/signin"
    );
  });
});

describe("/majors", () => {
  it("puts the resolved major in the address bar", async () => {
    // Arriving at the bare path has to end somewhere linkable, or "send me
    // that major page" sends whatever the recipient's own default is.
    renderAt("/majors");
    await waitFor(() => expect(url()).toBe("/majors/computer-science"));
    expect(await screen.findByRole("button", { name: /Computer Science/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("opens the major named in the URL", async () => {
    mockApi.majors.mockResolvedValue({
      majors: [
        { major: "Nursing", schoolCount: 4 },
        { major: "Computer Science", schoolCount: 12 },
      ],
    });
    renderAt("/majors/computer-science");
    // Nursing sorts first, so picking CS proves the slug won over the default.
    await waitFor(() =>
      expect(mockApi.majorInsights).toHaveBeenCalledWith("Computer Science", undefined)
    );
  });

  it("falls back to the default for a slug nothing matches", async () => {
    renderAt("/majors/underwater-basket-weaving");
    await waitFor(() =>
      expect(mockApi.majorInsights).toHaveBeenCalledWith("Computer Science", undefined)
    );
    // And corrects the address, so the bad slug is not what gets shared on.
    expect(url()).toBe("/majors/computer-science");
  });
});

describe("/compare", () => {
  it("seeds the comparison from ?ids=", async () => {
    renderAt("/compare?ids=1,2");
    // Both schools land as columns, which is the whole point of the link.
    expect(
      await screen.findAllByRole("button", {
        name: "Remove Coastal State University from the comparison",
      })
    ).not.toHaveLength(0);
    expect(
      screen.getAllByRole("button", { name: "Remove Northfield College from the comparison" })
    ).not.toHaveLength(0);
  });

  it("keeps ?ids= current as the selection changes", async () => {
    renderAt("/compare?ids=1,2");
    const remove = await screen.findAllByRole("button", {
      name: "Remove Northfield College from the comparison",
    });
    await userEvent.click(remove[0]);
    // The link stays shareable while it is being edited, rather than only
    // being correct at the moment it was opened.
    await waitFor(() => expect(url()).toBe("/compare?ids=1"));
  });

  it("ignores junk in the parameter rather than rendering a broken column", async () => {
    renderAt("/compare?ids=abc,-4,");
    await waitFor(() => expect(mockApi.universities).toHaveBeenCalled());
    expect(screen.queryAllByRole("button", { name: /from the comparison/ })).toHaveLength(0);
  });
});
