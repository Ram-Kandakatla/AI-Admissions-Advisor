# Phase 6 — Product roadmap

Phase 6 is the one phase of the guide that is not a checklist. It is seven
feature ideas, "roughly prioritized", to pick off as time allows. Four were
built. One is blocked on a purchase decision, one on data that does not exist,
and one is not an engineering task at all.

| # | Item | Status |
|---|---|---|
| 6.1 | Deadline reminder emails | **Not built** — blocked on a provider and a domain. Partly delivered by 6.2 |
| 6.2 | Calendar export (.ics) | **Built** |
| 6.3 | Essay brainstorm assistant | **Built** |
| 6.4 | Net price estimator | **Not built** — the aid data does not exist |
| 6.5 | Admissions officer / contact tracker | **Built** |
| 6.6 | Growing the scholarship dataset | **Not built** — curation, not code |
| 6.7 | Parent/counselor view | **Built** |

**465 tests, up from 320.** Backend 165 → 217, frontend 155 → 248. Four
migrations (`0004`–`0007`). Typecheck clean, production build 210 → 211 kB
first load.

---

## §6.2 — Calendar export

One button on the tracker produces an RFC 5545 file that imports into Google
Calendar, Apple Calendar, or Outlook. Every dated application becomes an
all-day event with a reminder a week ahead.

### It is the deliverable half of 6.1

This is worth stating plainly because the guide lists emails first and this
second, and the ordering turns out to be backwards. A `VALARM` fires from the
student's own calendar, on the device they already check, with no sending
domain, no provider, no email verification, no unsubscribe handling, and no
list of addresses to hold. It is most of what 6.1 was for, and it needs none of
what 6.1 is blocked on.

What it is *not* is live. An exported file is a snapshot: change a deadline and
the calendar still holds the old one until you export again. Stable `UID`s
soften that — a re-import updates the existing entry rather than leaving two of
every school — but the real fix is a `webcal://` subscription feed, which needs
a public URL and a per-student token. **That token machinery now exists**, built
for §6.7. A subscription feed is a small addition on top of it once Phase 7 has
a domain.

### Four rules of the format, all load-bearing

`calendar.ts` is 250 lines and most of them exist because iCalendar has sharp
edges:

- **`DTEND` is exclusive for an all-day event.** A deadline on Nov 1 is
  `DTSTART:20261101` / `DTEND:20261102`. Writing the same date twice makes a
  zero-length event, which some clients render as a sliver and others drop.
