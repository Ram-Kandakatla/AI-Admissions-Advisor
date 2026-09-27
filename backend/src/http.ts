import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { MAX_BODY_BYTES } from "./middleware/bodyLimit.js";
import type { AppEnv } from "./types.js";

/**
 * 413 for an oversized body and 400 for bad JSON, never a 500 that invites a
 * retry. An empty body parses as `{}` so route validation names what's missing.
 */
export async function readJson<T>(c: Context<AppEnv>): Promise<T> {
  const text = await c.req.text();

  // Backstop for a request with no Content-Length for bodyLimit to check.
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new HTTPException(413, {
      // Logged by onError; the client gets `res`.
      message: "request body exceeded the size cap",
      res: Response.json({ error: "Request body is too large." }, { status: 413 }),
    });
  }

  if (text.trim() === "") return {} as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HTTPException(400, {
      message: "request body is not valid JSON",
      res: Response.json({ error: "Malformed request." }, { status: 400 }),
    });
  }
}
