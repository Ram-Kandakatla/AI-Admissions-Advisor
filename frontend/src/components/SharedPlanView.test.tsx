import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SharedPlanView from "./SharedPlanView";
import { api } from "../api";
import { recommendation, scholarship, schoolNote } from "../test/factories";
import type { SharedPlan } from "../types";

vi.mock("../api", () => ({ api: { sharedPlan: vi.fn() } }));

const mockApi = vi.mocked(api);

function plan(over: Partial<SharedPlan> = {}): SharedPlan {
  return {
    sharedAt: "2026-10-15T12:00:00.000Z",
    cycleYear: 2026,
    student: {
      name: "Sam Rivera",
      gpa: 3.8,
      satScore: 1450,
      actScore: null,
      interestedMajors: ["CS"],
      extracurriculars: ["Robotics captain"],
      careerGoals: "Build medical devices.",
      preferredRegions: ["West"],
    },
    // Distinct names per section, so a query for one cannot accidentally match
    // another — every factory defaults to the same school.
    recommendations: {
      reach: [recommendation({ tier: "reach", id: 7, name: "Highcliff University" })],
      target: [],
      safety: [],
    },
    scholarships: { reach: [], target: [scholarship({ tier: "target" })], safety: [] },
    applications: [
      {
        universityId: 1,
        plan: "EA",
        status: "in-progress",
        deadline: "2026-11-01",
        deadlineIsTypical: true,
        checklist: {
          essay: true,
          supplements: false,
          recommendations: true,
          transcript: false,
          testScores: false,
          fee: false,
          aid: false,
        },
        notes: "",
        university: {
          id: 1,
          name: "Coastal State University",
          shortName: "Coastal State",
          city: "Monterey",
          state: "CA",
          acceptanceRate: 42,
        },
      },
    ],
    notes: [
      schoolNote({
        starred: true,
        note: "Loved the labs.",
        universityId: 9,
        university: {
          id: 9,
          name: "Northfield College",
          shortName: "Northfield",
          city: "Ithaca",
          state: "NY",
          region: "Northeast",
          acceptanceRate: 38,
          tuition: 41_000,
        },
      }),
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.sharedPlan.mockResolvedValue(plan());
});

describe("loading and failure", () => {
  it("asks for the plan by token", async () => {
    render(<SharedPlanView token="tok-123" />);
    expect(screen.getByLabelText("Loading the shared plan")).toBeInTheDocument();
    await screen.findByRole("heading", { level: 1 });
    expect(mockApi.sharedPlan).toHaveBeenCalledWith("tok-123");
  });

  // Revoked and never-existed are one 404 on the server, so the page must not
  // imply which happened either.
  it("explains a dead link without saying whether it was ever real", async () => {
    mockApi.sharedPlan.mockRejectedValue(new Error("This link is no longer active."));
    render(<SharedPlanView token="dead" />);

    expect(await screen.findByText("This link isn't active")).toBeInTheDocument();
    expect(screen.getByText(/turned sharing off or replaced this link/)).toBeInTheDocument();
  });
});

describe("what it shows", () => {
  it("names whose plan it is, and that it is read-only", async () => {
    render(<SharedPlanView token="t" />);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "Sam Rivera's college plan"
    );
    expect(screen.getByText(/read only/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing here can be changed/)).toBeInTheDocument();
  });

  it("shows the profile behind the list", async () => {
    render(<SharedPlanView token="t" />);
    expect(await screen.findByText("GPA")).toBeInTheDocument();
    expect(screen.getByText("3.8")).toBeInTheDocument();
    expect(screen.getByText("1450")).toBeInTheDocument();
    expect(screen.getByText(/Build medical devices/)).toBeInTheDocument();
  });

  it("omits a score the student never gave rather than printing a blank", async () => {
    render(<SharedPlanView token="t" />);
    await screen.findByText("GPA");
    expect(screen.queryByText("ACT")).toBeNull();
  });

  it("lists applications with their deadline and progress", async () => {
    render(<SharedPlanView token="t" />);
    expect(await screen.findByText("Coastal State University")).toBeInTheDocument();
    expect(screen.getByText("EA · In progress")).toBeInTheDocument();
    expect(screen.getByText("2 of 7 to-dos done")).toBeInTheDocument();
  });

  // The same honesty the tracker and the .ics export carry: a date that is
  // only the convention for the plan says so wherever it appears.
  it("carries the unconfirmed-deadline caveat", async () => {
    render(<SharedPlanView token="t" />);
    expect(await screen.findByText(/usual date for this plan, not confirmed/)).toBeInTheDocument();
  });

  it("shows the matches and the saved notes", async () => {
    render(<SharedPlanView token="t" />);
    expect(await screen.findByText("Highcliff University")).toBeInTheDocument();
    expect(screen.getByText("Northfield College")).toBeInTheDocument();
    expect(screen.getByText("Loved the labs.")).toBeInTheDocument();
  });

  it("copes with a plan that has nothing on it yet", async () => {
    mockApi.sharedPlan.mockResolvedValue(
      plan({
        applications: [],
        notes: [],
        recommendations: { reach: [], target: [], safety: [] },
        scholarships: { reach: [], target: [], safety: [] },
      })
    );
    render(<SharedPlanView token="t" />);
    expect(await screen.findByText("Nothing tracked yet.")).toBeInTheDocument();
  });
});

// The load-bearing tests. This page is opened by someone who is not the
// student and holds no account; a control appearing here would let them edit a
// plan that is not theirs.
describe("it is genuinely read-only", () => {
  it("renders no buttons at all", async () => {
    render(<SharedPlanView token="t" />);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("renders no form controls — no checkboxes, no text inputs", async () => {
    render(<SharedPlanView token="t" />);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("shows checklist progress as a read-out, not as tickable boxes", async () => {
    render(<SharedPlanView token="t" />);
    expect(await screen.findByText("2 of 7 to-dos done")).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  // The token is in this page's own URL. Without rel="noreferrer" the Referer
  // header hands the entire share link to every sponsor site a reader clicks.
  it("strips the referrer from every outbound link", async () => {
    render(<SharedPlanView token="t" />);
    await screen.findByRole("heading", { level: 1 });
    const links = screen.queryAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
    }
  });
});
