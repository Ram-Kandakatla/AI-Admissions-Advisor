// Pages Function entry point — the second of the two ways app.ts is mounted.
//
//   src/index.ts  — a standalone Worker, what `wrangler dev` runs locally.
//   src/pages.ts  — this file, re-exported by functions/api/[[route]].ts at
//                   the repo root, which is what Cloudflare Pages deploys.
//
// Both are deliberately thin, and both mount the same Hono instance, so there
// is one routing table and one middleware stack no matter which is running.
//
// ---- Why this lives in backend/src rather than in functions/ ----
//
// Phase 7.1's sketch puts `import { handle } from "hono/cloudflare-pages"`
// directly in functions/api/[[route]].ts. That works in a flat project and
// fails in this one: module resolution walks up from the importing file, and
// there is no node_modules above functions/ — hono is installed in
// backend/node_modules, because backend/package.json is what declares it.
// tsc and esbuild both fail the same way, so this would have broken the
// Cloudflare build, not just the local typecheck.
//
// Adding hono to the root package.json would also resolve it, at the cost of
// a second copy that can drift from the one the tests and `wrangler dev` run
// against. Putting the adapter here instead leaves one hono, one version, and
// a root-level file that imports nothing but a relative path.

import { handle } from "hono/cloudflare-pages";

import app from "./app.js";

export const onRequest = handle(app);
