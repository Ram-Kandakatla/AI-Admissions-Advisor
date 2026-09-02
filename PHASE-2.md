# Phase 2 — Accounts & authentication

What changed, why, and the one thing deliberately left for deploy day.

The short version: `GET /api/students/:id` used to take whatever id a client
sent. It no longer does. Every route under `/api/students/:id` is behind an
ownership check, and two routes that take a student id *off* that path —
`/api/majors/:major?studentId=` and `POST /api/chat` — are checked by hand for
the same reason.

The product's front door did not change: you can still build a profile and see
matches without an account. What changed is that "no account" no longer means
"no owner".

## The decision that shaped everything else

The implementation guide's §2.6 sketch assumed accounts-only: a session names a
user, the user owns a profile. But this app's homepage promises "Free · No
account · 2 minutes", and a hard signup gate would have made that a lie.

Supporting both kinds of visitor has an obvious schema — a session points at
either a user *or*, for a guest, directly at a student row — and that obvious
schema is a trap. Two ownership paths mean every future check has two ways to
be written and one way to be forgotten, which is precisely the regression the
guide names as the most common in apps like this.

So **a guest gets a real `users` row with `email` and `password_hash` left
NULL.** That single decision is why the rest of this phase is small:

- `students.user_id` is the **only** ownership column, so `requireOwner` has
  one path.
- Signing up is `UPDATE users SET email = ?, password_hash = ? WHERE id = ?
  AND email IS NULL` — the student row never moves, so there is no claim-time
  data migration to get wrong.
- An anonymous row **cannot be logged into**, because `WHERE email = ?` is
  never true for a NULL. That is a property of the data, not a check somebody
  has to remember to write.

The `AND email IS NULL` guard on the claim is what makes it safe: it can only
ever fill in a blank row, never overwrite a real account's credentials.

## Sessions, not JWTs

Unchanged from the guide's reasoning, and worth restating because it is the
whole justification for the extra D1 read per request: a JWT is a claim the
server cannot take back. A session id is a row, so logout is a `DELETE` that
takes effect on the next request. `test/auth.test.ts` asserts this directly by
replaying a logged-out cookie — the test a JWT build would fail.

- `crypto.randomUUID()` for the id (122 bits, native in Workers).
- `httpOnly`, `SameSite=Lax`, `path=/`, 30 days, **not** extended on use — a
  fixed life means a stolen cookie has a definite expiry rather than one the
  thief renews by continuing to use it.
- `secure` is derived from the request scheme rather than hard-coded. Hard-coded
  `true` makes local `wrangler dev` (plain http) silently sessionless;
  hard-coded `false` ships an insecure cookie. Reading `url.protocol` gets both
  right with no environment flag to set wrong.
- Expiry is enforced in the lookup's `WHERE` clause, so there is no code path
  where a stale session is read and then forgotten about.
- The session id is **rotated on both login and signup**. Without that, an
  attacker who gets a victim to browse with a known session id holds an
  authenticated session the moment the victim signs in.

## Passwords: PBKDF2 via Web Crypto

`bcrypt` is a native Node addon and cannot load in a Worker at all — isolates
run JavaScript and WASM, not compiled binaries. `bcryptjs` would work; PBKDF2
won because it is already in the runtime, so there is no dependency to audit.

The stored form carries its own parameters:

```
pbkdf2$SHA-256$100000$<salt hex>$<hash hex>
```

Changing the iteration count later therefore does not strand existing rows —
verification reads the cost the hash was written with, not the cost configured
today.

Two details that are easy to skip and both matter:

- **`fakeVerify()` on an unknown email.** Without it, "no such account" returns
  in microseconds while "wrong password" takes ~50ms, and that gap is a free
  account-enumeration oracle. The identical error message alone would hide
  nothing from anyone holding a stopwatch.
- **Constant-time comparison** of the derived hash, so a mismatch does not leak
  where it first differed.

### Left for deploy day: the free-plan CPU limit

PBKDF2 is deliberately slow — that is the defense. 100,000 iterations costs
roughly 40–60ms of CPU, and **the Cloudflare Workers free plan caps CPU at 10ms
per invocation.** Signup and login (and nothing else) would exceed it there.

On the Workers Paid plan the ceiling is 30s and this is a rounding error. If
Phase 7 lands on the free plan instead, lower `ITERATIONS` in
[`src/auth/password.ts`](backend/src/auth/password.ts) — it is one named
constant, and old hashes keep verifying because the cost travels with them.

## What the gate actually covers

```
app.use("/students/:id", requireOwner);
app.use("/students/:id/*", requireOwner);
```

Registered **above every `/students/:id` route in the file**, because Hono
applies middleware only to routes declared after it. A route added above those
two lines would serve any student's profile to any caller, silently, with the
whole suite still green. That is written in the file too, at the point where it
matters.

`requireStudent` from Phase 1 is gone. An ownership check implies an existence
check, and keeping both would have meant two gates to remember on every new
route instead of one.

### Two routes the guide's sketch does not cover

