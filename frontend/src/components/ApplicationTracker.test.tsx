import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ApplicationTracker from "./ApplicationTracker";
import { api } from "../api";
import { application, applicationMeta, student, university } from "../test/factories";
import { EMPTY_NOTES } from "../useSchoolNotes";
import type { Application } from "../types";

vi.mock("../api", () => ({
  api: {
    applicationMeta: vi.fn(),
    applications: vi.fn(),
    universities: vi.fn(),
    trackApplication: vi.fn(),
    updateApplication: vi.fn(),
    untrackApplication: vi.fn(),
  },
}));

const mockApi = vi.mocked(api);

const coastal = university({ id: 1, name: "Coastal State University" });
const northfield = university({ id: 2, name: "Northfield College", city: "Ithaca", state: "NY" });

/** userEvent needs to drive the fake clock, or its internal waits never fire. */
function setup() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

/**
 * The tracker links to /matches from its empty state, so it needs a router
 * around it. MemoryRouter rather than BrowserRouter: no jsdom history to
 * reset between tests, and the location is inspectable if a test ever needs
 * to assert where a click went.
 */
function renderTracker(apps: Application[]) {
  mockApi.applications.mockResolvedValue({
    studentId: "stu_1",
    cycleYear: 2026,
    applications: apps,
  });
  render(
    <MemoryRouter>
      <ApplicationTracker student={student()} notes={EMPTY_NOTES} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Deadlines are compared against "today", so the clock is pinned. The suite
  // also runs in America/New_York (vitest.config.ts) — a UTC runner would
  // read every date-only deadline as the day before.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 9, 15));
  mockApi.applicationMeta.mockResolvedValue(applicationMeta());
  mockApi.universities.mockResolvedValue([coastal, northfield]);
  mockApi.applications.mockResolvedValue({
    studentId: "stu_1",
    cycleYear: 2026,
    applications: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loading", () => {
  it("shows a labelled spinner before the three requests land", () => {
    render(
      <MemoryRouter>
        <ApplicationTracker student={student()} notes={EMPTY_NOTES} />
      </MemoryRouter>
    );
    expect(screen.getByLabelText("Loading your tracker")).toBeInTheDocument();
  });

  it("says so when the tracker can't load at all", async () => {
    mockApi.applications.mockRejectedValue(new Error("Not signed in"));
    render(
      <MemoryRouter>
        <ApplicationTracker student={student()} notes={EMPTY_NOTES} />
      </MemoryRouter>
    );
    expect(await screen.findByText("Couldn't load your tracker")).toBeInTheDocument();
    expect(screen.getByText("Not signed in")).toBeInTheDocument();
  });
});

describe("the empty tracker", () => {
  it("points at the matches rather than a blank page", async () => {
    renderTracker([]);

    expect(await screen.findByText("Nothing tracked yet")).toBeInTheDocument();
    // Asserting the destination rather than that a callback fired: since the
    // router landed this is a real anchor, and where it points is the thing
    // that can silently break.
    expect(screen.getByRole("link", { name: /See my matches/ })).toHaveAttribute(
      "href",
      "/matches"
    );
  });
});

describe("the list", () => {
  it("orders by deadline and puts rolling admission last", async () => {
    // Server order is not relied on: editing a deadline in place has to
    // re-sort the card and the timeline, so the sort runs on every render.
    renderTracker([
      application({ id: "a", deadline: null, university: { ...coastal, shortName: "Coastal" } }),
      application({
        id: "b",
        deadline: "2027-01-05",
        universityId: 2,
        university: { ...northfield, shortName: "Northfield" },
      }),
      application({ id: "c", deadline: "2026-11-01" }),
    ]);

    await screen.findByText("Your applications");
    const names = screen.getAllByRole("article").map((card) => within(card).getByRole("heading", { level: 3 }).textContent);
    expect(names).toEqual([
      "Coastal State University", // Nov 1
      "Northfield College", // Jan 5
      "Coastal State University", // rolling, no date
    ]);
  });

  it("counts what is open, what is done, and what is next", async () => {
    renderTracker([
      application({ id: "a", status: "submitted", deadline: "2026-11-01" }),
      application({ id: "b", status: "planning", deadline: "2026-12-01" }),
      application({ id: "c", status: "in-progress", deadline: "2027-01-05" }),
    ]);

    await screen.findByText("Your applications");
    expect(screen.getByText("Still open").previousElementSibling).toHaveTextContent("2");
    expect(screen.getByText("Sent or decided").previousElementSibling).toHaveTextContent("1");
    // Next open deadline is Dec 1, 47 days out from the pinned Oct 15.
    const nextStat = screen.getByText("Next deadline").parentElement!;
    expect(within(nextStat).getByText("Dec 1")).toBeInTheDocument();
    // Scoped to the summary tile: the same countdown also appears on the card
    // and in the timeline, which is the point of the tile, not a duplicate bug.
    expect(nextStat).toHaveTextContent("47 days left");
  });

  it("groups the timeline by calendar month", async () => {
    renderTracker([
      application({ id: "a", deadline: "2026-11-01" }),
      application({ id: "b", deadline: "2026-11-15" }),
      application({ id: "c", deadline: "2027-01-05" }),
      application({ id: "d", deadline: null }),
    ]);

    const timeline = await screen.findByRole("region", { name: "Deadline timeline" });
    const months = within(timeline)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(months).toEqual(["November 2026", "January 2027", "Rolling — no fixed date"]);
  });

  it("flags a date that is only the convention for the plan", async () => {
    renderTracker([application({ deadlineIsTypical: true, deadline: "2027-01-05" })]);
    expect(await screen.findByText("typical date — confirm")).toBeInTheDocument();
  });

  it("stops counting down once a decision is in", async () => {
    renderTracker([application({ status: "accepted", deadline: "2026-11-01" })]);
    await screen.findByText("Your applications");
    const card = screen.getByRole("article");
    expect(within(card).getByRole("combobox", { name: "Status" })).toHaveValue("accepted");
    expect(within(card).getAllByText("Accepted").length).toBeGreaterThan(0);
    expect(within(card).queryByText(/days left/)).not.toBeInTheDocument();
  });
});

describe("the binding-application warning", () => {
  it("stays quiet for a single Early Decision", async () => {
    renderTracker([application({ id: "a", plan: "ED" }), application({ id: "b", plan: "RD" })]);
    await screen.findByText("Your applications");
    expect(screen.queryByText(/binding applications/)).not.toBeInTheDocument();
  });

  it("warns when two binding plans are held at once", async () => {
    // ED is a commitment to enroll if admitted, so holding two is a plan that
    // cannot legally happen — worth catching before the essays get written.
    renderTracker([application({ id: "a", plan: "ED" }), application({ id: "b", plan: "ED2" })]);
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => a.textContent?.includes("2 binding applications"))).toBe(true);
  });

  it("does not count a withdrawn one", async () => {
    renderTracker([
      application({ id: "a", plan: "ED" }),
      application({ id: "b", plan: "ED2", status: "withdrawn" }),
    ]);
    await screen.findByText("Your applications");
    expect(screen.queryByText(/binding applications/)).not.toBeInTheDocument();
  });
});

