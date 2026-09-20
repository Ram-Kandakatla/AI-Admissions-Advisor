// Guards on the deployed wrangler config.
//
// Everything else in this suite drives the Hono app through SELF.fetch, which
// enters at the app and never crosses Cloudflare's static-assets layer. That
// layer is where the 2026-09-18 move from Pages to Workers put the routing, so
// the settings below are now load-bearing in a way no request-level test can
// observe: delete them and all 738 tests stay green while the deployed API
// answers index.html.
//
// Reading the TOML as text rather than parsing it is deliberate — the repo has
// no TOML parser and this needs none. The same approach legalPages.test.tsx
// takes to index.html, and for the same reason: a claim about a file nobody
// runs is only worth something if something reads that file.
//
// `?raw` rather than readFileSync, because this suite runs inside workerd and
// its filesystem is sandboxed — a read of the repo root fails at runtime. Vite
// inlines the contents during the transform, so no file read survives into the
// isolate. See raw.d.ts.

import { describe, expect, test } from "vitest";

import deployedConfig from "../../wrangler.toml?raw";

/** Strip comments, so a rule only mentioned in prose cannot satisfy a test. */
const settings = deployedConfig
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

describe("the deployed wrangler config", () => {
  // The one that silently removes the API. not_found_handling answers every
  // unmatched path with index.html and a 200, so without this the assets layer
  // swallows /api/* before the Worker ever runs.
  test("routes the API to the Worker ahead of static assets", () => {
    const line = settings.match(/run_worker_first\s*=\s*\[(.*)\]/)?.[1];
    expect(line, "run_worker_first is missing from wrangler.toml").toBeDefined();
    expect(line).toContain('"/api/*"');
    // The glob needs a segment after the slash, so the bare path is a separate
    // entry. Pages matched it via the optional [[route]] catch-all.
    expect(line).toContain('"/api"');
  });

  test("serves the built frontend with a single-page-app fallback", () => {
    expect(settings).toMatch(/directory\s*=\s*"frontend\/dist"/);
    expect(settings).toMatch(/not_found_handling\s*=\s*"single-page-application"/);
  });

  // Workers retains nothing unless asked, and Pages retaining logs by default
  // is why this was easy to lose in the migration.
  test("keeps logs, so an incident can be read after it happens", () => {
    expect(settings).toMatch(/\[observability\]/);
    expect(settings).toMatch(/enabled\s*=\s*true/);
  });

  // The entry has to resolve hono from backend/node_modules, which only an
  // entry under backend/ does. A root-level shim typechecks and then fails in
  // Cloudflare's build — the trap that produced the old functions/ + pages.ts
  // indirection in the first place.
  test("entry point sits where its imports resolve", () => {
    expect(settings).toMatch(/main\s*=\s*"backend\/src\/[^"]+"/);
  });
});
