/**
 * How many schools the comparison grid holds at once.
 *
 * Three is a layout constraint before it's a product one: the grid keeps
 * every figure on one screen without horizontal scrolling at laptop widths,
 * and side-by-side stops being readable past three columns anyway.
 */
export const MAX_COMPARE = 3;

/**
 * Add or remove a school from the comparison set, ignoring adds past the cap.
 * Selection order is preserved so columns don't reshuffle as you pick.
 */
export function toggleCompare(ids: number[], id: number): number[] {
  if (ids.includes(id)) return ids.filter((x) => x !== id);
  if (ids.length >= MAX_COMPARE) return ids;
  return [...ids, id];
}
