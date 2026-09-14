import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Account from "./Account";
import TwoFactorPanel from "./TwoFactorPanel";
import { api, ApiError } from "../api";
import type { AuthUser } from "../types";

vi.mock("../api", async (importOriginal) => ({
  // The real ApiError, so the panel can tell "already on" from a wrong password.
  ...(await importOriginal<typeof import("../api")>()),
  api: {
    login: vi.fn(),
    signup: vi.fn(),
    verifyTwoFactor: vi.fn(),
    twoFactorStatus: vi.fn(),
    startTwoFactor: vi.fn(),
    enableTwoFactor: vi.fn(),
    disableTwoFactor: vi.fn(),
    regenerateRecoveryCodes: vi.fn(),
  },
}));
const mockApi = vi.mocked(api);

const account: AuthUser = {
  id: 1,
  email: "jordan@example.com",
  guest: false,
  createdAt: "2026-03-04T10:00:00.000Z",
  twoFactorEnabled: true,
};

function renderLogin(onSignedIn = vi.fn()) {
  render(
    <MemoryRouter>
      <Account mode="login" guestProfile={null} onSignedIn={onSignedIn} />
    </MemoryRouter>
  );
  return { onSignedIn };
}

/**
 * The sign-in screen has two buttons reading "Sign in": the tab that switches
 * between signup and login, and the form's submit. Picking by name alone gets
 * the tab, which navigates instead of submitting — so filter on type="submit".
 */
function submitButton(name: RegExp): HTMLElement {
  const match = screen
    .getAllByRole("button", { name })
    .find((b) => b.getAttribute("type") === "submit");
  if (!match) throw new Error(`no submit button matching ${name}`);
  return match;
}

async function signInWithPassword(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Email"), "jordan@example.com");
  await user.type(screen.getByLabelText(/^password$/i), "correct horse battery");
  await user.click(submitButton(/sign in/i));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.twoFactorStatus.mockResolvedValue({
    enabled: false,
    recoveryCodesRemaining: 0,
    recoveryCodesTotal: 0,
  });
});

