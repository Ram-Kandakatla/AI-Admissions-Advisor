import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AccountSettings from "./AccountSettings";
import { api } from "../api";
import type { AuthUser } from "../types";

// twoFactorStatus is stubbed because AccountSettings now renders the 2FA panel,
// which fetches on mount. These tests are about deletion; the panel has its own.
vi.mock("../api", () => ({
  api: { deleteAccount: vi.fn(), twoFactorStatus: vi.fn() },
}));
const mockApi = vi.mocked(api);

const member: AuthUser = {
  id: 1,
  email: "jordan@example.com",
  guest: false,
  createdAt: "2026-03-04T10:00:00.000Z",
  twoFactorEnabled: false,
};
const guest: AuthUser = {
  id: 2,
  email: null,
  guest: true,
  createdAt: "2026-03-04T10:00:00.000Z",
  twoFactorEnabled: false,
};

function renderPage(
  user: AuthUser | null | undefined,
  { hasProfile = true, onDeleted = vi.fn() } = {}
) {
  render(
    <MemoryRouter>
      <AccountSettings
        user={user}
        hasProfile={hasProfile}
        onDeleted={onDeleted}
        onSecurityChanged={vi.fn()}
      />
    </MemoryRouter>
  );
  return { onDeleted };
}

// "delet" rather than "delete": the label becomes "Deleting…" while the
// request is in flight, and the busy state is exactly what one of these tests
// is about.
const deleteButton = () => screen.getByRole("button", { name: /delet|erase/i });

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.deleteAccount.mockResolvedValue({ deleted: true, hadProfile: true });
  mockApi.twoFactorStatus.mockResolvedValue({
    enabled: false,
    recoveryCodesRemaining: 0,
    recoveryCodesTotal: 0,
  });
});

