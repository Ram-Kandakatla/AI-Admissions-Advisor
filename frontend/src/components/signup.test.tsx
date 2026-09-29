import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Account from "./Account";
import { api } from "../api";
import { student } from "../test/factories";
import type { AuthUser, StudentRecord } from "../types";

vi.mock("../api", () => ({
  api: { signup: vi.fn(), login: vi.fn(), verifyTwoFactor: vi.fn() },
}));
const mockApi = vi.mocked(api);

const account: AuthUser = {
  id: 7,
  email: "jordan@example.com",
  guest: false,
  createdAt: "2026-09-12T10:00:00.000Z",
  twoFactorEnabled: false,
};

function renderSignup(guestProfile: StudentRecord | null = null, onSignedIn = vi.fn()) {
  render(
    <MemoryRouter initialEntries={["/signup"]}>
      <Account mode="signup" guestProfile={guestProfile} onSignedIn={onSignedIn} />
    </MemoryRouter>
  );
  return { onSignedIn };
}

async function requestSignup(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Email"), "jordan@example.com");
  await user.type(screen.getByLabelText(/^password/i), "correct horse battery");
  await user.click(screen.getByRole("button", { name: /create my account/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.signup.mockResolvedValue({
    user: account,
    studentId: "stu_1",
    discardedGuestProfile: false,
  });
});

describe("signing up", () => {
  it("creates the account and signs the caller in directly", async () => {
    const user = userEvent.setup();
    const { onSignedIn } = renderSignup();
    await requestSignup(user);

    await waitFor(() =>
      expect(mockApi.signup).toHaveBeenCalledWith("jordan@example.com", "correct horse battery")
    );
    expect(onSignedIn).toHaveBeenCalledWith(account, "stu_1", false);
  });

  it("tells the caller when signing in discards the account's own draft, and vice versa", async () => {
    mockApi.signup.mockResolvedValue({
      user: account,
      studentId: "stu_1",
      discardedGuestProfile: true,
    });
    const user = userEvent.setup();
    const { onSignedIn } = renderSignup(student({ name: "Ada" }));
    await requestSignup(user);

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(account, "stu_1", true));
  });

  it("shows a validation error and stays on the form", async () => {
    mockApi.signup.mockRejectedValue(new Error("Enter a valid email address."));
    const user = userEvent.setup();
    const { onSignedIn } = renderSignup();
    await requestSignup(user);

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid email address.");
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("shows the server's message when the address already has an account", async () => {
    mockApi.signup.mockRejectedValue(
      new Error("This email already has a Compass account. Sign in instead.")
    );
    const user = userEvent.setup();
    renderSignup();
    await requestSignup(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(/sign in instead/i);
  });

  it("has no forgot-password link — there is no reset flow", () => {
    renderSignup();
    expect(screen.queryByRole("link", { name: /forgot/i })).not.toBeInTheDocument();
  });
});