describe("signing in when 2FA is on", () => {
  it("swaps to the code step instead of signing in", async () => {
    const user = userEvent.setup();
    mockApi.login.mockResolvedValue({ mfaRequired: true, challenge: "chal_1" });
    const { onSignedIn } = renderLogin();

    await signInWithPassword(user);

    expect(await screen.findByLabelText(/authentication code/i)).toBeInTheDocument();
    // Nothing was minted server-side, so nothing is handed up here either.
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("redeems the challenge and signs in", async () => {
    const user = userEvent.setup();
    mockApi.login.mockResolvedValue({ mfaRequired: true, challenge: "chal_1" });
    mockApi.verifyTwoFactor.mockResolvedValue({
      user: account,
      studentId: "stu_1",
      discardedGuestProfile: false,
    });
    const { onSignedIn } = renderLogin();

    await signInWithPassword(user);
    await user.type(await screen.findByLabelText(/authentication code/i), "123456");
    await user.click(screen.getByRole("button", { name: /verify and sign in/i }));

    await waitFor(() => expect(mockApi.verifyTwoFactor).toHaveBeenCalledWith("chal_1", "123456"));
    expect(onSignedIn).toHaveBeenCalledWith(account, "stu_1", false);
  });

  it("tells you recovery codes work here too", async () => {
    // The lost-phone path has to be discoverable at the moment the phone is
    // missing, not only in the docs.
    const user = userEvent.setup();
    mockApi.login.mockResolvedValue({ mfaRequired: true, challenge: "chal_1" });
    renderLogin();

    await signInWithPassword(user);
    expect(await screen.findByText(/lost your phone/i)).toBeInTheDocument();
  });

  it("sends you back to the password step on a wrong code", async () => {
    // The server spends the challenge either way, so the code box would have
    // nothing left to redeem against — returning to the start is the honest UI.
    const user = userEvent.setup();
    mockApi.login.mockResolvedValue({ mfaRequired: true, challenge: "chal_1" });
    mockApi.verifyTwoFactor.mockRejectedValue(
      new Error("That code isn't right. Please sign in again to get a new attempt.")
    );
    renderLogin();

    await signInWithPassword(user);
    await user.type(await screen.findByLabelText(/authentication code/i), "000000");
    await user.click(screen.getByRole("button", { name: /verify and sign in/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/isn't right/i));
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByLabelText(/authentication code/i)).toBeNull();
  });

  it("uses one-time-code autofill so phones can offer the code", async () => {
    const user = userEvent.setup();
    mockApi.login.mockResolvedValue({ mfaRequired: true, challenge: "chal_1" });
    renderLogin();

    await signInWithPassword(user);
    const field = await screen.findByLabelText(/authentication code/i);
    expect(field).toHaveAttribute("autocomplete", "one-time-code");
    // Not type="number": a recovery code has letters in it.
    expect(field).toHaveAttribute("type", "text");
  });

  it("leaves an account without 2FA completely unchanged", async () => {
    const user = userEvent.setup();
    mockApi.login.mockResolvedValue({
      user: { ...account, twoFactorEnabled: false },
      studentId: "stu_1",
      discardedGuestProfile: false,
    });
    const { onSignedIn } = renderLogin();

    await signInWithPassword(user);
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(screen.queryByLabelText(/authentication code/i)).toBeNull();
  });
});

describe("enrolling", () => {
  const renderPanel = (onChanged = vi.fn()) => {
    render(
      <MemoryRouter>
        <TwoFactorPanel onChanged={onChanged} />
      </MemoryRouter>
    );
    return { onChanged };
  };

  it("says it is off, and what turning it on costs", async () => {
    renderPanel();
    expect(await screen.findByText(/^Off\.$/)).toBeInTheDocument();
    // The tradeoff stated before enrolling, not after.
    expect(screen.getByText(/won't get you back in/i)).toBeInTheDocument();
  });

  it("asks for the password before showing a secret", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /turn on two-factor/i }));
    expect(screen.getByLabelText(/your password/i)).toBeInTheDocument();
    expect(mockApi.startTwoFactor).not.toHaveBeenCalled();
  });

  it("shows the setup key and a tappable link, then confirms with a code", async () => {
    const user = userEvent.setup();
    mockApi.startTwoFactor.mockResolvedValue({
      secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
      otpauthUri: "otpauth://totp/Compass:jordan@example.com?secret=JBSWY3DP",
    });
    mockApi.enableTwoFactor.mockResolvedValue({
      enabled: true,
      recoveryCodes: ["AAAA-BBBB-CCCC", "DDDD-EEEE-FFFF"],
    });
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /turn on two-factor/i }));
    await user.type(screen.getByLabelText(/your password/i), "correct horse battery");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    // The key, grouped in fours so it can be transcribed.
    expect(await screen.findByText(/JBSW Y3DP EHPK 3PXP/)).toBeInTheDocument();
    // And the link that replaces a QR code on a phone.
    expect(screen.getByRole("link", { name: /tap here to add it/i })).toHaveAttribute(
      "href",
      "otpauth://totp/Compass:jordan@example.com?secret=JBSWY3DP"
    );

    await user.type(screen.getByLabelText(/six-digit code/i), "123456");
    await user.click(screen.getByRole("button", { name: /turn on two-factor/i }));

    await waitFor(() => expect(mockApi.enableTwoFactor).toHaveBeenCalledWith("123456"));
  });

  it("shows the recovery codes once, with the warning that matters", async () => {
    const user = userEvent.setup();
    mockApi.startTwoFactor.mockResolvedValue({ secret: "JBSWY3DP", otpauthUri: "otpauth://x" });
    mockApi.enableTwoFactor.mockResolvedValue({
      enabled: true,
      recoveryCodes: ["AAAA-BBBB-CCCC", "DDDD-EEEE-FFFF"],
    });
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /turn on two-factor/i }));
    await user.type(screen.getByLabelText(/your password/i), "pw");
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await user.type(await screen.findByLabelText(/six-digit code/i), "123456");
    await user.click(screen.getByRole("button", { name: /turn on two-factor/i }));

    expect(await screen.findByText("AAAA-BBBB-CCCC")).toBeInTheDocument();
    expect(screen.getByText(/only time these are shown/i)).toBeInTheDocument();
    // The consequence, said plainly, because a reset will not rescue them.
    expect(
      screen.getByText(/you cannot get back into this account/i)
    ).toBeInTheDocument();
  });

  it("surfaces a wrong password without moving on", async () => {
    const user = userEvent.setup();
    mockApi.startTwoFactor.mockRejectedValue(new Error("That password is not correct."));
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /turn on two-factor/i }));
    await user.type(screen.getByLabelText(/your password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("That password is not correct.")
    );
    expect(screen.queryByLabelText(/six-digit code/i)).toBeNull();
  });

  it("offers nothing until it knows whether it is already on", () => {
    // Not knowing is not "off". Offering to turn it on before the answer is in
    // is how an account that already had 2FA could be sent into setup.
    mockApi.twoFactorStatus.mockReturnValue(new Promise<never>(() => {}));
    renderPanel();

    expect(screen.getByText(/checking/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Off\.$/)).toBeNull();
    expect(screen.queryByRole("button", { name: /turn on two-factor/i })).toBeNull();
  });

  it("says when it could not find out, rather than showing Off", async () => {
    const user = userEvent.setup();
    mockApi.twoFactorStatus
      .mockRejectedValueOnce(new Error("Request failed (500)"))
      .mockResolvedValueOnce({ enabled: true, recoveryCodesRemaining: 10, recoveryCodesTotal: 10 });
    renderPanel();

    expect(await screen.findByText(/couldn't check/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Off\.$/)).toBeNull();
    expect(screen.queryByRole("button", { name: /turn on two-factor/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByText(/^On\.$/)).toBeInTheDocument();
  });

  it("if it was switched on after the page loaded, changes nothing and catches up", async () => {
    // Say another tab finished enrolling. Setting up again now needs a current
    // code, which this form does not ask for, so the server refuses with a 409.
    const user = userEvent.setup();
    mockApi.twoFactorStatus
      .mockResolvedValueOnce({ enabled: false, recoveryCodesRemaining: 0, recoveryCodesTotal: 0 })
      .mockResolvedValueOnce({ enabled: true, recoveryCodesRemaining: 10, recoveryCodesTotal: 10 });
    mockApi.startTwoFactor.mockRejectedValue(
      new ApiError(
        "Two-factor authentication is already on. Setting it up again needs a current code as well as your password.",
        409
      )
    );
    const { onChanged } = renderPanel();

    await user.click(await screen.findByRole("button", { name: /turn on two-factor/i }));
    await user.type(screen.getByLabelText(/your password/i), "correct horse battery");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(await screen.findByText(/^On\.$/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/already on.*nothing was changed/i);
    // No secret was handed out, and nothing reads as a failure.
    expect(screen.queryByText(/setup key/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onChanged).toHaveBeenCalled();
  });
});

describe("when it is already on", () => {
  const renderOn = (remaining = 10) => {
    mockApi.twoFactorStatus.mockResolvedValue({
      enabled: true,
      recoveryCodesRemaining: remaining,
      recoveryCodesTotal: 10,
    });
    render(
      <MemoryRouter>
        <TwoFactorPanel onChanged={vi.fn()} />
      </MemoryRouter>
    );
  };

  it("reports the state and how many codes are left", async () => {
    renderOn(7);
    expect(await screen.findByText(/^On\.$/)).toBeInTheDocument();
    expect(screen.getByText(/7 of 10 recovery codes left/i)).toBeInTheDocument();
  });

  it("nudges when the codes are running out", async () => {
    renderOn(2);
    expect(await screen.findByText(/getting low/i)).toBeInTheDocument();
  });

  it("does not nudge when there are plenty", async () => {
    renderOn(9);
    await screen.findByText(/^On\.$/);
    expect(screen.queryByText(/getting low/i)).toBeNull();
  });

  it("needs both a password and a code to turn off", async () => {
    const user = userEvent.setup();
    renderOn();

    await user.click(await screen.findByRole("button", { name: /turn off/i }));
    const submit = screen.getByRole("button", { name: /turn it off/i });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/your password/i), "pw");
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/code from your app/i), "123456");
    expect(submit).toBeEnabled();

    mockApi.disableTwoFactor.mockResolvedValue({ enabled: false });
    await user.click(submit);
    await waitFor(() => expect(mockApi.disableTwoFactor).toHaveBeenCalledWith("pw", "123456"));
  });

  it("regenerating codes also needs both, and warns the old ones die", async () => {
    const user = userEvent.setup();
    renderOn();
    mockApi.regenerateRecoveryCodes.mockResolvedValue({
      recoveryCodes: ["NEW1-NEW1-NEW1"],
    });

    await user.click(await screen.findByRole("button", { name: /new recovery codes/i }));
    expect(screen.getByText(/any printout you're holding stops working/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/your password/i), "pw");
    await user.type(screen.getByLabelText(/code from your app/i), "123456");
    await user.click(screen.getByRole("button", { name: /generate new codes/i }));

    await waitFor(() =>
      expect(mockApi.regenerateRecoveryCodes).toHaveBeenCalledWith("pw", "123456")
    );
    expect(await screen.findByText("NEW1-NEW1-NEW1")).toBeInTheDocument();
  });
});
