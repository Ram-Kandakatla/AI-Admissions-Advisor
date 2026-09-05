// Major names in the URL.
//
// The major deep dive is the one page whose subject is a piece of data rather
// than a fixed destination, so /majors/computer-science is what makes "look at
// this program list" a link you can send someone. Two ways to get there:
// percent-encode the name ("/majors/Computer%20Science") or slugify it. The
// encoded form round-trips perfectly and reads like a leak of the database;
// the slug reads like a URL and needs a lookup to reverse. The lookup is
// cheap — the catalog is already fetched — so the slug wins.

/**
 * "Computer Science" → "computer-science".
 *
 * Deliberately lossy: anything that isn't a letter or digit collapses to a
 * single hyphen. That means the mapping is one-way, and `majorFromSlug` has to
 * resolve a slug against the real catalog rather than trying to invert this.
 */
export function slugifyMajor(major: string): string {
  return major
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Find the catalog entry a slug refers to, or `null` if nothing matches.
 *
 * Returns the *original* name, because that is what the API expects — the slug
 * exists only for the address bar. An unknown slug is not an error worth a
 * screen of its own: the caller falls back to its usual default, which is the
 * same thing that happens when there is no slug at all.
 */
export function majorFromSlug(slug: string, catalog: readonly string[]): string | null {
  const wanted = slugifyMajor(slug);
  return catalog.find((major) => slugifyMajor(major) === wanted) ?? null;
}
