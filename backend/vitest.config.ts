// Vitest running inside the real Workers runtime.
//
// Jest could not do this job any more. It runs in plain Node, which has no D1
// binding and no per-request `env` — the two things every route now depends
// on. Faking them would have meant tests that pass against a mock while the
// real Worker breaks, which is worse than no tests.
//
// @cloudflare/vitest-pool-workers runs each suite inside workerd itself, with
// a real D1 database created from the same migrations production uses.

import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Read the migration files at config time and hand them to the setup file,
// which applies them to the test database. This is what keeps the test schema
// and the deployed schema from drifting — there is no second copy of the DDL
// to forget to update.
const migrations = await readD1Migrations(path.join(here, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Bindings, compatibility date and flags all come from the real
      // wrangler.toml, so the tests cannot pass under a configuration the
      // deployed Worker does not have.
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          CORS_ORIGIN: "http://localhost:5173",
          // Both keys forced empty, which pins the chatbot to its offline
          // fallback. Not just tidiness: wrangler loads .env into the test
          // environment too, so without this override a developer who has a
          // real key would silently start billing themselves for every test
          // run of the chat route. Same mode PR previews use (Phase 7.4).
          ANTHROPIC_API_KEY: "",
          OPENAI_API_KEY: "",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/applyMigrations.ts"],
  },
});
