// Runs before every test file.

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// The /vitest entry point rather than /matchers: it registers the matchers
// *and* declares them on Vitest's Assertion type, so `toBeInTheDocument` type-
// checks under the same `tsc -b` the production build runs. Calling
// expect.extend by hand registers them at runtime only, and every assertion in
// the suite then fails the build.
import "@testing-library/jest-dom/vitest";

// Testing Library only auto-cleans when Vitest's globals are on, and they are
// deliberately off here. Without this, a component from one test stays mounted
// in the document and the next test's getByRole finds two of everything.
afterEach(() => {
  cleanup();
});
