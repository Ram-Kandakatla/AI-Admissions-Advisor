# Phase 3 — Testing & CI

What changed, why the two suites deliberately don't share a runner, and what is
left for later.

The short version: the frontend had no tests at all. It now has 99, and both
suites plus both typechecks and the production build run on every pull request.
Nothing deploys from CI, and that is on purpose.

## Two suites, two runtimes, no shared config

The obvious tidy-up here is a root Vitest config with two projects. It would be
wrong.

The backend suite runs inside **workerd**, because what it is testing is D1 and
the per-request `env` — the two things a Node-based runner cannot give it
without a mock, and a mock is exactly how you end up with tests that pass while
the deployed Worker breaks. The frontend suite runs in **jsdom**, because what
it is testing is a DOM.

There is no configuration those two share beyond the word "vitest". A root
config would have to special-case every option per project, which is a shared
file that is never actually shared — more indirection, no less duplication. So
`backend/vitest.config.ts` and `frontend/vitest.config.ts` stand alone, and the
root `package.json` runs them in sequence.

### The Vite version the frontend tests do not use

Vitest 4 brings its own Vite 8 for the test transform; the app still builds on
Vite 5 with `@vitejs/plugin-react` 4, which supports Vite 7 at the newest.
`frontend/vitest.config.ts` therefore does **not** extend `vite.config.ts`, and
loads no React plugin: JSX in a test file only has to compile, not hot-reload,
so esbuild's automatic runtime (from `tsconfig.json`'s `"jsx": "react-jsx"`)
covers it. The build pipeline is untouched, and neither Vite has to agree with
the other about a plugin neither test needs.

The alternative — upgrading the app to Vite 7 to align them — is a real
upgrade with its own regression surface, and it belongs in Phase 5 next to the
router and code-splitting work, not in a testing phase.

## The timezone pin is the most load-bearing line in the config

```ts
process.env.TZ = "America/New_York";
```

`frontend/src/dates.ts` exists for one reason: `new Date("2026-01-15")` parses
as **UTC** midnight, which renders as January 14 anywhere west of Greenwich. A
tracker that says an application is due Oct 31 when it is due Nov 1 is worse
than no tracker.

A test suite running in UTC cannot observe that bug. Every assertion about it
passes against the broken implementation, because in UTC the broken
implementation is correct. And UTC is exactly what a GitHub Actions runner
gives you by default — so without this line, the tests that look like they
guard `dates.ts` would have guarded nothing on the machine that matters.

New York is west of Greenwich and observes DST, which also makes the two
clock-change cases reachable: `daysUntil` divides raw milliseconds by 86,400,000
and rounds, and the suite pins a 23-hour day (March 8, 2026) and a 25-hour one
(November 1, 2026) to prove the rounding is what keeps a two-week gap from
reading "13 days left".

## What each suite is actually for

Priority came from the guide's §3.2: test what breaks **silently**.

| File | Why it is first |
|---|---|
| `exportList.ts` (22 tests) | Produces a file that leaves the app. A quoting bug does not throw — it writes a corrupt CSV a student mails to their counselor. |
| `dates.ts` (16) | Off-by-one deadlines look plausible. Nothing crashes. |
| `compare.ts` (7) | Small, but it holds React state; an in-place mutation renders nothing and looks like a dead button. |
| `useSchoolNotes.ts` (17) | Five pages share it. Debounce, optimistic writes, per-school timers, and a stale-response race — all of it invisible until a note silently fails to save. |
| `ProfileForm` (16) | The front door, and where Phase 2's create-vs-update regression lived. |
| `ApplicationTracker` (21) | The most stateful screen: optimistic patches, rollback on rejection, and the binding-ED warning. |

Three tests are worth naming individually, because they pin a decision rather
than a behaviour:

- **`exportList` defuses spreadsheet formulas** — a value starting `=`, `+`,
  `-` or `@` gets a leading apostrophe, but *numbers do not*, so a negative
  `gpaGap` stays sortable. Both halves are asserted; guarding numbers too would
  break sorting on the column that matters most.
- **`ProfileForm` updates rather than creates** when a profile already exists.
  Before Phase 2 it POSTed on every save, creating a second student row and
  stranding the first — with its notes and tracked applications still attached.
- **`useSchoolNotes` keeps one debounce timer per school.** Editing school A's
  note and then school B's inside the 700ms window has to save both. One shared
  timer would silently drop the first.

### One thing the tests caught, and it was in the test

Writing the `downloadCsv` test, `await blob.text()` reported no BOM — because
the Blob text decoder strips one per spec. The assertion would have passed
whether or not the prefix was there. It now reads the bytes:

```ts
const bytes = new Uint8Array(await blob.arrayBuffer());
expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
```

Bytes on disk are what Excel is reading, so that is what the test reads too.

