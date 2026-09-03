import { describe, expect, it } from "vitest";
import { MAX_COMPARE, toggleCompare } from "./compare";

describe("toggleCompare", () => {
  it("adds a school that isn't selected yet", () => {
    expect(toggleCompare([], 7)).toEqual([7]);
    expect(toggleCompare([7], 12)).toEqual([7, 12]);
  });

  it("removes a school that is already selected", () => {
    expect(toggleCompare([7, 12], 7)).toEqual([12]);
  });

  it("keeps selection order so columns don't reshuffle", () => {
    // The comment on MAX_COMPARE calls this out explicitly: picking C then A
    // must not sort them into A, C, or the grid would rearrange itself under
    // the student's cursor.
    const picked = [9, 2, 5].reduce(toggleCompare, [] as number[]);
    expect(picked).toEqual([9, 2, 5]);
  });

  it("ignores an add once the cap is reached", () => {
    const full = Array.from({ length: MAX_COMPARE }, (_, i) => i + 1);
    expect(toggleCompare(full, 99)).toEqual(full);
  });

  it("still removes when the set is full", () => {
    // The cap guards adds only. A full grid you cannot clear would be a trap.
    const full = Array.from({ length: MAX_COMPARE }, (_, i) => i + 1);
    expect(toggleCompare(full, full[0]!)).toEqual(full.slice(1));
  });

  it("frees a slot when one is removed", () => {
    const full = Array.from({ length: MAX_COMPARE }, (_, i) => i + 1);
    const afterRemove = toggleCompare(full, full[0]!);
    expect(toggleCompare(afterRemove, 99)).toEqual([...full.slice(1), 99]);
  });

  it("never mutates the array it was given", () => {
    // Callers hold this array in React state, where an in-place edit renders
    // nothing because the reference is unchanged.
    const ids = [1, 2];
    const frozen = Object.freeze([...ids]);
    expect(() => toggleCompare(frozen as number[], 3)).not.toThrow();
    expect(() => toggleCompare(frozen as number[], 1)).not.toThrow();
    expect(ids).toEqual([1, 2]);
  });
});
