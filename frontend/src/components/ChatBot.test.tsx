import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatBot from "./ChatBot";
import { api } from "../api";
import { student } from "../test/factories";
import type { ChatMode } from "../types";

vi.mock("../api", () => ({
  api: {
    health: vi.fn(),
    chat: vi.fn(),
    chatHistory: vi.fn(),
  },
}));

const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.health.mockResolvedValue({ status: "ok", llm: "fallback" });
  mockApi.chatHistory.mockResolvedValue({ mode: "advising", messages: [] });
  mockApi.chat.mockResolvedValue({ answer: "An answer.", source: "fallback", mode: "advising" });
});

function renderChat(props: Partial<Parameters<typeof ChatBot>[0]> = {}) {
  const onModeChange = vi.fn();
  render(
    <MemoryRouter>
      <ChatBot student={null} onModeChange={onModeChange} {...props} />
    </MemoryRouter>
  );
  return { onModeChange };
}

describe("the assistant switch", () => {
  it("offers both assistants, with advising pressed by default", () => {
    renderChat();
    const group = screen.getByRole("group", { name: "Choose an assistant" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Admissions" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "Essays" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("reports a switch upward rather than owning the state", async () => {
    const user = userEvent.setup();
    const { onModeChange } = renderChat();
    await user.click(screen.getByRole("button", { name: "Essays" }));
    // The mode lives in the URL (ChatRoute), so the component asks rather than
    // setting it — otherwise the address bar and the panel could disagree.
    expect(onModeChange).toHaveBeenCalledWith("essay");
  });

  it("renders the essay assistant when told it is the mode", () => {
    renderChat({ mode: "essay" });
    expect(screen.getByRole("button", { name: "Essays" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your essay, in your voice.");
    expect(screen.getByText(/Essay brainstorm/)).toBeInTheDocument();
  });

  it("shows admissions starters in advising mode", () => {
    renderChat();
    expect(screen.getByRole("button", { name: "How does the FAFSA work?" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "How do I pick a topic?" })).toBeNull();
  });

  it("shows essay starters in essay mode", () => {
    renderChat({ mode: "essay" });
    expect(screen.getByRole("button", { name: "How do I pick a topic?" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "How does the FAFSA work?" })).toBeNull();
  });
});

describe("sending", () => {
  it("sends the active mode with the question", async () => {
    const user = userEvent.setup();
    renderChat({ mode: "essay", student: student() });
    await user.type(screen.getByLabelText("Your question"), "What should I write about?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(mockApi.chat).toHaveBeenCalledWith("What should I write about?", "stu_1", "essay")
    );
  });

  it("defaults to advising", async () => {
    const user = userEvent.setup();
    renderChat();
    await user.type(screen.getByLabelText("Your question"), "When is ED?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(mockApi.chat).toHaveBeenCalledWith("When is ED?", undefined, "advising")
    );
  });

  it("shows the answer in the thread", async () => {
    const user = userEvent.setup();
    mockApi.chat.mockResolvedValue({ answer: "Start with a list.", source: "fallback", mode: "essay" });
    renderChat({ mode: "essay" });
    await user.click(screen.getByRole("button", { name: "How do I pick a topic?" }));

    expect(await screen.findByText("Start with a list.")).toBeInTheDocument();
  });

  it("surfaces a failed request in the thread rather than swallowing it", async () => {
    const user = userEvent.setup();
    mockApi.chat.mockRejectedValue(new Error("Too many questions"));
    renderChat();
    await user.click(screen.getByRole("button", { name: "How does the FAFSA work?" }));

    expect(await screen.findByText(/Too many questions/)).toBeInTheDocument();
  });
});

describe("threads", () => {
  it("loads the saved thread for the active mode", async () => {
    mockApi.chatHistory.mockResolvedValue({
      mode: "essay",
      messages: [{ role: "user", content: "Earlier essay question" }],
    });
    renderChat({ mode: "essay", student: student() });

    await waitFor(() => expect(mockApi.chatHistory).toHaveBeenCalledWith("stu_1", "essay"));
    expect(await screen.findByText("Earlier essay question")).toBeInTheDocument();
  });

  it("asks for nothing when there is no profile to hang a thread off", () => {
    renderChat({ student: null });
    expect(mockApi.chatHistory).not.toHaveBeenCalled();
  });

  // An answer that lands after the student has flipped modes belongs to the
  // thread it was asked in, not to whichever one happens to be open.
  it("files a slow answer under the mode it was asked in", async () => {
    const user = userEvent.setup();
    let resolve: (v: { answer: string; source: "fallback"; mode: ChatMode }) => void = () => {};
    mockApi.chat.mockReturnValue(new Promise((r) => (resolve = r)));

    const { rerender } = render(
      <MemoryRouter>
        <ChatBot student={null} mode="advising" onModeChange={vi.fn()} />
      </MemoryRouter>
    );

    await user.click(screen.getByRole("button", { name: "How does the FAFSA work?" }));
    // Flip to essays while the request is still in flight.
    rerender(
      <MemoryRouter>
        <ChatBot student={null} mode="essay" onModeChange={vi.fn()} />
      </MemoryRouter>
    );
    resolve({ answer: "Advising answer.", source: "fallback", mode: "advising" });

    // The essay panel must not show it.
    await waitFor(() => expect(screen.queryByText("Advising answer.")).toBeNull());

    rerender(
      <MemoryRouter>
        <ChatBot student={null} mode="advising" onModeChange={vi.fn()} />
      </MemoryRouter>
    );
    expect(await screen.findByText("Advising answer.")).toBeInTheDocument();
  });

  it("keeps a thread when you switch away and back", async () => {
    const user = userEvent.setup();
    mockApi.chat.mockResolvedValue({ answer: "Advising answer.", source: "fallback", mode: "advising" });

    const { rerender } = render(
      <MemoryRouter>
        <ChatBot student={null} mode="advising" onModeChange={vi.fn()} />
      </MemoryRouter>
    );
    await user.click(screen.getByRole("button", { name: "How does the FAFSA work?" }));
    expect(await screen.findByText("Advising answer.")).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <ChatBot student={null} mode="essay" onModeChange={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.queryByText("Advising answer.")).toBeNull();

    rerender(
      <MemoryRouter>
        <ChatBot student={null} mode="advising" onModeChange={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.getByText("Advising answer.")).toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("announces arriving answers politely", () => {
    renderChat();
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(log).toHaveAccessibleName("Compass advisor conversation");
  });
});
