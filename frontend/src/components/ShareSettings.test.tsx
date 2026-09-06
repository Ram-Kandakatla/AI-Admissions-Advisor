import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ShareSettings from "./ShareSettings";
import { api } from "../api";
import { student } from "../test/factories";

vi.mock("../api", () => ({
  api: {
    shareLink: vi.fn(),
    createShareLink: vi.fn(),
    revokeShareLink: vi.fn(),
  },
}));

const mockApi = vi.mocked(api);
const TOKEN = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.shareLink.mockResolvedValue({ link: null });
  mockApi.createShareLink.mockResolvedValue({
    link: { token: TOKEN, createdAt: "2026-09-05T00:00:00.000Z" },
  });
  mockApi.revokeShareLink.mockResolvedValue(undefined);
});

const renderSettings = () => render(<ShareSettings student={student()} />);

describe("when sharing is off", () => {
  it("says so, and offers to create a link", async () => {
    renderSettings();
    expect(await screen.findByText("Sharing is off")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create a share link/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Your share link")).toBeNull();
  });

  it("creates one on request and shows the full URL", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(await screen.findByRole("button", { name: /Create a share link/ }));

    const field = await screen.findByLabelText("Your share link");
    expect(field).toHaveValue(`${window.location.origin}/shared/${TOKEN}`);
    expect(mockApi.createShareLink).toHaveBeenCalledWith("stu_1");
  });
});

describe("when a link exists", () => {
  beforeEach(() => {
    mockApi.shareLink.mockResolvedValue({
      link: { token: TOKEN, createdAt: "2026-09-05T00:00:00.000Z" },
    });
  });

  it("shows the URL read-only, so it cannot be edited into a broken link", async () => {
    renderSettings();
    const field = await screen.findByLabelText("Your share link");
    expect(field).toHaveAttribute("readonly");
  });

  it("copies to the clipboard and confirms in a live region", async () => {
    const user = userEvent.setup();
    // AFTER setup(), and that ordering is the whole trick: user-event installs
    // its own clipboard stub when it initialises, so a mock defined first is
    // silently replaced and never called. navigator.clipboard is also
    // getter-only in jsdom, hence defineProperty rather than assignment.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderSettings();

    await user.click(await screen.findByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/shared/${TOKEN}`);
    // The button's label changing is not announced on its own.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Link copied"));
  });

  it("survives a browser that refuses clipboard access", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    renderSettings();

    await user.click(await screen.findByRole("button", { name: "Copy link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/select the link/i);
    // The URL is still there to copy by hand.
    expect(screen.getByLabelText("Your share link")).toBeInTheDocument();
  });

  it("revokes without ceremony", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(await screen.findByRole("button", { name: "Turn sharing off" }));

    expect(mockApi.revokeShareLink).toHaveBeenCalledWith("stu_1");
    expect(await screen.findByText("Sharing is off")).toBeInTheDocument();
  });

  // Replacing breaks a URL that may already be in someone's inbox, so it asks
  // first. Revoking does not, because "off" is the safe direction.
  it("confirms before replacing, and says what replacing costs", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(await screen.findByRole("button", { name: "Replace with a new link" }));

    expect(screen.getByText(/breaks the old link straight away/)).toBeInTheDocument();
    expect(mockApi.createShareLink).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Replace it" }));
    expect(mockApi.createShareLink).toHaveBeenCalledWith("stu_1", true);
  });

  it("lets you back out of replacing", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(await screen.findByRole("button", { name: "Replace with a new link" }));
    await user.click(screen.getByRole("button", { name: "Keep the current link" }));

    expect(mockApi.createShareLink).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Replace with a new link" })).toBeInTheDocument();
  });

  it("reports a failed revoke instead of pretending it worked", async () => {
    mockApi.revokeShareLink.mockRejectedValue(new Error("Network down"));
    const user = userEvent.setup();
    renderSettings();
    await user.click(await screen.findByRole("button", { name: "Turn sharing off" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Network down");
    // Still shown as live, because as far as we know it is.
    expect(screen.getByLabelText("Your share link")).toBeInTheDocument();
  });
});

// The screen's real job. A student cannot consent to sharing something they
// have not been told they are sharing, so this list is not decoration.
describe("what the page discloses before you press anything", () => {
  it("names what a reader will see", async () => {
    renderSettings();
    expect(await screen.findByText("What they'll see")).toBeInTheDocument();
    expect(screen.getByText(/GPA, test scores/)).toBeInTheDocument();
    expect(screen.getByText(/notes you wrote on them/)).toBeInTheDocument();
  });

  it("names what stays private, chat first", async () => {
    renderSettings();
    expect(await screen.findByText("What stays private")).toBeInTheDocument();
    expect(screen.getByText(/conversations with Compass/)).toBeInTheDocument();
    expect(screen.getByText(/financial help/)).toBeInTheDocument();
  });

  it("says plainly that the link is a password", async () => {
    renderSettings();
    expect(await screen.findByText(/anyone who has it can open your plan/)).toBeInTheDocument();
    expect(screen.getByText(/including anyone it gets forwarded to/)).toBeInTheDocument();
  });
});
