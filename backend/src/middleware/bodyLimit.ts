// Refuses an oversized body from its Content-Length, before reading it. A
// request without the header is caught by readJson's size check in ../http.ts.

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
