// Request body cap.
//
// `express.json({ limit: "100kb" })` did two jobs: it parsed the body and it
// refused an oversized one with a 413. Hono parses on demand instead, so the
// cap becomes its own middleware.
//
// Checking Content-Length rejects the request before the body is read, which
// is the point — an oversized payload costs nothing to refuse. A request that
// omits the header is not waved through: c.req.json() would still buffer it,
// so the parsed-size check in ./errors.ts backstops this.

import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types.js";

export const MAX_BODY_BYTES = 100 * 1024;

export function bodyLimit(maxBytes: number = MAX_BODY_BYTES) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD") return next();

    const declared = c.req.header("content-length");
    if (declared !== undefined) {
      const length = Number(declared);
      if (Number.isFinite(length) && length > maxBytes) {
        return c.json({ error: "Request body is too large." }, 413);
      }
    }

    return next();
  });
}
