# Phase 5 — Frontend polish

Giving the app addresses, making the first load smaller anyway, and an
accessibility pass that found more in the design tokens than in the markup.

The short version: `App.tsx` drove navigation with a `view` state variable, so
nothing in Compass had a URL — no bookmark, no shared link, no back button.
There are now fourteen routes, the first load is **29 kB smaller than before
the router existed**, and axe-core reports zero violations across all of them
in both themes.

## §5.1 — The router

[`react-router-dom`](https://reactrouter.com) 7, `BrowserRouter`. The chrome —
header, nav, the two banners, footer — moved out of `App.tsx` into
[`Layout.tsx`](frontend/src/components/Layout.tsx), which renders every route
into an `<Outlet />`. `App` kept the state the pages share (`student`, `meta`,
`user`, `notes`, `compareIds`, `theme`) and gained the route map.

| Path | | Path | |
|---|---|---|---|
| `/` | Home | `/compare?ids=1,3` | Comparison |
| `/profile` | Profile form | `/majors` → `/majors/:major` | Deep dive |
| `/matches` `/scholarships` `/saved` `/tracker` | Profile-gated | `/explore` `/timeline` `/chat` | Open |
| `/signin` `/signup` | Account | `*` | 404 |

`/signin` and `/signup` are two paths rather than `/account?mode=`: they are
the URLs people type, and the tab control becomes a `navigate` instead of a
piece of lifted state.

### The callback props are gone

`onEdit`, `onGoMatches`, `onAsk`, `onGoCompare`, `onGoExplore`, `onGoTracker`,
`onStart`, `onBuildProfile`, `onMode` — nine props across eight components,
every one of them a `<button onClick>` that navigated. They are `<Link>`s now.
That is not tidiness: an anchor gets cmd-click, middle-click, "copy link
address", and a screen reader announcing "link" instead of "button", none of
which a click handler can fake.

Two controls deliberately stayed buttons:

- **The compare tray.** It is disabled until two schools are ticked, and an
  anchor has no disabled state. One that only looks disabled is still
  keyboard-reachable, which is worse than a button.
- **The account tabs.** A two-state segmented switch with `aria-pressed`.

The same rule decides the nav: a destination behind a profile you do not have
yet renders as a disabled `<button>`, and everything else as a `NavLink`.

### State that belongs in the URL

Two pages had state worth linking to, and the point of a router is that "send
me that page" works:

- **`/compare?ids=1,3`.** `compareIds` stays in `App` — the ticks that build it
  happen on `/matches`, where they have nowhere else to live — and a small
  `CompareRoute` bridges it to the query string in one direction each way: the
  URL seeds the state once on arrival, then the state writes the URL as the
  selection changes. Writes are `replace`, because twelve tick-throughs should
  not be twelve presses of the back button.

  The parameter is built by hand rather than through `URLSearchParams`, which
  percent-encodes the separator: `?ids=1%2C3` round-trips perfectly and looks
  like an error to the person being sent it.

- **`/majors/:major`.** Slugified (`computer-science`), because the encoded
  alternative (`/majors/Computer%20Science`) reads like a leak of the database.
  Slugifying is lossy, so [`slug.ts`](frontend/src/slug.ts) resolves a slug back
  against the fetched catalog rather than trying to invert it, and an unknown
  slug falls through to the same default as no slug at all — a mistyped URL
  deserves the page, not an error. The bare `/majors` rewrites itself to the
  resolved major with `replace`, so every visit ends somewhere linkable and the
  back button does not bounce off the redirect.

The explorer's four filters were left out. Four query parameters is a lot of
machinery for a page nobody shares.

### The bug a router made possible

This is the one genuinely new failure mode, and it is worth stating because it
could not have existed before:

```tsx
const gated = (page: (s: StudentRecord) => JSX.Element) => {
  if (student) return page(student);
  return restoring ? <RestoringProfile /> : <NeedsProfile />;
};
```

A bookmarked `/matches` renders **before** `GET /api/auth/me` answers. Without
`restoring`, the gate sees `student === null` and tells someone who has a
profile to go and build one. Under the old state-based navigation you always
arrived at Home and clicked your way in, so by the time a profile page rendered
the fetch was long done — the gap did not exist. There is a test that asserts
the wall never appears during it.

## §5.2 — Code-splitting

`React.lazy` on every page except Home, ProfileForm, and the 404 — the whole of
the path a first-time visitor walks, where there is nothing yet to wait for.

| | JS on first load | gzip |
|---|---|---|
| Before Phase 5 | 239.0 kB | 73.4 kB |
| After the router alone | 279.4 kB | 87.4 kB |
| **After splitting** | **209.7 kB** | **68.2 kB** |

### The guide names the wrong three pages

§5.2 says "`ChatBot`, `SchoolCompare`, and `ApplicationTracker` are the heaviest
screens." Measured:

```
ApplicationTimeline   13.01 kB   ← heaviest, unmentioned
ApplicationTracker    10.86 kB
MajorDeepDive          9.86 kB   ← unmentioned
Scholarships           8.63 kB   ← unmentioned
SchoolCompare          8.52 kB
Recommendations        6.03 kB
SavedSchools           4.56 kB
UniversityExplorer     4.34 kB
Account                3.26 kB
ChatBot                3.03 kB   ← named as heaviest; it is the lightest page
```

`ChatBot` is a message list and a textarea — its weight is API round-trips, not
code. `ApplicationTimeline` is heaviest because it bundles
[`milestones.ts`](frontend/src/data/milestones.ts).

Every page is split, not the named three: leaving a 6 kB page eager to save it
one request charges those 6 kB to every visitor who never opens it.

### One boundary, inside the chrome

`<Suspense>` wraps the `<Outlet />` in `Layout`, not `<Routes>` in `App`. The
header, nav and footer are already on screen and stay there while the next page
downloads; wrapping `<Routes>` would blank the chrome on every navigation and
make a 3 kB fetch look like a full page load. One boundary rather than twelve,
because they share a fallback and none of them can be on screen at once.

The fallback is invisible for its first 250 ms (`.spinner-delayed`). A chunk off
a warm cache arrives in tens of milliseconds, and a spinner that appears and
vanishes inside that reads as a flicker, not as progress. It survives the
`prefers-reduced-motion` block, which collapses animation *duration* but not
*delay* — the ring appears rather than fading, and does not spin.

## The error boundary

Not in §5, but [PHASE-4.md](PHASE-4.md#left-for-later) parked it here: "it needs
a designed error state, not a bare `<div>`."

[`ErrorBoundary.tsx`](frontend/src/components/ErrorBoundary.tsx) is mounted
twice. Inside `Layout` around the routed page, keyed on the pathname, so a
crashed page leaves a navigable app and clicking any other nav link clears the
error — the first thing anyone tries. And outside `BrowserRouter` in
`main.tsx`, for the cases the inner one is by definition too deep to see:
`Layout` itself throwing, or route matching. The inner one is what will fire in
practice; the outer one exists so that "in practice" is not load-bearing.

### Two states, because code-splitting created a second failure

A tab left open across a deploy holds an `index.js` naming chunks by a content
hash the server no longer has. Nothing is broken and nothing is lost, so
"something went wrong" would be both unhelpful and untrue:

| | Ordinary render error | Stale chunk |
|---|---|---|
| Heading | "Compass lost its bearing." | "Compass updated while this tab was open." |
| Action | Try this page again · Back to the start | **Reload Compass** — a re-render cannot fix it |

Detection matches the three strings Chrome, Firefox and Safari use for a failed
dynamic import, matched loosely on purpose: none is a stable API, and
over-matching costs a harmless offer to reload while under-matching leaves
someone staring at a dead end when one button would have fixed it.

The card leads with **"your work is safe"**, because that is the actual
question. It is true since Phase 2 — profile, notes and tracker live in D1
behind the session cookie — and worth saying explicitly given the rest of the
app's copy spends its time telling guests their list is fragile. The red is
spent entirely on the mark, the app's own compass rose with its needle swung
38° off true; an error nobody caused and nobody can fix does not need the page
to shout.

## §5.3 — SEO, sharing, and icons

`index.html` already had a title and a description. What it had no version of
at all was an icon — there was no `frontend/public/` directory.

### The icons have a generator, not just files

[`scripts/build-icons.mjs`](frontend/scripts/build-icons.mjs) (`npm run icons`)
rasterises the mark and encodes PNG and ICO directly with `node:zlib`. It
produces `favicon.ico`, `apple-touch-icon.png` (opaque and padded, since iOS
masks to a rounded square and composites transparency onto black), and
`og-image.png`.

Shelling out to a converter was tried first and is a trap worth recording:
**macOS `qlmanage` renders an SVG at its intrinsic size into a corner of the
requested canvas rather than filling it**, and fails silently — the result is a
valid PNG that is mostly empty. Rasterising in the browser worked but produced
binaries that had to travel back as base64, which corrupted them. Two polygons
and a couple of circles are less code than working around either, and behave
identically on every machine.

`favicon.svg` is hand-written and is what current browsers actually load. It is
**not** `BrandMark.tsx`: that is line art whose colours are CSS variables, and
neither survives here — a favicon is fetched as a standalone document with no
access to the page's CSS, and a 1.5 px stroke turns to grey mush at 16 px. It is
redrawn as a solid disc with two filled needles, using the *dark* theme's
periwinkle rather than the light theme's darker blue, because the needle has to
read against ink.

The social card is deliberately wordless. Every platform that renders one
already shows `og:title` and `og:description` as text beside it, so setting the
name in pixels too would be the same words twice in a font that would have to
be embedded to exist. The right half carries the reach / target / safety stack
from the hero instead, in the three colours that mean those things everywhere
else in Compass.

### Two limitations, both stated in the head

- **Every absolute URL is `https://compass.example.com`.** Open Graph requires
  absolute URLs — a relative `og:image` is ignored by most scrapers — so these
  cannot be real until Phase 7.5 attaches the domain. Three occurrences: the
  canonical, `og:url` and `og:image`.
- **The tags are static, so `/matches` shares the same card as the homepage.**
  Per-route cards need the HTML to differ per URL, which means prerendering: a
  Pages concern, and not worth it for an app whose pages are all behind a login.

### Per-route titles

[`titles.ts`](frontend/src/titles.ts). Before the router one title was correct
because there was one URL; now there are fourteen, all bookmarkable and all
capable of sitting in a row of tabs during an afternoon of applications.

The brand is a suffix, not a prefix: a narrow tab truncates from the right, so
"Your matches — Comp…" still says which tab it is and "Compass — Your ma…" does
not. `/majors/:major` un-slugs its own segment rather than waiting on the
catalog fetch, which is lossy where a name carries punctuation
("Business / Economics" → "Business Economics") — the right trade for a tab
label and the wrong one for anything rendered on the page.

## §5.4 — Accessibility

axe-core 4.10 over **14 routes × 2 themes**, from violations on four of the five
screens §5.4 names to zero on all of them. (axe-core rather than Lighthouse:
Lighthouse's accessibility category *is* axe-core, so the rule coverage is
identical, but no Lighthouse score is being quoted here.)

### The same mistake four times

The token block at the top of `global.css` is careful — each accent is "the
original hue held, then darkened until it clears 4.5:1 as *small* text on the
sky." Then four separate rules faded those tokens back below the line they had
been computed to clear:

| Rule | | Measured |
|---|---|---|
| `.score-badge .l` | `opacity: 0.75` | 3.47:1 |
| `.sch-tag` | `opacity: 0.75` | 3.62:1 |
| `.chip-count` | `opacity: 0.62` | 2.77:1 |
| `.rm-kind` | `color-mix(… , transparent)` over the sky | 4.38:1 |

Nobody does this deliberately. It happens because the token and the opacity are
written months apart, and the opacity looks like a purely visual decision. The
fix in every case was deleting the fade — the size difference already carried
the hierarchy.

A second group was `--txf`, the *faint* token, used for prose: `.sch-note`
(when a scholarship opens and closes), `.uni-note` (the student's own note),
`.saved-when`. All 2.21:1, all now `--txm`, which is the secondary text token
picked to clear AA on every ground the app uses.

### One `h1` per page

No page except Home had one — the inner pages opened with
`<h2 class="section-title">`. Giving each page its `h1` then cascaded: every
heading below it had to shift up a level, including eight `.sec-hd` `<div>`s
that became real `<h2>`s. Those looked like section labels to anyone sighted and
were invisible to a screen reader's heading list, which is how `/majors` managed
to go from `h1` straight to `h4`.

`h1` and `h2` share identical base styles in this stylesheet, so the swap was
purely semantic — two lines on `.sec-hd` (`font-family`, `line-height`) keep the
converted divs pixel-identical. Every route now has exactly one `h1` and no
level skips, verified by dumping the outline rather than trusting a clean rule.

### What axe could not see

§5.4 asks for two checks by hand. Both were clean, and both led to something
next door that was not.

**`ProfileForm`'s focus order is correct.** No positive `tabindex`, 39 focusable
elements in reading order. (Worth correcting the guide: this is a *single-step*
form, not the "multi-step `ProfileForm`" §5.4 describes — there is no
step-to-step focus handoff to get wrong.) But it had **two bare `<label>`
elements labelling nothing**. A `<label>` with no `for` and no control inside it
is styled text, so 22 major chips and 4 region chips had no accessible group
name — a screen reader user tabbed into 22 unexplained buttons. Now three named
`role="group"`s via `aria-labelledby`, pointing at the text already on screen so
there is one source of truth rather than a visible label and a duplicate
`aria-label`.

**`NoteHint`'s dismissal should not announce itself**, which is the honest
answer to the question §5.4 asks. It is instructional text that retires the
moment a student stars anything; announcing the removal of instructions nobody
asked for is noise. What should confirm the action is the star — and the star
was wrong:

```jsx
aria-pressed={starred}
aria-label={starred ? `Unsave ${name}` : `Save ${name}`}   // before
```

The name flipped at the same instant the state did, so a screen reader
announced **"Unsave Carnegie Mellon, pressed"** — a name and a state that
contradict each other. A toggle button keeps one name and lets `aria-pressed`
carry the state. The tooltip, which only sighted users get and which has no
pressed state to lean on, still says both.

The notepad had the mirror-image problem. Its status line is a live region and
announced "Saving…", then fell silent, on the reasoning recorded in the comment:
"Silence means saved." That works when you can watch the word disappear and is
indistinguishable from a failed save when you cannot. It now announces "Saved",
and drops it on the next keystroke.

### Mobile

375 px: no horizontal scroll, zero violations. One tap target under 44×44 — the
banner dismiss `×` at **34×40**, beneath a comment claiming it was 44. The
padding alone could not get there because the glyph is narrower than its
`font-size`. Fixed with the invisible-`::after` hit area `.tag button` already
used, and confirmed by hit-testing: ±21 px in every direction resolves to the
button, ±30 px does not.

## Tests

**155 frontend tests, was 99.** The backend's 165 are untouched; 320 total.

| File | | Why |
|---|---|---|
| `App.test.tsx` | 17 | The first tests to render `App`. Before a router there was nothing here worth asserting — it was a switch over `useState`. |
| `ErrorBoundary.test.tsx` | 13 | Including all three stale-chunk messages and the `resetKey` contract in both directions. |
| `App.crash.test.tsx` | 3 | That the boundary sits *inside* `Layout`. Move it out and "leaves the app navigable" is the assertion that fails. |
| `slug.test.ts` | 9 | The round-trip, since slugifying is lossy. |
| `titles.test.ts` | 7 | Including one asserting every nav destination has a title, with the list written by hand so adding a route fails it. |
| `SchoolNote.test.tsx` | 7 | The two hand findings, written down because nobody touching those controls later will think of them. |

`App.crash.test.tsx` is a separate file because it mocks a page module into
throwing, and a mock like that leaking into `App.test.tsx` would quietly break
unrelated route tests — the same reasoning as the backend's
[`loggingD1Down.test.ts`](backend/test/loggingD1Down.test.ts).

Two things the suite caught that a human would not have:

- **Three `{ level: 4 }` assertions in the tracker's tests** failed the moment
  the heading outline shifted. That is precisely what a regression net is for,
  and PHASE-3.md predicted this shape of change would be the one to need it.
- **`npm test` passed while `npm run build` failed.** A function whose body only
  throws infers `void`, which is not a valid JSX element type; Vitest does not
  typecheck, so only `tsc -b` saw it. The kind of thing that otherwise reaches
  CI rather than your laptop.

## Left for later

- **§5.5, the PWA / offline shell.** Deliberately skipped. A service worker's
  caching semantics interact with how Pages serves the app, which is easier to
  reason about once Phase 7 exists than before it.
- **A `manualChunks` vendor split.** The 209.7 kB entry is roughly 182 kB of
  React, React DOM and React Router plus ~28 kB of app code, in one file — so
  every deploy invalidates the whole thing for returning visitors. Four lines
  would cut the re-download to the app half. Left out because it is a different
  kind of split than §5.2 asks for, not because it is a bad idea.
- **The placeholder origin.** `compass.example.com` in three places in
  `index.html`, to be replaced when Phase 7.5 attaches the real domain.
- **`ClaudeWebDesign.md` is untracked but not ignored.** It is one `git add -A`
  from a commit. A line in `.gitignore` would make that durable rather than
  dependent on care.