`requireOwner` keys on `c.req.param("id")`, so it does nothing for a student id
that arrives some other way. Two routes do that, and both return
profile-derived output:

- `GET /api/majors/:major?studentId=` — the student's percentile against each
  school's averages.
- `POST /api/chat` — the profile is handed to the chatbot as context, and the
  conversation history comes back.

Both now call `ownsStudent(c, id)` explicitly. The chat route **refuses** an
unowned id rather than quietly ignoring it: silently dropping the context would
turn a client bug into answers that look personalized and are not.

## Contract change: 404 became 403

An unknown student id used to answer 404. Every `/api/students/:id` route now
answers **403** for any id the caller does not own, existent or not, and **401**
when there is no session at all.

This is deliberate. A 404/403 split tells an unauthenticated caller exactly
which student ids are real, which is a free enumeration oracle. Whether a
profile you cannot see exists is not information this API gives out.

Nine assertions across five suites moved with it; each is commented where it
lives.

## The rate limiter got its follow-up

PHASE-1.md left one open: the `/api/chat` limiter keyed on IP, and Phase 2 was
supposed to re-key it to the account. It now does — but only for signed-in
accounts.

This matters for who actually uses Compass. A high school sits behind one NAT,
so IP-keying gives an entire class 30 questions between them. A signed-in
account is now budgeted as itself. Guests still share the IP budget, because a
guest can mint a fresh session by clearing a cookie — per-session keying would
be no limit at all — and "sign in for your own quota" is the honest incentive
that creates.

Signup and login share a stricter bucket of their own: 15 per 15 minutes,
because a human signing in needs a handful of attempts, not thirty.

## Frontend

- **`credentials: "include"` on every request**, and `credentials: true` on the
  CORS middleware. Safe only because the origin check is an allowlist —
  `credentials: true` with a reflected-any origin lets every site on the
  internet make authenticated calls as a visitor.
- **The app survives a refresh for the first time.** The student id used to
  live only in `App.tsx` state, so reloading discarded a finished profile. The
  session cookie now outlives the tab and `/api/auth/me` restores the profile
  on load. This was not a stated goal of Phase 2; it fell out of it.
- **Editing a profile updates it.** `ProfileForm` always POSTed, which created
  a second student row on every edit and stranded the first — with its notes
  and tracked applications still attached to it. Invisible before, because
  nothing owned rows at all. It now PUTs when a profile exists, and the API
  refuses a second `POST /api/students` from an account that already has one.
- **The guest nudge** is a dismissible banner that appears only once there is
  real work to lose, not a modal and not on page load.
- **No router yet.** The guide (§2.7) suggests introducing one here; it is
  deferred to Phase 5.1 so this phase stays reviewable on its own. Auth is two
  more `View` states.

### What signing in does to an unsaved draft

The account's own profile wins — it is the one deliberately saved. The UI says
so rather than appearing to lose the work silently: a red warning *before*
submitting, and a dismissible notice after. `POST /api/auth/login` returns
`discardedGuestProfile` for exactly this.

The orphaned guest row is left in the database. It belongs to an anonymous
account nothing can reach — no session points at it and it has no email to log
in with — so it is unreachable rather than exposed. Sweeping those is a
housekeeping task, not a security one.

## Tests

143 passing, up from 111. The new suite is [`test/auth.test.ts`](backend/test/auth.test.ts).

The helpers gained **a cookie jar**. `SELF.fetch` is not a browser — it neither
stores nor resends cookies — so without one every request in the suite arrives
anonymous and 401s. `currentCookie()` / `useSession()` let a test act as two
different people, which is what makes a real cross-account authorization test
possible rather than just a signed-out one.

`security.test.ts`'s route enumeration now runs **twice** over every
student-scoped route: once with no session (expect 401) and once signed in as
somebody who owns a *different* profile (expect 403). The second is the one
that matters — a 401 only proves the route wants a session, not that it
compares that session against the id in the path.

## Verified in the browser, not just in tests

Guest builds a profile → save prompt appears → signs up → profile carried over
intact → stars a school → signs out → signs back in → the star is still there.
The session cookie is unreadable from JavaScript (`document.cookie` is empty
while signed in), and fetches without it get 401/403 from the real Worker
through the real Vite proxy.

## Known follow-ups

- **No password reset and no email verification.** Both need an email provider,
  which this app does not have yet — Phase 6.1's deadline reminders bring one,
  and reset belongs with it. Until then a forgotten password is unrecoverable,
  which is worth saying out loud before real students have accounts.
- **Session ids are stored in plaintext.** A leaked database read gives session
  hijack until expiry. Storing a SHA-256 of the token instead is cheap and
  strictly better; it is not done here because the guide specifies the simple
  form and this phase already changes a lot.
- **Anonymous accounts accumulate** — one per visitor who starts a profile.
  Expired sessions are swept opportunistically; the user rows behind abandoned
  guest profiles are not. A periodic delete of guest accounts with no profile
  and no live session would keep it tidy.
- **One profile per account** is a `UNIQUE` index, not a law of nature. If a
  sibling or a counselor ever needs a second list, that index is the thing to
  revisit.
