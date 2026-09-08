import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProfileForm from "./ProfileForm";
import { api } from "../api";
import { student } from "../test/factories";
import { MemoryRouter } from "react-router-dom";
import type { Meta } from "../types";

/**
 * ProfileForm links to /account once a profile exists — the only route a guest
 * has to the page that deletes it — so it needs a router around it. Wrapping
 * here rather than at fourteen call sites keeps the tests reading as tests.
 *
 * RTL's `wrapper` option rather than wrapping the element by hand, because
 * `rerender` re-renders whatever it is handed at the root: a hand-wrapped
 * render passes its first assertion and then throws on the rerender, having
 * dropped the router. `wrapper` is reapplied on every rerender.
 */
const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: MemoryRouter });

vi.mock("../api", () => ({
  api: { createStudent: vi.fn(), updateStudent: vi.fn() },
}));

const mockApi = vi.mocked(api);

const meta: Meta = {
  majors: ["CS", "Biology", "History"],
  regions: ["West", "Northeast"],
  financialNeed: ["high", "medium", "low"],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.createStudent.mockResolvedValue(student());
  mockApi.updateStudent.mockResolvedValue(student());
  // jsdom has no layout, so scrollTo is a stub that logs to the virtual
  // console. The form calls it to bring the error summary into view.
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

/** Fill the three fields the form actually requires. */
async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Name"), "Jordan Rivera");
  await user.type(screen.getByLabelText(/Unweighted GPA/), "3.8");
  await user.click(screen.getByRole("button", { name: "CS" }));
}

describe("validation", () => {
  it("names every missing field at once rather than one at a time", async () => {
    const user = userEvent.setup();
    render(<ProfileForm meta={meta} existing={null} onSaved={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Get my matches/ }));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Please enter your name.");
    expect(alert).toHaveTextContent("Enter a GPA between 0 and 5.0.");
    expect(alert).toHaveTextContent("Pick at least one intended major.");
    expect(mockApi.createStudent).not.toHaveBeenCalled();
  });

  it("rejects a GPA outside 0–5 without asking the server", async () => {
    const user = userEvent.setup();
    render(<ProfileForm meta={meta} existing={null} onSaved={vi.fn()} />);

    await user.type(screen.getByLabelText("Name"), "Jordan Rivera");
    await user.click(screen.getByRole("button", { name: "CS" }));
    await user.type(screen.getByLabelText(/Unweighted GPA/), "6");
    await user.click(screen.getByRole("button", { name: /Get my matches/ }));

    expect(screen.getByRole("alert")).toHaveTextContent("Enter a GPA between 0 and 5.0.");
    expect(mockApi.createStudent).not.toHaveBeenCalled();
  });

  it("scrolls the error summary into view, since it sits above the fold", async () => {
    const user = userEvent.setup();
    render(<ProfileForm meta={meta} existing={null} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Get my matches/ }));
    expect(window.scrollTo).toHaveBeenCalled();
  });

  it("clears the errors once the form is valid", async () => {
    const user = userEvent.setup();
    render(<ProfileForm meta={meta} existing={null} onSaved={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Get my matches/ }));
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /Get my matches/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});

