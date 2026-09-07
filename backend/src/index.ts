// Worker entry point — the local dev loop's mount of the app.
//
// Deliberately thin. Everything real lives in ./app.ts so the same Hono
// instance can be mounted two ways without moving code:
//
//   this file    — run by `wrangler dev` as a standalone Worker on :8787,
//                  with the Vite dev server proxying /api to it. Still how
//                  the app is developed locally.
//   ./pages.ts   — the deployed mount, re-exported by the repo root's
//                  functions/api/[[route]].ts and run by Cloudflare Pages.
//
// Keeping the entry separate from the routes is what made the second one a
// four-line addition instead of a second migration. It did not stay quite as
// small as Phase 1 guessed: the plan sketched here had the root function
// import hono directly, which cannot resolve from a directory with no
// node_modules above it, so the adapter lives next door in pages.ts. See the
// comment there.

import app from "./app.js";

export default app;