- **`TEXT` values escape `\`, `;`, `,` and newline** — backslash first, or the
  escapes added afterwards get escaped in turn. "University of California,
  Berkeley" is in the dataset and splits at the comma without this.
- **Folding is at 75 *octets*, not characters**, and a fold must not land
  inside a multi-byte character. The exported file was checked: 94 lines, max
  75 octets, zero replacement characters.
- **CRLF throughout, including a trailing one.**

### Three decisions the guide does not cover

**`deadlineIsTypical` maps onto `STATUS:TENTATIVE`.** An unconfirmed date is a
tentative event in the most literal sense the format has, so clients that
render `TENTATIVE` differently show the caveat without the reader having to
read anything. The caveat is in the description too, and it matters *more* in
an exported file than on the page it came from: the calendar entry outlives the
session, and nothing around it repeats the warning.

**A settled application keeps its event and loses its alarm.** Reminding
someone about a deadline they already met is the fastest way to teach them to
ignore every other reminder in the file.

**Rolling applications get no event, and are named in `X-WR-CALDESC`.** There
is no day to put them on, and picking one would be exactly the invention the
`deadlineIsTypical` flag exists to prevent — so the file says what it left out
instead of quietly being short.

---

## §6.3 — Essay brainstorm assistant

A second mode on `/chat`, switchable in place, carried in the URL as
`?mode=essay`. Same provider abstraction, same rate limiter, same ownership
checks, same offline fallback pattern.

### A second prompt is worthless without a second thread

The guide describes this as "a second chatbot mode reusing `llmService.js`'s
existing provider abstraction", which undersells one thing: the `messages`
table had no notion of a mode, so both assistants would have appended to one
history. Every essay question would have arrived at the model wrapped in
whatever the student last asked about the FAFSA — context that actively
degrades the answer — and the transcript would read as one confused
conversation.

`0004_chat_modes.sql` adds `mode TEXT NOT NULL DEFAULT 'advising'`, which is
its own backfill, and swaps the index to `(student_id, mode, seq)`. The 40-turn
cap is now per mode: a long essay session must not evict the advising thread.

### The essay prompt is mostly restraint

A model asked to help with a college essay will write one unless told not to,
and a personal statement in the model's voice is worse than no help at all — it
reads as generic to the exact reader it was meant to persuade, and it has the
student's name on it. The prompt is built around asking questions instead, and
the offline bank holds the same line, so both modes behave the same way with
and without an API key.

**Untested where it matters most.** The suite runs in fallback mode with no
key, so "refuses to ghostwrite" is verified against the *offline bank*, not
against Claude. The system prompt's restraint is unverified until someone runs
it with a real key. Worth a manual pass before this is public.

### Two bugs the tests caught

**A starter chip nobody could answer.** "How should I end it?" is one of the
six suggestions the UI offers, and the bank's key was `"how to end"` — so it
fell through to "I didn't understand that". Offering a question and then failing
to answer it is the worst thing a keyword bank can do. There is now a test
asserting every chip the UI offers hits the bank, with the six chip strings
copied verbatim. (`"end"` alone is unusable as a key: it is inside *recommend*,
*friend*, *attend*, and *weekend*, all of which appear in real essay questions.)

**Switching modes wiped both threads for a guest.** The history effect keyed on
`[student, mode]` and cleared when there was no profile, so every switch
deleted the conversation the student had just switched away from — for exactly
the visitors with nowhere else to keep it. Split into a clear-on-identity
effect and a load effect.

### An endpoint that had been dead since Phase 1

`GET /students/:id/chat` existed and nothing called it, which left a real
oddity: the server feeds prior turns to the model as context, so after a
refresh the assistant remembered a conversation the student could no longer
see. Harmless with one hidden thread; actively confusing once a visible switch
implies two. The frontend now restores history per mode.

---

## §6.5 — Admissions officer contact

Two text fields and a date on the existing per-school note: who handles this
school, what their job is, and when you last spoke.

### Columns on `school_notes`, and what that costs

The guide calls this "a small addition to the existing per-school note, reusing
that infrastructure", and that is what was built. The pair (student, school) is
already the table's primary key and already what five pages edit, so a contact
is another field on the notepad the student has open rather than a second
record to go and find.

The cost, stated plainly: **one contact per school.** A student dealing with
both a regional counselor and a departmental one has to pick. If that turns out
to matter the fix is a `school_contacts` table, and these columns migrate into
it — a cheap migration later, a needless table now.

### The sharp edge: "holds nothing" got wider

`school_notes` deletes a row that holds nothing — no star, no text. That was
sound until a row could also hold the name of the person reading your
application. Left alone, a student who recorded "Dana Ruiz, regional counselor"
and then unstarred the school would have lost the name silently, with nothing
on screen to suggest why.

`saveSchoolNote`'s emptiness check now covers all three contact fields.
`0007`'s comment says so explicitly for whoever adds the fourth.

### No email, no phone — a deliberate limit

A college counselor did not consent to being in this database. A name and a job
title are what the student needs to remember and are already public on the
school's own site; an email address and a phone number are personal contact
details for a third party, held in someone else's account. They are out.

The date is in, and it is what makes this a tracker rather than an address
book: past 30 days the card says "Last contact was September 2026", past 90 it
escalates to "No contact since May 2026 — over three months", in the same two
colours the tracker uses for a deadline approaching and passed. Under 30 days
it says nothing at all — a nudge the day after you emailed someone is a nudge
people learn to ignore. A future date says nothing either; that is a typo, not
a contact.

### A latent bug the second field exposed

`useSchoolNotes` kept one debounce timer per school. Type a note, then a
contact name within 700 ms, and the second edit replaced the first's timer: the
note stayed on screen, because the optimistic update had already landed, and
never reached the server. Unreachable while the note was the only debounced
field; reachable the moment there were two. The timer now accumulates a merged
patch.

---

## §6.7 — Parent/counselor view

One revocable read-only link per student. No account on the other end, no
sign-in, nothing to install.

### The URL is the credential, and everything follows from that

A counselor with sixty students will not make an account for each one, and a
parent should not have to. That is the point of the feature and the source of
every constraint on it. The token is a v4 UUID from `crypto.randomUUID()` —
122 bits from the platform CSPRNG, the same source session ids come from.
Guessing one is not a threat model. Being *forwarded* one is, which is why the
whole design rests on revocation rather than on secrecy holding forever.

**Revoking is a `DELETE`, not a `revoked_at` flag.** A flag would let the
server distinguish "revoked" from "never existed" — and it must never act on
that difference, because answering the two differently confirms that a link was
once real. Two states the code is forbidden to tell apart are better as one
state. Both are an identical 404, asserted by a test comparing the response
bodies.

**No expiry.** An expiry a student sets in September and forgets is a dead link
to their counselor in December, precisely when decisions land and someone is
trying to help. Revocation is the control that stays true.

### Four rules on the handler, and the one I broke

`GET /shared/:token` is the only unauthenticated read path into student data in
the API. Its rules:

1. **The payload is enumerated, never spread.** `...student` would ship every
   column the profile ever grows, so the next migration would silently widen
   what a forwarded link exposes.
2. **No chat, ever, and no toggle to add it.** A student asking whether their
   family can afford a school, or working through an essay about something
   hard, did not write it for an audience.
3. **No email, no user id, no session.**
4. **404 for unknown and revoked alike.**

I then broke rule 1 one function later, by reusing `decorate()` for
applications. `ApplicationRecord` carries `studentId` and `decorate` spreads, so
every shared plan shipped the key every owner-gated route is addressed by.
Knowing the id opens nothing without a session — the tests prove the routes
still 401 — but a read-only view has no business handing it out. Caught by a
test asserting against the raw response *text*, which is the only way a leak in
a nested field cannot hide.

`financialNeed` is also withheld. "How much help does this family need paying
for college" is the most sensitive field in the profile, it is not needed to
read a plan, and a link forwarded one hop past its intended reader should not
carry it.

### The shared page renders outside the app

`/shared/:token` sits outside the `Layout` route. The person opening it has no
account, so the app's nav would offer them fourteen destinations they cannot
use and a "Sign in" implying the plan is theirs.

It also does not reuse `Recommendations` / `ApplicationTracker` / `SavedSchools`.
Those take a `NotesStore` and render controls throughout; adapting them with an
`interactive={false}` prop would mean every future edit to those pages has to
remember which half of itself is public. A separate, simpler component cannot
grow a control by accident — and there are tests asserting the page renders
zero buttons, zero checkboxes and zero textboxes.

The checklist renders as "2 of 7 to-dos done" rather than as tickable boxes,
because a counselor ticking a student's box would be editing their plan.

### `rel="noreferrer"`, not just `noopener`

The token is in this page's URL. Without it, the `Referer` header hands the
entire share link to every scholarship sponsor a reader clicks through to.
Verified live: 18 outbound links, all carrying it.

### What the share screen says before you press anything

A student cannot consent to sharing something nobody told them they were
sharing, so the page lists what a reader will see and what stays private, in
full, below the button and never behind a disclosure widget. It says outright
that the link works like a password, "including anyone it gets forwarded to".
That copy is the actual safety feature; a confirmation dialog after the fact
would be theatre.

Replacing a link asks for confirmation because it breaks a URL that may already
be in someone's inbox. Revoking does not, because "off" is the safe direction.

---

## What was consolidated

The list of settled statuses — `["submitted", "accepted", "waitlisted",
"denied", "withdrawn"]` — existed twice before this phase, as `CLOSED` in the
tracker and `SETTLED` in the timeline. The calendar export needed it and the
shared view needed it, which would have made four copies of one rule under two
names: one edit away from an application that is settled on three pages and
still counting down on the fourth, a bug nobody reports because each page looks
self-consistent on its own.

It is now `applicationStatus.ts`, one file, one `isSettled()`.

---

## Accessibility

axe-core over every new and changed page, both themes, mobile and desktop.
Three real violations, all found and fixed:

- **`scrollable-region-focusable` on the chat thread.** A keyboard user could
  not scroll it — the messages are text, so there was nothing inside to tab to.
  The Phase 5 audit could not see this: an empty thread does not overflow, so
  there was nothing to scroll on a freshly loaded page.
- **No `<main>` landmark on `/shared/:token`**, and `<dt>`/`<dd>` with no
  `<dl>` parent. Both from the page bypassing `Layout`, which normally provides
  the landmark.
- **`.note-status` at 2.60:1 dark / 2.22:1 light.** Pre-existing, and the
  *fourth* instance of the mistake PHASE-5.md catalogued: `--txf`, the faint
  token meant for marks and dividers, used for prose. That audit could not see
  it either — the line is empty except for about a second after a save, so axe
  had no text to measure. It is also the only confirmation a sighted user gets
  that their typing was kept. `--txm` gives 7.55:1 and 7.19:1.

### A note for anyone re-running that audit

**axe reports phantom contrast failures when sampled mid-theme-transition.**
Toggling the theme and running axe a second later produced eleven violations
pairing dark-theme foregrounds with light-theme backgrounds — `.chat-bar`
reported near-white text on a near-white ground. The nav's background
transitions slowly enough that `.brand-name` fails for several seconds after a
toggle. Reload into a theme rather than toggling into one, or wait out the
transition; both give zero.

---

## Tests

**465 total**, up from 320.

| Suite | Added | Covering |
|---|---|---|
| `calendar.test.ts` | 32 | RFC 5545 output, DTEND rollover incl. leap day, folding at octets, escaping, alarms, rolling exclusion |
| `chatModes.test.ts` | 18 | Mode parsing, thread separation, per-mode trim, ownership, the essay bank |
| `shareLinks.test.ts` | 19 | Create/rotate/revoke, owner-only management, and what a shared link must never expose |
| `ChatBot.test.tsx` | 14 | The switch, per-mode threads, a slow answer landing after a switch |
| `ShareSettings.test.tsx` | 12 | Create/copy/rotate/revoke, and the disclosure copy |
| `SharedPlanView.test.tsx` | 13 | Rendering, and that the page has zero controls |
| Existing suites | +37 | Contact fields, last-contacted, the export bar, per-mode titles |

The load-bearing ones are the negative assertions in `shareLinks.test.ts`. They
check the raw response text for the student id, the session cookie, the email
address and both chat threads, plus an exact-key check on the `student` object
so that a future `...student` spread fails the build rather than shipping.

### Two test-environment notes

`Element.prototype.scrollTo` joined `matchMedia` in `test/setup.ts`. jsdom
implements neither, because both are layout questions and jsdom has no layout.
The chat panel pins itself to the newest message on every render, so without
the shim every `ChatBot` test died in an effect before its first assertion. A
no-op rather than a spy: what those tests assert is which messages are in the
thread, never how far it scrolled.

`userEvent.setup()` installs its own `navigator.clipboard`, so a mock defined
before it is silently replaced and never called. The share-link copy tests
define theirs *after* setup.

---

## Left for later

### 6.1 — Deadline reminder emails

Not built, and not for want of time. What it needs, in order:

1. **An email provider.** MailChannels' free Workers integration was retired,
   and Cloudflare's own `send_email` binding only sends to addresses verified
   in your own account — not to arbitrary students. So it is Resend, Postmark,
   SendGrid, or SES: an account, an API key, and money.
2. **A verified sending domain**, which arrives with §7.5. Sending from an
   unauthenticated domain lands in spam, which is worse than not sending.
3. **Email verification.** Signup takes an address on trust today — see the
   comment in `routes/auth.ts` about the only real proof being to send to it.
   Mailing an unverified address is a deliverability and abuse problem, so this
   drags double opt-in along with it.
4. **Opt-in and unsubscribe**, and the fact that guests have a NULL email by
   construction, so only members can ever receive one.

The Cloudflare side is the easy part: `[triggers] crons = ["0 13 * * *"]` in
`wrangler.toml` and a `scheduled()` export, testable locally against
`wrangler dev`'s `/__scheduled` endpoint.

**Revisit when Phase 7 attaches the domain** — and revisit the priority too,
because §6.2 already delivers the reminder without any of the above.

### 6.4 — Net price estimator

Not built. `universities.json` carries `tuition` and nothing else financial: no
room and board, no average grant by income bracket, no percent-of-need-met. The
recommendation engine's entire "financial fit" logic is one line —
`AFFORDABLE_CEILING = { high: 35000, medium: 55000, low: Infinity }`.

This is a **data-acquisition task wearing an engineering task's clothes**.
Building it on invented numbers would cut directly against how this app behaves
everywhere else: it refuses to publish a deadline it has not confirmed, labels
every scholarship date as typical rather than announced, and says so in the
CSV export because the spreadsheet outlives the page. A fabricated aid estimate
is the same mistake with more money attached.

The honest version is real per-school figures from IPEDS or the College
Scorecard for the 42 schools in the set, cited per school, plus a prominent
link to each college's own Net Price Calculator. That is curation work first
and engineering second.

### 6.6 — Growing the scholarship dataset

45 entries. The guide says outright that no free scholarship API exists and
that this "stays a curation task on `scholarships.json`, not an engineering
one". Nothing to build.

### Smaller things

- **A flaky test.** `App.test.tsx > /majors > falls back to the default for a
  slug nothing matches` failed once during this phase, then passed alone and
  three times running in the full suite. It is a race in that test, not
  anything Phase 6 introduced, and it will eventually go red in CI.
- **A `webcal://` subscription feed**, per §6.2 above. The token machinery from
  §6.7 is most of it; it needs a public URL.
- **`public/_headers` for the shared page.** `rel="noreferrer"` covers every
  link Compass renders, but the page's own `Referrer-Policy` comes from the
  static host once Pages serves it. Belt and braces for Phase 7.
- **No rate limit in code on `/api/shared/:token`.** A 122-bit token is not
  brute-forceable, and the route is covered by the global WAF rule PHASE-1.md
  leaves for deploy day. Worth confirming that rule is in place before this is
  public.