describe("submitting", () => {
  it("creates a profile and hands the saved record back", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const saved = student({ id: "stu_new" });
    mockApi.createStudent.mockResolvedValue(saved);

    render(<ProfileForm meta={meta} existing={null} onSaved={onSaved} />);
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "West" }));
    await user.click(screen.getByRole("button", { name: /Get my matches/ }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(mockApi.createStudent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Jordan Rivera",
        gpa: 3.8,
        interestedMajors: ["CS"],
        preferredRegions: ["West"],
        financialNeed: "medium",
      })
    );
  });

  it("updates the existing row instead of creating a second one", async () => {
    // The Phase 2 regression this guards: the form used to POST on every
    // save, which quietly created a new student and stranded the old one —
    // with its notes and tracked applications still attached to it.
    const user = userEvent.setup();
    const existing = student({ id: "stu_1", name: "Jordan Rivera" });

    render(<ProfileForm meta={meta} existing={existing} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Save changes/ }));

    await waitFor(() => expect(mockApi.updateStudent).toHaveBeenCalledOnce());
    expect(mockApi.updateStudent.mock.calls[0]![0]).toBe("stu_1");
    expect(mockApi.createStudent).not.toHaveBeenCalled();
  });

  it("prefills from the existing profile", () => {
    render(
      <ProfileForm
        meta={meta}
        existing={student({ name: "Ada Lovelace", gpa: 3.95, satScore: 1500 })}
        onSaved={vi.fn()}
      />
    );
    expect(screen.getByLabelText("Name")).toHaveValue("Ada Lovelace");
    expect(screen.getByLabelText(/Unweighted GPA/)).toHaveValue(3.95);
    expect(screen.getByLabelText(/^SAT/)).toHaveValue(1500);
  });

  it("says which of the two things it is doing, on the button", async () => {
    const { rerender } = render(
      <ProfileForm meta={meta} existing={null} onSaved={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: /Get my matches/ })).toBeInTheDocument();

    rerender(<ProfileForm meta={meta} existing={student()} onSaved={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeInTheDocument();
  });

  it("surfaces a server error and stays on the form", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    mockApi.createStudent.mockRejectedValue(new Error("GPA must be a number"));

    render(<ProfileForm meta={meta} existing={null} onSaved={onSaved} />);
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /Get my matches/ }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("GPA must be a number")
    );
    expect(onSaved).not.toHaveBeenCalled();
    // Re-enabled, so a failed save can be retried rather than dead-ending.
    expect(screen.getByRole("button", { name: /Get my matches/ })).toBeEnabled();
  });

  it("disables the button while saving so one click is one profile", async () => {
    const user = userEvent.setup();
    let finish!: (v: ReturnType<typeof student>) => void;
    mockApi.createStudent.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );

    render(<ProfileForm meta={meta} existing={null} onSaved={vi.fn()} />);
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /Get my matches/ }));

    const busy = await screen.findByRole("button", { name: /Finding matches/ });
    expect(busy).toBeDisabled();
    finish(student());
  });
});

describe("chips and tags", () => {
  it("toggles a major on and off, and reports state to assistive tech", async () => {
    const user = userEvent.setup();
    render(<ProfileForm meta={meta} existing={null} onSaved={vi.fn()} />);

    const cs = screen.getByRole("button", { name: "CS" });
    expect(cs).toHaveAttribute("aria-pressed", "false");
    await user.click(cs);
    expect(cs).toHaveAttribute("aria-pressed", "true");
    await user.click(cs);
    expect(cs).toHaveAttribute("aria-pressed", "false");
  });

  it("adds an extracurricular on Enter without submitting the form", async () => {
    // The tag input sits inside the form, so an unhandled Enter would submit
    // a half-filled profile instead of adding the tag.
    const user = userEvent.setup();
    render(<ProfileForm meta={meta} existing={null} onSaved={vi.fn()} />);

    await user.type(screen.getByLabelText(/Extracurriculars/), "Robotics captain{Enter}");
    expect(screen.getByText("Robotics captain")).toBeInTheDocument();
    expect(mockApi.createStudent).not.toHaveBeenCalled();
  });

  it("adds via the Add button and refuses a duplicate", async () => {
    const user = userEvent.setup();
    render(<ProfileForm meta={meta} existing={null} onSaved={vi.fn()} />);
    const input = screen.getByLabelText(/Extracurriculars/);

    await user.type(input, "Debate");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.type(input, "Debate");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getAllByText("Debate")).toHaveLength(1);
  });

  it("removes an extracurricular by name", async () => {
    const user = userEvent.setup();
    render(
      <ProfileForm
        meta={meta}
        existing={student({ extracurriculars: ["Debate", "Robotics"] })}
        onSaved={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Remove Debate" }));
    expect(screen.queryByText("Debate")).not.toBeInTheDocument();
    expect(screen.getByText("Robotics")).toBeInTheDocument();
  });

  it("picks one financial-need option at a time", async () => {
    const user = userEvent.setup();
    render(<ProfileForm meta={meta} existing={null} onSaved={vi.fn()} />);

    const group = screen.getByRole("group", { name: "Financial need" });
    expect(screen.getByRole("button", { name: "Some need" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await user.click(screen.getByRole("button", { name: "High need" }));

    const pressed = [...group.querySelectorAll("button")].filter(
      (b) => b.getAttribute("aria-pressed") === "true"
    );
    expect(pressed.map((b) => b.textContent)).toEqual(["High need"]);
  });
});

describe("when /meta hasn't answered", () => {
  it("still offers a usable list of majors and regions", async () => {
    // The form is the app's front door. A blank chip list because one request
    // failed would make the product look broken at the worst moment.
    const user = userEvent.setup();
    render(<ProfileForm meta={null} existing={null} onSaved={vi.fn()} />);

    expect(screen.getByRole("button", { name: "CS" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Midwest" })).toBeInTheDocument();

    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: /Get my matches/ }));
    await waitFor(() => expect(mockApi.createStudent).toHaveBeenCalledOnce());
  });
});
