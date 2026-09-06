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

// jsdom does not implement matchMedia at all — it is a layout question, and
// jsdom has no layout. The nav asks it which shape to be (dropdowns on a wide
// header, flat labelled sections in the mobile panel), so without this every
// test that renders the app chrome dies on `window.matchMedia is not a
// function` before it reaches its first assertion.
//
// It answers `false` to everything, which means the wide-header nav. That is
// the desktop shape, and it is deliberate rather than incidental: it is the
// one with dropdowns, so it is the harder of the two to get right. A test that
// needs the mobile shape should override this itself.
// jsdom implements no scrolling either, for the same reason: scrolling is a
// layout operation and there is no layout. The chat panel pins itself to the
// newest message on every render, so without this every ChatBot test dies in
// an effect before reaching its first assertion.
//
// A no-op rather than a spy. What these tests assert is which messages are in
// the thread, never how far it scrolled — and a component that had to check
// `scrollTo?.()` before calling it would be carrying a defensive branch that
// exists only to satisfy a test environment.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    media: query,
    matches: false,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    // Deprecated, but React and other libraries still feature-detect them.
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}
