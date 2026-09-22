import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GpaValue, SatValue } from "./GpaValue";

// These two components carry the dataset's honesty into the UI. 715 of the 757
// schools have a GPA Compass worked out rather than read, and 143 report no SAT
// at all. If either marker silently stops rendering, an inferred number starts
// reading as a figure the school published — which no other test in the suite
// would notice.

describe("GpaValue", () => {
  it("marks a GPA estimated from the school's SAT", () => {
    render(<GpaValue value={3.42} source="estimated-sat" />);
    expect(screen.getByText("3.42")).toBeInTheDocument();
    expect(screen.getByText("est")).toBeInTheDocument();
  });

  it("marks a GPA estimated from the school's profile", () => {
    render(<GpaValue value={3.18} source="estimated-profile" />);
    expect(screen.getByText("est")).toBeInTheDocument();
  });

  it("leaves a curated GPA unmarked", () => {
    // The whole point of the marker is that it distinguishes. A reported figure
    // wearing it would be as wrong as an estimate going bare.
    render(<GpaValue value={3.95} source="curated" />);
    expect(screen.getByText("3.95")).toBeInTheDocument();
    expect(screen.queryByText("est")).not.toBeInTheDocument();
  });

  it("leaves a GPA with no stated source unmarked", () => {
    render(<GpaValue value={3.7} />);
    expect(screen.queryByText("est")).not.toBeInTheDocument();
  });

  it("says which basis the estimate used", () => {
    // The two are not equally good and the tooltip is the only place that says
    // so, since both render the same three letters.
    const { rerender } = render(<GpaValue value={3.4} source="estimated-sat" />);
    expect(screen.getByText("est")).toHaveAttribute("title", expect.stringContaining("SAT"));
    rerender(<GpaValue value={3.4} source="estimated-profile" />);
    expect(screen.getByText("est")).toHaveAttribute("title", expect.stringContaining("retention"));
  });

  it("always shows two decimal places", () => {
    // Otherwise 3.7 and 3.70 sit in the same column at different widths.
    render(<GpaValue value={3.7} source="curated" />);
    expect(screen.getByText("3.70")).toBeInTheDocument();
  });
});

describe("SatValue", () => {
  it("shows a reported average", () => {
    render(<SatValue value={1330} />);
    expect(screen.getByText("1330")).toBeInTheDocument();
  });

  it("says test-blind rather than leaving a blank", () => {
    // A blank cell reads as data we failed to find. The point is that the school
    // does not use the SAT — which a student with a weak score wants to know.
    render(<SatValue value={null} />);
    expect(screen.getByText("test-blind")).toBeInTheDocument();
  });

  it("explains what test-blind means on hover", () => {
    render(<SatValue value={null} />);
    expect(screen.getByText("test-blind")).toHaveAttribute(
      "title",
      expect.stringContaining("does not consider")
    );
  });

  it("never renders a zero for a missing score", () => {
    const { container } = render(<SatValue value={null} />);
    expect(container.textContent).not.toMatch(/\b0\b/);
  });
});
