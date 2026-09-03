import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countdown,
  daysUntil,
  localMidnight,
  parseLocalDate,
  urgencyOf,
} from "./dates";

// The suite runs pinned to America/New_York (see vitest.config.ts). Every
// assertion below about "the previous day" is meaningless in UTC, which is
// what a CI runner defaults to.

/** Freeze the clock at a wall-clock moment in the pinned timezone. */
function at(year: number, month1: number, day: number, hour = 12, minute = 0) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(year, month1 - 1, day, hour, minute));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseLocalDate", () => {
  it("reads a date-only string as local midnight", () => {
    const d = parseLocalDate("2026-01-15");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(0);
  });

  it("does not land on the previous day the way new Date() does", () => {
    // This is the entire reason the function exists. `new Date("2026-01-15")`
    // is UTC midnight, which is 7pm on the 14th in New York — a tracker that
    // says an application is due Jan 14 when it's due Jan 15 is worse than no
    // tracker at all.
    expect(new Date("2026-01-15").getDate()).toBe(14);
    expect(parseLocalDate("2026-01-15").getDate()).toBe(15);
  });

  it("handles a date inside daylight time the same way", () => {
    const d = parseLocalDate("2026-07-04");
    expect(d.getMonth()).toBe(6);
    expect(d.getDate()).toBe(4);
    expect(d.getHours()).toBe(0);
  });
});

describe("localMidnight", () => {
  it("drops the time of day", () => {
    at(2026, 1, 15, 23, 59);
    const m = localMidnight();
    expect(m.getDate()).toBe(15);
    expect(m.getHours()).toBe(0);
    expect(m.getMinutes()).toBe(0);
  });
});

describe("daysUntil", () => {
  it("counts today as zero whatever the time is", () => {
    at(2026, 1, 15, 0, 1);
    expect(daysUntil("2026-01-15")).toBe(0);
    vi.setSystemTime(new Date(2026, 0, 15, 23, 59));
    expect(daysUntil("2026-01-15")).toBe(0);
  });

  it("counts forward and backward", () => {
    at(2026, 1, 15);
    expect(daysUntil("2026-01-16")).toBe(1);
    expect(daysUntil("2026-01-14")).toBe(-1);
    expect(daysUntil("2026-02-14")).toBe(30);
  });

  it("crosses a month and a year boundary", () => {
    at(2025, 12, 28);
    expect(daysUntil("2026-01-04")).toBe(7);
  });

  it("stays whole across the spring-forward clock change", () => {
    // March 8, 2026 is 23 hours long in New York. Dividing raw milliseconds by
    // 86,400,000 gives 13.958 for this span; Math.round is what keeps the
    // countdown from reading "13 days left" for a two-week gap.
    at(2026, 3, 1);
    expect(daysUntil("2026-03-15")).toBe(14);
  });

  it("stays whole across the fall-back clock change", () => {
    // November 1, 2026 is 25 hours long — the same arithmetic in the other
    // direction, which truncation would round the wrong way.
    at(2026, 10, 25);
    expect(daysUntil("2026-11-08")).toBe(14);
  });

  it("counts a leap day", () => {
    at(2028, 2, 28);
    expect(daysUntil("2028-03-01")).toBe(2);
  });
});

describe("urgencyOf", () => {
  it("has nothing to say about a school with no fixed date", () => {
    expect(urgencyOf(null)).toBeNull();
  });

  it("labels each band, and its exact boundary", () => {
    at(2026, 1, 15);
    expect(urgencyOf("2026-01-14")).toBe("past");
    expect(urgencyOf("2026-01-15")).toBe("urgent"); // due today is not past
    expect(urgencyOf("2026-01-22")).toBe("urgent"); // exactly 7 days
    expect(urgencyOf("2026-01-23")).toBe("soon"); // 8
    expect(urgencyOf("2026-02-14")).toBe("soon"); // exactly 30 days
    expect(urgencyOf("2026-02-15")).toBe("later"); // 31
  });
});

describe("countdown", () => {
  it("names the no-deadline case rather than showing a number", () => {
    expect(countdown(null)).toBe("No fixed date");
  });

  it("uses words for today and tomorrow", () => {
    at(2026, 1, 15);
    expect(countdown("2026-01-15")).toBe("Due today");
    expect(countdown("2026-01-16")).toBe("Due tomorrow");
  });

  it("pluralises the past correctly", () => {
    at(2026, 1, 15);
    expect(countdown("2026-01-14")).toBe("1 day ago");
    expect(countdown("2026-01-13")).toBe("2 days ago");
  });

  it("counts the days left", () => {
    at(2026, 1, 15);
    expect(countdown("2026-01-20")).toBe("5 days left");
    expect(countdown("2026-02-14")).toBe("30 days left");
  });
});
