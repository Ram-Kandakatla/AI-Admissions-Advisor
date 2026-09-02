// Per-run and per-test setup.
//
// Applies the real D1 migrations to the test database before any test runs.
// `TEST_MIGRATIONS` comes from vitest.config.ts, which reads the same
// migrations/ directory wrangler deploys from — so there is no second copy of
// the schema that can drift from production's.

import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";
import { resetSession } from "./helpers.js";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Phase 2 made the helpers keep a cookie jar, and a jar that survives between
// tests is a shared fixture nobody declared: one test's leftover session would
// hit the next test's "one profile per account" rule, or authorize a request
// that should have been anonymous. Every test starts signed out.
beforeEach(resetSession);