Worth stating plainly: **this phase found no production bugs.** The suite is a
regression net for work that already worked, not a bug hunt that paid off. That
is the expected outcome for tests written after the code, and it is not an
argument against writing them — Phase 5's router rewrite and code-splitting are
exactly the kind of change that breaks a debounce or a sort order without
anybody noticing.

### What CI caught on its first run, which was not a test

`frontend/package-lock.json` was **platform-incomplete**, and the first CI run
failed on it:

```
npm error Missing: @esbuild/linux-x64@0.28.2 from lock file
```

Vitest 4's bundled Vite 8 declares `esbuild` as an *optional peer*. Installing
the test dependencies incrementally (`npm install -D vitest …` on top of an
existing tree) resolved that peer on this machine but never wrote it — or any
of its 81 per-platform packages — into the lockfile. Deleting `node_modules`
and the lock and installing once from scratch records all of them.

Two things about this are worth keeping:

- **`npm ci` is what found it, and `npm install` never would have.** `npm ci`
  fails when the lock and the resolved tree disagree; `npm install` would have
  quietly fixed it up on the runner and left the lock broken for the next
  machine.
- **It would have broken the Phase 7 deploy, not just CI.** Cloudflare Pages
  builds on Linux from this same lockfile. The first CI run of this repo's life
  paid for itself before a single test assertion ran.

Locally, `npm ci --dry-run` **passed** against the broken lock, because the
missing packages were the ones this machine does not need. `npm ci --dry-run
--os=linux --cpu=x64` reproduces the runner's answer without pushing.

## Small choices worth knowing about

- **Globals are off** (`globals: false`), matching the backend. Test files
  import `describe`/`it`/`expect` from `vitest`, which means they typecheck
  under the same `tsc -b` the build runs, with no ambient types configured.
  The cost is that Testing Library's automatic cleanup does not register, so
  `src/test/setup.ts` calls `cleanup()` in an `afterEach` by hand — without it
  a component from one test stays mounted and the next test finds two of
  everything.
- **`@testing-library/jest-dom/vitest`, not `/matchers`.** The `/vitest` entry
  registers the matchers *and* declares them on Vitest's `Assertion` type.
  `expect.extend(matchers)` registers them at runtime only, and every
  `toBeInTheDocument` in the suite then fails the build.
- **Test files live under `src/`**, so `tsc -b` typechecks them and `vite
  build` does not bundle them (nothing imports them from `main.tsx` — the
  build is still 51 modules).
- **`userEvent.setup({ advanceTimers })`** wherever the clock is faked. Without
  it, user-event's internal waits never resolve and every interaction hangs.
- **Fixtures are builders**, in `src/test/factories.ts`, each taking a partial
  override. A test names only the fields it asserts on, which is what makes it
  readable — and adding a field to `Application` does not break a dozen files.

## CI

`.github/workflows/ci.yml`, two jobs:

- **Backend** — `npm ci`, `typecheck`, `test` (in workerd, against D1).
- **Frontend** — `npm ci`, `test` (jsdom), then `build`, which runs `tsc -b`
  before Vite and so covers the test files too.

Details that are choices rather than boilerplate:

- **No deploy step.** Cloudflare Pages' git integration (Phase 7.2) builds and
  deploys on push to `main` and gives every PR a preview URL. Wiring `wrangler
  deploy` into Actions would mean maintaining a second deploy path and keeping
  a Cloudflare API token in repository secrets, to do worse what the platform
  already does. Actions says whether the code is safe to merge; Cloudflare
  ships it.
- **`node-version-file: .nvmrc`**, not a literal `22`. One place to change the
  Node version, and it is already the file contributors read.
- **`npm ci`, not `npm install`.** It installs exactly the lockfile and fails
  if `package.json` and the lock have drifted — the check you want in CI and
  the behaviour you do not want on a laptop.
- **`concurrency` with `cancel-in-progress`.** A second push to a branch makes
  the first run's answer irrelevant.
- **`permissions: contents: read`.** The workflow reads code and runs tests; it
  has no reason to hold a write token.
- **No API keys are set**, so the backend's chat route runs its offline
  fallback — the same mode Phase 7.4 plans for PR previews, and the reason a CI
  run cannot spend LLM money.

## Left for later

- **Branch protection (§3.4) is deliberately not on.** It is a repository
  setting, not code, and turning it on before CI has run green on `main` at
  least once means a rule pointing at check names that have never reported.
  When you want it: GitHub → Settings → Rules → Rulesets → New branch ruleset,
  target `main`, enable **Require status checks to pass**, and add
  `Backend (Workers runtime)` and `Frontend (jsdom)`.
- **`npm audit` reports a moderate advisory** in esbuild via Vite 5
  (dev-server-only: a website can make the local dev server return responses).
  The fix is a Vite major upgrade, which belongs with the Phase 5 frontend
  work rather than inside a testing phase. It does not affect the built site,
  which is static files.
- **No coverage thresholds.** A percentage gate rewards testing whatever is
  cheapest to cover. The priority list above is the policy instead.
