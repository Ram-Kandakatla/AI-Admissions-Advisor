// What a student sees when a page throws inside the real app.
//
// ErrorBoundary.test.tsx covers the boundary on its own. This covers the
// wiring — that it sits *inside* Layout rather than around the whole app, and
// that a caught error therefore leaves someone with a working nav instead of a
// full-page dead end.
//
// Its own file because it mocks a page module into throwing, and a mock like
// that leaking into App.test.tsx would quietly break unrelated route tests.
// Same reasoning as the backend's loggingD1Down.test.ts: a destructive premise
// gets a file whose whole premise is destruction.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { api } from "./api";
import type { AuthState } from "./types";

vi.mock("./api", () => ({
  api: {
    me: vi.fn(),
    meta: vi.fn(),
    student: vi.fn(),
    notes: vi.fn(),
    universities: vi.fn(),
  },
}));

// The explorer is the page under test purely because nothing else routes
// through it — any lazy page would do.
vi.mock("./components/UniversityExplorer", () => ({
  default: () => {
    throw new Error("Cannot read properties of undefined (reading 'majors')");
  },
}));

const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  mockApi.meta.mockResolvedValue({ majors: [], regions: [], financialNeed: [] });
  mockApi.me.mockResolvedValue({ user: null, studentId: null } as AuthState);
  mockApi.universities.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

describe("a page that throws", () => {
  it("shows the crash card in place of the page", async () => {
    renderAt("/explore");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Compass lost its bearing.")).toBeInTheDocument();
  });

  it("leaves the app navigable", async () => {
    renderAt("/explore");
    await screen.findByRole("alert");
    // The whole reason the boundary is inside Layout rather than around it.
    // Move it out and this is the assertion that fails.
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dark mode" })).toBeInTheDocument();
  });

  it("recovers when you click away", async () => {
    renderAt("/explore");
    await screen.findByRole("alert");

    await userEvent.click(screen.getByRole("link", { name: "Home" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: /Every application season feels like guesswork/ })
    ).toBeInTheDocument();
  });
});
