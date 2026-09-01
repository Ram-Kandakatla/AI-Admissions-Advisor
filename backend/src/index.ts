// Worker entry point.
//
// Deliberately thin. Everything real lives in ./app.ts so the same Hono
// instance can be mounted two ways without moving code:
//
//   now (Phase 1)  — this file, run by `wrangler dev` as a standalone Worker
//                    on :8787, with the Vite dev server proxying /api to it.
//   Phase 7        — functions/api/[[route]].ts at the repo root:
//                      import app from "../../backend/src/app";
//                      import { handle } from "hono/cloudflare-pages";
//                      export const onRequest = handle(app);
//
// Keeping the entry separate from the routes is what makes that a four-line
// addition instead of a second migration.

import app from "./app.js";

export default app;
