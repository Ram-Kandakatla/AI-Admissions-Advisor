// Frontend tests run in jsdom, deliberately apart from the app's Vite build.
//
// This config does not extend vite.config.ts, and the frontend does not share
// one with the backend. That separation is load-bearing rather than tidiness:
// the backend suite runs inside workerd, because what it tests is D1 and the
// per-request `env`. There is no configuration those two share beyond the word
// "vitest", and a root config would have to special-case every option per
// project — indirection with no deduplication to show for it.
//
// JSX here compiles through esbuild's automatic runtime (from tsconfig's
// "jsx": "react-jsx") rather than @vitejs/plugin-react: a test file only has to
// compile, not hot-reload.
//
// ---- Why the frontend is pinned to Vitest 3 while the backend is on 4 ----
//
// Vitest 4 brings its own Vite 8, which declares `esbuild` as an *optional
// peer*. npm resolves that peer but writes its per-platform packages into the
// lockfile without the `optional` marker the 0.21 set carries, so `npm ci` on
// Linux tries to install @esbuild/netbsd-arm64 and hard-fails with
// EBADPLATFORM. CI found this; `npm ci --dry-run --os=linux --cpu=x64`
// reproduces it locally. Vitest 3's Vite peer range covers the app's Vite 5,
// so build and test share one Vite, one esbuild, and a lockfile that installs
// anywhere. Aligning both suites on Vitest 4 means moving the app to Vite 7 —
// a real build upgrade that belongs with the Phase 5 frontend work.

import { defineConfig } from "vitest/config";

// Pin the clock's timezone for the whole suite.
//
// dates.ts exists because `new Date("2026-01-15")` parses as UTC midnight and
// therefore renders as Jan 14 anywhere west of Greenwich. A suite running in
// UTC — which is exactly what a GitHub Actions runner gives you by default —
// cannot observe that bug at all: every assertion about it would pass against
// the broken implementation. New York is west of Greenwich and observes DST,
// so both failure modes the module guards against are reachable here.
process.env.TZ = "America/New_York";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Explicit imports over globals, matching the backend suite: a test file
    // that reads `import { describe } from "vitest"` typechecks under the
    // same `tsc -b` the build runs, with no ambient types to configure.
    globals: false,
    restoreMocks: true,
  },
});
