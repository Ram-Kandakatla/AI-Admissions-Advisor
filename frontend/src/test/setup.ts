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

// jsdom implements no ResizeObserver, for the same reason it implements no
// matchMedia or scrollTo: all three are questions about layout, and there is
// no layout here. The cookie notice observes itself so it can publish its own
// height for the footer to clear — see CookieNotice.tsx — and without this it
// throws on mount and takes down every test that renders the app chrome.
//
// The callback fires once on observe and never again. That mirrors the one
// guarantee the real API makes — an initial observation is delivered as soon
// as an element is observed — and stops there, because everything after that
// is driven by layout changes jsdom will never have. It is enough for a test
// to assert that a height was published; a test about *which* height belongs
// in a browser, where the numbers are real.
if (!window.ResizeObserver) {
  window.ResizeObserver = class implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target } as ResizeObserverEntry], this);
    }
    unobserve() {}
    disconnect() {}
  };
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

// jsdom under this Vitest version exposes no `localStorage` at all — the
// global is undefined rather than empty. Three things in the app read or write
// it: the theme persists there, index.html's pre-paint script reads it back,
// and the cookie notice records that it has been dismissed. All three are
// wrapped in try/catch for private-mode browsers, so the missing global did
// not fail anything — it silently took the *else* branch of every one of them,
// which meant no test could observe the behaviour it was supposed to be
// covering.
//
// A plain in-memory object rather than an instance of jsdom's Storage: the
// app only ever calls these five methods, and building on Storage.prototype
// would buy nothing except a subtler thing to go wrong. A test that needs a
// throwing storage (private mode, quota exceeded) spies on this object
// directly — `vi.spyOn(window.localStorage, "setItem")` — which works against
// a plain object and would not work against a prototype-backed one shared
// with sessionStorage.
if (!window.localStorage) {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    // Real storage stringifies whatever it is handed, and a test passing a
    // number should see the same "1" the browser would.
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
  };
  Object.defineProperty(window, "localStorage", {
    value: memoryStorage,
    configurable: true,
  });
}

// Storage outlives a render, so it has to be reset the way the document is —
// without this, a theme written by one test decides what the next one sees,
// and the pair passes or fails depending on the order they ran in.
afterEach(() => {
  window.localStorage.clear();
});
