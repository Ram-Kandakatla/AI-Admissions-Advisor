// Worker entry point — now the only one, and the deployed one.
//
// Deliberately thin. Everything real lives in ./app.ts, and this file is read
// by both wrangler configs:
//
//   backend/wrangler.toml — the API alone on :8787, with the Vite dev server
//                           proxying /api to it. Still how the app is
//                           developed locally.
//   wrangler.toml (root)  — the deployed Worker, which also serves
//                           frontend/dist as static assets on the same origin.
//
// Until 2026-09-18 the deployed mount was a second file, ./pages.ts, wrapped
// in hono/cloudflare-pages and re-exported by functions/api/[[route]].ts.
// Moving from Pages to Workers deleted both: the root config points `main`
// straight here instead. The constraint that forced the indirection still
// holds and is the reason `main` reaches into backend/ rather than being given
// a tidy root-level shim — module resolution walks up from the entry file, and
// only an entry under backend/ finds hono in backend/node_modules.

import app from "./app.js";

export default app;