describe("adding a school", () => {
  it("offers only schools that aren't tracked yet", async () => {
    renderTracker([application({ universityId: 1 })]);
    await screen.findByText("Your applications");

    const select = screen.getByLabelText("Add a school");
    const options = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Choose a university…", "Northfield College — Ithaca, NY"]);
  });

  it("closes itself off when every school is tracked", async () => {
    renderTracker([
      application({ id: "a", universityId: 1 }),
      application({ id: "b", universityId: 2 }),
    ]);
    await screen.findByText("Your applications");

    const select = screen.getByLabelText("Add a school");
    expect(select).toBeDisabled();
    expect(within(select).getByRole("option")).toHaveTextContent("Every school is tracked");
  });

  it("tracks the chosen school and puts it in the list", async () => {
    const user = setup();
    renderTracker([]);
    await screen.findByText("Nothing tracked yet");

    const created = application({
      id: "new",
      universityId: 2,
      plan: "EA",
      deadline: "2026-11-01",
      university: { ...northfield, shortName: "Northfield" },
    });
    mockApi.trackApplication.mockResolvedValue(created);

    await user.selectOptions(screen.getByLabelText("Add a school"), "2");
    await user.selectOptions(screen.getByLabelText("Decision plan"), "EA");
    await user.click(screen.getByRole("button", { name: "Track it" }));

    await waitFor(() =>
      expect(mockApi.trackApplication).toHaveBeenCalledWith("stu_1", {
        universityId: 2,
        plan: "EA",
      })
    );
    const card = await screen.findByRole("article");
    expect(within(card).getByRole("heading", { level: 3 })).toHaveTextContent(
      "Northfield College"
    );
  });

  it("keeps the button inert until a school is chosen", async () => {
    renderTracker([]);
    await screen.findByText("Nothing tracked yet");
    expect(screen.getByRole("button", { name: "Track it" })).toBeDisabled();
  });

  it("reports a failed add without wiping the list", async () => {
    const user = setup();
    renderTracker([application({ universityId: 1 })]);
    await screen.findByText("Your applications");
    mockApi.trackApplication.mockRejectedValue(new Error("Forbidden"));

    await user.selectOptions(screen.getByLabelText("Add a school"), "2");
    await user.click(screen.getByRole("button", { name: "Track it" }));

    await waitFor(() => expect(screen.getByText("Forbidden")).toBeInTheDocument());
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });
});

