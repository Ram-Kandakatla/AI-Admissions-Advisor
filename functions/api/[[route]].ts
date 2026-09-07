// The API, mounted as a Cloudflare Pages Function.
//
// This is Phase 7.1 Option A in one file: a single Pages project serves the
// built frontend from frontend/dist and this function from /api/*, on one
// origin. Same origin means no CORS to configure, no second dashboard entry,
// and no second deploy to keep in step with the first.
//
// The file name is Pages' routing convention, not a typo. `[[route]]` is a
// catch-all segment, so this one function answers every path under /api —
// /api/health, /api/students/abc/notes/42, all of it. A named `[id].ts` would
// match a single segment and mean a file per route shape.
//
// There is deliberately nothing here but a re-export. The adapter itself is
// backend/src/pages.ts, because that is where `hono` resolves from — see the
// comment there. Keeping this file free of package imports is what makes it
// buildable from a directory with no node_modules above it.
//
// The `.js` extension on a `.ts` file is correct: the backend is ESM with
// `moduleResolution: "Bundler"`, and both esbuild (which builds this) and tsc
// (which checks it) map the extension back to the TypeScript source.

export { onRequest } from "../../backend/src/pages.js";
