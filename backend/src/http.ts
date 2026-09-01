// Request/response plumbing shared by the routes.

import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { MAX_BODY_BYTES } from "./middleware/bodyLimit.js";
import type { AppEnv } from "./types.js";

/**
 * Read and parse a JSON body.
 *
 * Express got this from body-parser, including its two client-error cases:
 * 413 for a payload over the cap and 400 for malformed JSON. Both matter —
 * answering either with a blanket 500 would tell an honest caller to retry a
 * request that can never succeed. Hono parses on demand, so those cases are
 * restated here rather than inherited.
 *
 * An empty body parses as `{}`, matching what Express did for a POST with no
 * payload: the route's own validation reports the missing fields, not this.
 */
export async function readJson<T>(c: Context<AppEnv>): Promise<T> {
  const text = await c.req.text();

  // Backstop for a request that arrived with no Content-Length for the
  // bodyLimit middleware to check. Byte length, not string length — a
  // multi-byte character costs more than one byte on the wire.
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new HTTPException(413, {
      res: Response.json({ error: "Request body is too large." }, { status: 413 }),
    });
  }

  if (text.trim() === "") return {} as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HTTPException(400, {
      res: Response.json({ error: "Malformed request." }, { status: 400 }),
    });
  }
}