describe("editing an application", () => {
  it("ticks a checklist item straight away and saves it", async () => {
    const user = setup();
    const app = application({ id: "app_1" });
    renderTracker([app]);
    await screen.findByText("Your applications");
    mockApi.updateApplication.mockResolvedValue({
      ...app,
      checklist: { ...app.checklist, essay: true },
    });

    await user.click(screen.getByRole("checkbox", { name: "Personal essay" }));

    expect(screen.getByRole("checkbox", { name: "Personal essay" })).toBeChecked();
    expect(screen.getByText("1 of 7 done")).toBeInTheDocument();
    await waitFor(() =>
      expect(mockApi.updateApplication).toHaveBeenCalledWith("stu_1", "app_1", {
        checklist: { essay: true },
      })
    );
  });

  it("marks an edited deadline as no longer the typical one", async () => {
    const user = setup();
    const app = application({ id: "app_1", deadline: "2027-01-05", deadlineIsTypical: true });
    renderTracker([app]);
    await screen.findByText("Your applications");
    mockApi.updateApplication.mockResolvedValue({
      ...app,
      deadline: "2026-11-30",
      deadlineIsTypical: false,
    });

    const field = screen.getByLabelText("Deadline");
    await user.clear(field);
    await user.type(field, "2026-11-30");

    await waitFor(() => expect(mockApi.updateApplication).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText("typical date — confirm")).not.toBeInTheDocument()
    );
  });

  it("re-reads the server's copy when a patch is rejected", async () => {
    // The optimistic tick is a lie the moment the write fails, and a checklist
    // that shows work as done when the server disagrees is worse than a slow one.
    const user = setup();
    const app = application({ id: "app_1" });
    renderTracker([app]);
    await screen.findByText("Your applications");

    mockApi.updateApplication.mockRejectedValue(new Error("Forbidden"));
    mockApi.applications.mockResolvedValue({
      studentId: "stu_1",
      cycleYear: 2026,
      applications: [app],
    });

    await user.click(screen.getByRole("checkbox", { name: "Personal essay" }));

    await waitFor(() => expect(screen.getByText("Forbidden")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Personal essay" })).not.toBeChecked()
    );
  });
});

describe("removing an application", () => {
  it("drops the card and tells the server", async () => {
    const user = setup();
    renderTracker([application({ id: "app_1" })]);
    await screen.findByText("Your applications");
    mockApi.untrackApplication.mockResolvedValue(undefined);

    await user.click(
      screen.getByRole("button", { name: "Stop tracking Coastal State University" })
    );

    await waitFor(() => expect(screen.queryByRole("article")).not.toBeInTheDocument());
    expect(mockApi.untrackApplication).toHaveBeenCalledWith("stu_1", "app_1");
  });

  it("puts the card back if the server refuses", async () => {
    const user = setup();
    renderTracker([application({ id: "app_1" })]);
    await screen.findByText("Your applications");
    mockApi.untrackApplication.mockRejectedValue(new Error("Forbidden"));

    await user.click(
      screen.getByRole("button", { name: "Stop tracking Coastal State University" })
    );

    await waitFor(() => expect(screen.getByText("Forbidden")).toBeInTheDocument());
    expect(screen.getByRole("article")).toBeInTheDocument();
  });
});
