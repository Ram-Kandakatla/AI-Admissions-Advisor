// Frontend tests run in jsdom, deliberately apart from the app's Vite build.
//
// This config does not extend vite.config.ts, and that separation is load-
// bearing rather than tidiness: Vitest 4 brings its own Vite 8 for the test
// transform, while the app still builds on Vite 5 with @vitejs/plugin-react.
// Sharing one config would force those two Vites to agree about a plugin
// neither test needs — JSX in a test file only has to compile, not hot-reload
// — so the tests use esbuild's automatic runtime (from tsconfig's
// "jsx": "react-jsx") and leave the build pipeline untouched.
//
// The backend's suite is a separate project entirely: it runs inside workerd,
// because what it tests is D1 and the request `env`. There is no shared root
// config, and there shouldn't be — the two suites need genuinely different
// runtimes.

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