describe("who is looking", () => {
  it("waits rather than guessing while the session is still loading", () => {
    // `undefined` is "not asked yet", which is not the same as "nobody".
    // Rendering the signed-out state here would flash "no account" at every
    // returning visitor on every load.
    renderPage(undefined);
    expect(screen.getByLabelText(/loading your account/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });

  it("offers nothing to delete when there is no session at all", () => {
    renderPage(null);
    expect(screen.getByText(/no account on this browser/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delet|erase/i })).toBeNull();
  });

  it("names a signed-in account by its email", () => {
    renderPage(member);
    expect(screen.getByText("jordan@example.com")).toBeInTheDocument();
  });

  it("tells a guest their work is not saved, and offers to fix that", () => {
    renderPage(guest);
    expect(screen.getByText(/isn't saved to an account/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /save this list to an account/i })).toHaveAttribute(
      "href",
      "/signup"
    );
  });
});

describe("proving you meant it", () => {
  it("stays disabled until the word is typed", async () => {
    const user = userEvent.setup();
    renderPage(guest);

    expect(deleteButton()).toBeDisabled();
    await user.type(screen.getByLabelText(/type.*to confirm/i), "DELETE");
    expect(deleteButton()).toBeEnabled();
  });

  it("is not satisfied by nearly the right word", async () => {
    const user = userEvent.setup();
    renderPage(guest);
    await user.type(screen.getByLabelText(/type.*to confirm/i), "DELET");
    expect(deleteButton()).toBeDisabled();
  });

  it("accepts the word in any case, since the field upcases as you type", async () => {
    const user = userEvent.setup();
    renderPage(guest);
    await user.type(screen.getByLabelText(/type.*to confirm/i), "delete");
    expect(deleteButton()).toBeEnabled();
  });

  it("makes a member supply a password as well as the word", async () => {
    const user = userEvent.setup();
    renderPage(member);

    await user.type(screen.getByLabelText(/type.*to confirm/i), "DELETE");
    // The word alone is not enough for an account that has a password.
    expect(deleteButton()).toBeDisabled();

    await user.type(screen.getByLabelText(/confirm your password/i), "hunter2");
    expect(deleteButton()).toBeEnabled();
  });

  it("asks a guest for no password, because there is none to give", () => {
    renderPage(guest);
    expect(screen.queryByLabelText(/confirm your password/i)).toBeNull();
  });

  it("turns off autocomplete on the confirm field", () => {
    // A browser helpfully completing the word that exists to prove
    // deliberateness would defeat the entire control.
    renderPage(guest);
    const field = screen.getByLabelText(/type.*to confirm/i);
    expect(field).toHaveAttribute("autocomplete", "off");
    expect(field).toHaveAttribute("spellcheck", "false");
  });
});

describe("deleting", () => {
  it("sends the password for a member and hands the result up", async () => {
    const user = userEvent.setup();
    const { onDeleted } = renderPage(member);

    await user.type(screen.getByLabelText(/type.*to confirm/i), "DELETE");
    await user.type(screen.getByLabelText(/confirm your password/i), "hunter2");
    await user.click(deleteButton());

    await waitFor(() => expect(mockApi.deleteAccount).toHaveBeenCalledWith("hunter2"));
    expect(onDeleted).toHaveBeenCalledWith(true);
  });

  it("sends no password for a guest", async () => {
    const user = userEvent.setup();
    mockApi.deleteAccount.mockResolvedValue({ deleted: true, hadProfile: false });
    const { onDeleted } = renderPage(guest, { hasProfile: false });

    await user.type(screen.getByLabelText(/type.*to confirm/i), "DELETE");
    await user.click(deleteButton());

    await waitFor(() => expect(mockApi.deleteAccount).toHaveBeenCalledWith(undefined));
    expect(onDeleted).toHaveBeenCalledWith(false);
  });

  it("surfaces a wrong password and lets you try again", async () => {
    const user = userEvent.setup();
    mockApi.deleteAccount.mockRejectedValue(new Error("That password is not correct."));
    const { onDeleted } = renderPage(member);

    await user.type(screen.getByLabelText(/type.*to confirm/i), "DELETE");
    await user.type(screen.getByLabelText(/confirm your password/i), "wrong");
    await user.click(deleteButton());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("That password is not correct.")
    );
    expect(onDeleted).not.toHaveBeenCalled();
    // The password box is emptied — a wrong value left in place invites a
    // second attempt with the same wrong value — but the typed word stays, so
    // the retry is one field rather than two.
    expect(screen.getByLabelText(/confirm your password/i)).toHaveValue("");
    expect(screen.getByLabelText(/type.*to confirm/i)).toHaveValue("DELETE");
  });

  it("does not fire twice on a double click", async () => {
    const user = userEvent.setup();
    let finish!: (v: { deleted: true; hadProfile: boolean }) => void;
    mockApi.deleteAccount.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderPage(guest);

    await user.type(screen.getByLabelText(/type.*to confirm/i), "DELETE");
    await user.click(deleteButton());
    expect(deleteButton()).toBeDisabled();
    await user.click(deleteButton());

    expect(mockApi.deleteAccount).toHaveBeenCalledTimes(1);
    finish({ deleted: true, hadProfile: true });
  });
});

describe("what it tells you first", () => {
  it("lists what will be destroyed, including the share link", async () => {
    renderPage(member);
    expect(screen.getByText(/every school note, star, and counselor contact/i)).toBeInTheDocument();
    expect(screen.getByText(/a URL you sent someone stops working/i)).toBeInTheDocument();
    expect(screen.getByText(/signed out everywhere/i)).toBeInTheDocument();
  });

  it("offers an export first, which is the one thing you cannot do afterwards", () => {
    renderPage(member, { hasProfile: true });
    expect(screen.getByRole("link", { name: /export saved schools/i })).toHaveAttribute(
      "href",
      "/saved"
    );
  });

  it("skips the export offer when there is no profile to export", () => {
    renderPage(member, { hasProfile: false });
    expect(screen.queryByRole("link", { name: /export/i })).toBeNull();
  });

  it("says plainly that there is no undo", () => {
    renderPage(member);
    expect(screen.getByText(/no undo and no grace/i)).toBeInTheDocument();
  });

  it("offers a way out that is not the delete button", () => {
    renderPage(member);
    expect(screen.getByRole("link", { name: /never mind/i })).toHaveAttribute("href", "/");
  });
});
