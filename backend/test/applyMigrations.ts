// Applies the real D1 migrations to the test database before any test runs.
// `TEST_MIGRATIONS` comes from vitest.config.ts, which reads the same
// migrations/ directory wrangler deploys from — so there is no second copy of
// the schema that can drift from production's.

import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
