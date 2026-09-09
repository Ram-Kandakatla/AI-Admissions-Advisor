import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ForgotPassword from "./ForgotPassword";
import ResetPassword from "./ResetPassword";
import { api } from "../api";
import type { AuthUser } from "../types";

vi.mock("../api", () => ({
  api: { forgotPassword: vi.fn(), resetPassword: vi.fn() },
}));
const mockApi = vi.mocked(api);

const user_: AuthUser = {
  id: 1,
  email: "jordan@example.com",
  guest: false,
  createdAt: "2026-03-04T10:00:00.000Z",
};

function renderForgot() {
  render(
    <MemoryRouter>
      <ForgotPassword />
    </MemoryRouter>
  );
}

function renderReset(search = "?token=abc123", onSignedIn = vi.fn()) {
  render(
    <MemoryRouter initialEntries={[`/reset${search}`]}>
      <Routes>
        <Route path="/reset" element={<ResetPassword onSignedIn={onSignedIn} />} />
      </Routes>
    </MemoryRouter>
  );
  return { onSignedIn };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.forgotPassword.mockResolvedValue({ message: "ok" });
  mockApi.resetPassword.mockResolvedValue({ user: user_, studentId: "stu_1" });
});

describe("asking for a link", () => {
  it("sends the address and confirms without saying whether it exists", async () => {
    const user = userEvent.setup();
    renderForgot();

    await user.type(screen.getByLabelText(/email/i), "jordan@example.com");
    await user.click(screen.getByRole("button", { name: /send me a link/i }));

    await waitFor(() => expect(mockApi.forgotPassword).toHaveBeenCalledWith("jordan@example.com"));
    expect(screen.getByText(/check your email/i)).toBeInTheDocument();
    // The conditional is the whole point — see the note on the component.
    expect(screen.getByText(/if an account exists/i)).toBeInTheDocument();
  });

  /**
   * The assertion most likely to be broken by a well-meaning edit. The obvious
   * "improvement" to this screen is to say "no account found — want to sign
   * up?", and that single sentence turns the page into a way to test a list of
   * addresses for membership.
   */
  it("never claims an email was actually sent", async () => {
    const user = userEvent.setup();
    renderForgot();
    await user.type(screen.getByLabelText(/email/i), "nobody@example.com");
    await user.click(screen.getByRole("button", { name: /send me a link/i }));

    await screen.findByText(/check your email/i);
    const page = document.body.textContent ?? "";
    expect(page).not.toMatch(/we (have )?sent you/i);
    expect(page).not.toMatch(/no account/i);
    expect(page).not.toMatch(/not found/i);
    expect(page).not.toMatch(/doesn't exist|does not exist/i);
  });

  it("says that asking changes nothing, so a stray request isn't alarming", async () => {
    const user = userEvent.setup();
    renderForgot();
    await user.type(screen.getByLabelText(/email/i), "jordan@example.com");
    await user.click(screen.getByRole("button", { name: /send me a link/i }));

    await screen.findByText(/nothing has changed on your account yet/i);
  });

  it("lets you go back and try a different address", async () => {
    const user = userEvent.setup();
    renderForgot();
    await user.type(screen.getByLabelText(/email/i), "typo@example.com");
    await user.click(screen.getByRole("button", { name: /send me a link/i }));

    await user.click(await screen.findByRole("button", { name: /try a different address/i }));
    expect(screen.getByRole("button", { name: /send me a link/i })).toBeEnabled();
  });

  it("surfaces a malformed address, which reveals nothing about accounts", async () => {
    const user = userEvent.setup();
    mockApi.forgotPassword.mockRejectedValue(new Error("Enter a valid email address."));
    renderForgot();

    await user.type(screen.getByLabelText(/email/i), "nope");
    await user.click(screen.getByRole("button", { name: /send me a link/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid email address.")
    );
  });

  it("explains that a guest list has no password to reset", () => {
    renderForgot();
    expect(screen.getByText(/no password to reset/i)).toBeInTheDocument();
  });
});

describe("choosing a new password", () => {
  it("refuses to show a form when the link has no token", () => {
    // An email client that cut the URL in half. There is nothing to submit, so
    // the form is never shown rather than shown and then failing.
    renderReset("");
    expect(screen.getByText(/this link is incomplete/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/new password/i)).toBeNull();
    expect(screen.getByRole("link", { name: /send a new link/i })).toHaveAttribute(
      "href",
      "/forgot"
    );
  });

  it("stays disabled until the password is long enough and both match", async () => {
    const user = userEvent.setup();
    renderReset();
    const submit = screen.getByRole("button", { name: /set my password/i });

    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/new password/i), "short");
    await user.type(screen.getByLabelText(/type it again/i), "short");
    // Matching but too short.
    expect(submit).toBeDisabled();

    await user.clear(screen.getByLabelText(/new password/i));
    await user.clear(screen.getByLabelText(/type it again/i));
    await user.type(screen.getByLabelText(/new password/i), "a long enough one");
    await user.type(screen.getByLabelText(/type it again/i), "a long enough one");
    expect(submit).toBeEnabled();
  });

  it("warns about a mismatch, but only once there is something to mismatch", async () => {
    const user = userEvent.setup();
    renderReset();
    expect(screen.queryByText(/don't match/i)).toBeNull();

    await user.type(screen.getByLabelText(/new password/i), "a long enough one");
    await user.type(screen.getByLabelText(/type it again/i), "a different one");
    expect(screen.getByText(/don't match/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /set my password/i })).toBeDisabled();
  });

  it("sends the token from the URL and hands the session up", async () => {
    const user = userEvent.setup();
    const { onSignedIn } = renderReset("?token=tok_from_email");

    await user.type(screen.getByLabelText(/new password/i), "a long enough one");
    await user.type(screen.getByLabelText(/type it again/i), "a long enough one");
    await user.click(screen.getByRole("button", { name: /set my password/i }));

    await waitFor(() =>
      expect(mockApi.resetPassword).toHaveBeenCalledWith("tok_from_email", "a long enough one")
    );
    expect(onSignedIn).toHaveBeenCalledWith(user_, "stu_1");
  });

  it("warns up front that other devices will be signed out", () => {
    renderReset();
    expect(screen.getByText(/will be signed out/i)).toBeInTheDocument();
  });

  it("offers a fresh link when the token turns out to be dead", async () => {
    const user = userEvent.setup();
    mockApi.resetPassword.mockRejectedValue(
      new Error("This reset link has expired or has already been used. Request a new one.")
    );
    const { onSignedIn } = renderReset();

    await user.type(screen.getByLabelText(/new password/i), "a long enough one");
    await user.type(screen.getByLabelText(/type it again/i), "a long enough one");
    await user.click(screen.getByRole("button", { name: /set my password/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/expired or has already been used/i);
    // A dead link is the likeliest failure and the fix is a new one, so it is
    // offered rather than leaving a dead end.
    expect(within(alert).getByRole("link", { name: /ask for a new link/i })).toHaveAttribute(
      "href",
      "/forgot"
    );
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("does not fire twice on a double click", async () => {
    const user = userEvent.setup();
    let finish!: (v: { user: AuthUser; studentId: string | null }) => void;
    mockApi.resetPassword.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderReset();

    await user.type(screen.getByLabelText(/new password/i), "a long enough one");
    await user.type(screen.getByLabelText(/type it again/i), "a long enough one");
    const submit = screen.getByRole("button", { name: /set my password/i });
    await user.click(submit);
    await user.click(screen.getByRole("button", { name: /setting your password/i }));

    expect(mockApi.resetPassword).toHaveBeenCalledTimes(1);
    finish({ user: user_, studentId: null });
  });
});
