import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Account from "./Account";
import VerifySignup from "./VerifySignup";
import { api } from "../api";
import { student } from "../test/factories";
import type { AuthUser, StudentRecord } from "../types";

vi.mock("../api", () => ({
  api: { signup: vi.fn(), login: vi.fn(), verifyTwoFactor: vi.fn(), verifySignup: vi.fn() },
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

/**
 * Rendered inside StrictMode on purpose. React runs effects twice there in
 * development, which is exactly the condition under which a page that confirms
 * on load would send two racing confirmations — so the guard against that is
 * tested under the thing it guards against.
 */
function renderVerify(search = "?token=tok_1", onSignedIn = vi.fn()) {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[`/verify${search}`]}>
        <Routes>
          <Route path="/verify" element={<VerifySignup onSignedIn={onSignedIn} />} />
        </Routes>
      </MemoryRouter>
    </StrictMode>
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
  mockApi.signup.mockResolvedValue({ message: "ok" });
});

describe("asking to sign up", () => {
  it("says to check the inbox, without claiming an account was or wasn't made", async () => {
    const user = userEvent.setup();
    const { onSignedIn } = renderSignup();
    await requestSignup(user);

    await waitFor(() =>
      expect(mockApi.signup).toHaveBeenCalledWith("jordan@example.com", "correct horse battery")
    );
    expect(await screen.findByRole("heading", { name: /check your email/i })).toBeInTheDocument();
    // Both outcomes, stated as possibilities. The page cannot know which is
    // true, and the server refuses to say — see the note on the component.
    expect(screen.getByText(/if it's a new address/i)).toBeInTheDocument();
    expect(screen.getByText(/already has a compass account/i)).toBeInTheDocument();
    // A request signs nobody in; the emailed link does that.
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("tells a guest their profile is kept until the link is opened", async () => {
    const user = userEvent.setup();
    renderSignup(student({ name: "Ada" }));
    await requestSignup(user);

    expect(await screen.findByText(/ada's profile stays in this browser/i)).toBeInTheDocument();
  });

  it("goes back to the form to try again, without keeping the password", async () => {
    const user = userEvent.setup();
    renderSignup();
    await requestSignup(user);

    await user.click(await screen.findByRole("button", { name: /try again/i }));
    expect(screen.getByLabelText("Email")).toHaveValue("jordan@example.com");
    expect(screen.getByLabelText(/^password/i)).toHaveValue("");
  });

  it("shows a validation error and stays on the form", async () => {
    mockApi.signup.mockRejectedValue(new Error("Enter a valid email address."));
    const user = userEvent.setup();
    renderSignup();
    await requestSignup(user);

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid email address.");
    expect(screen.queryByRole("heading", { name: /check your email/i })).not.toBeInTheDocument();
  });
});

describe("opening the link", () => {
  it("finishes by itself in the browser that signed up, asking the server once", async () => {
    mockApi.verifySignup.mockResolvedValue({
      user: account,
      studentId: "stu_1",
      discardedGuestProfile: false,
    });
    const { onSignedIn } = renderVerify();

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(account, "stu_1", false));
    expect(mockApi.verifySignup).toHaveBeenCalledTimes(1);
    expect(mockApi.verifySignup).toHaveBeenCalledWith("tok_1");
  });

  it("asks for the password anywhere else, and finishes with it", async () => {
    mockApi.verifySignup
      .mockResolvedValueOnce({ passwordRequired: true })
      .mockResolvedValueOnce({ user: account, studentId: null, discardedGuestProfile: true });
    const user = userEvent.setup();
    const { onSignedIn } = renderVerify();

    const field = await screen.findByLabelText(/password/i);
    expect(onSignedIn).not.toHaveBeenCalled();
    await user.type(field, "correct horse battery");
    await user.click(screen.getByRole("button", { name: /finish creating my account/i }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(account, null, true));
    expect(mockApi.verifySignup).toHaveBeenLastCalledWith("tok_1", "correct horse battery");
  });

  it("stays on the password step after a wrong password", async () => {
    mockApi.verifySignup
      .mockResolvedValueOnce({ passwordRequired: true })
      .mockRejectedValueOnce(new Error("That isn't the password this account was set up with."));
    const user = userEvent.setup();
    const { onSignedIn } = renderVerify();

    await user.type(await screen.findByLabelText(/password/i), "not my password");
    await user.click(screen.getByRole("button", { name: /finish creating my account/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/isn't the password/i);
    // The link is still good, so the field is still there to try again with.
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("tells someone who never signed up that closing the page is safe", async () => {
    mockApi.verifySignup.mockResolvedValue({ passwordRequired: true });
    renderVerify();

    expect(await screen.findByText(/didn't sign up for compass/i)).toBeInTheDocument();
  });

  it("offers a way forward when the link is dead", async () => {
    mockApi.verifySignup.mockRejectedValue(
      new Error("This link has expired or has already been used. Sign up again to get a new one.")
    );
    renderVerify();

    expect(await screen.findByRole("alert")).toHaveTextContent(/expired/i);
    expect(screen.getByRole("link", { name: /sign up again/i })).toHaveAttribute("href", "/signup");
  });

  it("does not call the server for a link with no token", () => {
    renderVerify("");

    expect(screen.getByRole("heading", { name: /incomplete/i })).toBeInTheDocument();
    expect(mockApi.verifySignup).not.toHaveBeenCalled();
  });
});
