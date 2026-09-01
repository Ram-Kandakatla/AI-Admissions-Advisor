// Bindings, for the two type systems that need to know about them.
//
// Hand-written rather than generated. `wrangler types` produces this file too,
// but it also inlines whatever happens to be in the local .env — a developer
// with different keys generates a different file, which makes it a bad thing
// to commit. src/types.ts already states the bindings once; this just points
// the ambient `Cloudflare.Env` at it so `cloudflare:test`'s `env` is typed.

import type { Env as CompassEnv } from "./src/types.js";

declare global {
  namespace Cloudflare {
    interface Env extends CompassEnv {
      /** Test-only: the migrations vitest.config.ts reads and applies. */
      TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers").D1Migration[];
    }
  }
}

export {};
