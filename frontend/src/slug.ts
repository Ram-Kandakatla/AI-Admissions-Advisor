/** Lossy and one-way; reverse it with majorFromSlug against the catalog. */
export function slugifyMajor(major: string): string {
  return major
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The original catalog name (what the API expects), or null if none matches. */
export function majorFromSlug(slug: string, catalog: readonly string[]): string | null {
  const wanted = slugifyMajor(slug);
  return catalog.find((major) => slugifyMajor(major) === wanted) ?? null;
}
