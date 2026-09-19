# Phase 7 — Hosting on Cloudflare Pages + Workers

> **SUPERSEDED IN PART, 2026-09-18 — the app deploys as a Worker, not a Pages
> project.** Everything below about *what was built and why* still describes the
> codebase accurately, with two exceptions now deleted: `backend/src/pages.ts`
> and `functions/api/[[route]].ts`. The platform question this document answers
> "Pages, deliberately" was reopened by Cloudflare and settled the other way.
>
> What forced it: the dashboard no longer has a Pages creation flow to find, so
> the project was created as a Workers service, and pointing its build at
> `wrangler pages deploy` fails with `Authentication error [code: 10000]` —
> Workers Builds injects credentials scoped to Workers, and a Pages deploy
> cannot authenticate from inside it. This was not a matter of finding the right
> command; the two products have separate CI and separate credentials.
>
> The migration was exactly the one ["The platform question"](#the-platform-question-and-why-the-answer-is-still-pages)
> below predicted, which is the one genuinely useful thing that section did:
> `app.ts` unchanged, `pages.ts` and `functions/` deleted, root `wrangler.toml`
> gains `main` and `[assets]`. Read **§ Runbook step 4** and the root
> `wrangler.toml` for current instructions; prefer either over this document
> wherever they disagree.

This phase splits in a way none of the others did. Everything that can be
written, run and verified on a laptop is **done and committed**; everything
that needs a Cloudflare account is a **runbook** below, because it needs
credentials and a browser sign-in that no amount of code can stand in for.

The short version: the API now mounts as a Pages Function, one origin serves
both halves of the app, preview deployments get their own database, and the
document finally has the security headers the API always had. What is left is
account setup — and two items that turned out to be *blocked* rather than
merely pending, which is the most useful thing in this document.

## The platform question, and why the answer is still Pages

Cloudflare's own docs now open the Pages section with a banner: *"Workers
supports most Pages use cases and offers a broader feature set. It is
Cloudflare's primary platform for building applications. Start new projects
with Workers."* Workers with static assets reaches the same shape this phase
wanted — one project, one origin, D1 bound directly — via `assets` config
rather than a `functions/` directory, and Workers Builds now provides the git
integration with per-PR preview URLs that §7.2 chose Pages for.

Pages was chosen anyway, deliberately. The guide specifies it, the codebase had
been written toward it since Phase 1, and it works. Worth knowing what that
costs: Pages is the platform Cloudflare is steering new projects away from, and
some Worker-only features are not exposed through Pages Functions — Cron
Triggers among them, which is what §6.1's deadline reminder emails would
eventually want. If that day comes, the migration is smaller than it sounds:
`backend/src/app.ts` does not change at all, `backend/src/pages.ts` is deleted,
and the root `wrangler.toml` gains `main` and an `assets` block. The two-entry
-point structure this phase preserved is what keeps that true.

---

## What shipped

### One origin, and an adapter that is not where the guide put it

§7.1's sketch puts the Hono adapter directly in `functions/api/[[route]].ts`:

```ts
import { Hono } from "hono";
import { handle } from "hono/cloudflare-pages";
```

That cannot work in this repo, and the failure mode is nasty because it is
invisible in an editor. Module resolution walks *up* from the importing file,
and there is no `node_modules` anywhere above `functions/` — `hono` is
installed in `backend/node_modules`, because `backend/package.json` is what
declares it. tsc and esbuild both fail identically, which means the first place
this would have surfaced is a red Cloudflare build after a merge.

So the adapter lives in [`backend/src/pages.ts`](backend/src/pages.ts), where
`hono` resolves, and the root file is a bare re-export that imports nothing but
a relative path:

```ts
export { onRequest } from "../../backend/src/pages.js";
```

The alternative — adding `hono` to the root `package.json` — also resolves, and
buys a second copy that can drift from the one the tests and `wrangler dev` run
against. One hono is worth the indirection.

**CI now runs `wrangler pages functions build`** so this class of breakage is
caught on a pull request rather than on a deploy. It is the only step in the
workflow that exercises the deploy path.

### Two wrangler files, which is not a mistake

| File | Read by | Deployed? |
|---|---|---|
| `wrangler.toml` (root) | Cloudflare's build, `wrangler pages dev`, remote migrations | **Yes** |
| `backend/wrangler.toml` | `wrangler dev` on :8787, `backend/vitest.config.ts` | No |

Pages will not read a config from a subdirectory, so the deployed settings have
to exist at the root. The backend copy cannot simply be deleted either: the
test suite reads its bindings from it, deliberately, so that a test cannot pass
under a configuration the deployed app does not have.

The cost is real and worth stating plainly: `compatibility_date`, the
compatibility flags and the `DB` binding exist in both files and must be
changed in both. There is no import mechanism between them. Both files say so
at the top.

`backend/wrangler.toml`'s `database_id` is now `local-only-never-deployed`
rather than a placeholder awaiting a value, because that is what it is —
`wrangler dev` ignores it entirely and uses SQLite under `.wrangler/state`.

### Preview deployments get their own database

§7.4 makes this call for the LLM key: leave it unset on Preview so every PR
preview runs the offline fallback and spends no real money. It does not follow
the same reasoning through to the database, and it should have. A preview
deployment is *unreviewed code*; pointing it at the production D1 puts real
student profiles one bad migration or one stray `DELETE` away from a branch
nobody has read yet.

So the root config declares `[env.preview]` with `compass-db-preview`. Two
things about that block are easy to get wrong:

- **`vars` had to be restated, not inherited.** `vars` and `d1_databases` are
  non-inheritable, and Pages requires an environment overriding any one of them
  to specify all of them. Omitting `[env.preview.vars]` would leave previews
  with *no* `CORS_ORIGIN` at all — not with production's.
- **Preview runs the same migrations.** Preview should differ from production
  in its data, never in its schema; a preview on an older schema fails in ways
  production never would, which is the opposite of a preview's purpose.

### `LOG_LEVEL` is deliberately absent from the config

Fields declared in `wrangler.toml` become **read-only in the Cloudflare
dashboard**. Phase 4 made `LOG_LEVEL` a var rather than a secret for exactly
one stated reason — so it could be turned up mid-incident without a redeploy —
and committing it would have quietly taken that away, putting a log-level
change behind a git push and a rebuild.

There is also nothing to record: `log.ts` already defaults to `info`, so a
committed `LOG_LEVEL = "info"` is a no-op that costs the knob. Set it in the
dashboard when an incident calls for `debug`, and clear it afterwards.

### `_headers`: the document had no frame protection

PHASE-6 left a `Referrer-Policy` for the shared page as a Phase 7 item, and
[`frontend/public/_headers`](frontend/public/_headers) delivers it. Writing the
file surfaced something bigger.

`hono/secure-headers` in `app.ts` hardens `/api/*`. It does nothing for the
HTML document a browser actually renders — Pages does not apply a Function's
headers to static responses, and does not apply `_headers` to a Function's
responses. The two halves of one origin are hardened in two places by
necessity. Until this file existed, **the app itself was frameable**, because
the only `X-Frame-Options` in the project was on JSON nobody frames.

One trap is recorded in the file and repeated here because it is silent:
**Pages appends matching header rules rather than replacing them.** `/shared/*`
is actually served `Referrer-Policy: strict-origin-when-cross-origin,
no-referrer`. That is correct — a browser walks the token list and keeps the
last valid one, which is the mechanism the spec provides for stating a fallback
before a stronger policy — but it depends entirely on rule order. Moving the
`/shared/*` block above `/*` would invert it and leave the share token's page
on the weaker policy, with nothing failing to indicate it.

A real Content-Security-Policy is deferred, not forgotten. The document loads
Google Fonts and runs the inline theme script that prevents the dark-mode
flash, so a policy written carelessly breaks first paint.

**Overtaken later the same day, and left standing anyway.** The legal round
self-hosted both font families into `/fonts`, so the Google Fonts half of that
sentence stopped being true about seventeen hours after this phase merged. The
paragraph is kept as written because this document records what Phase 7 shipped
against, not what is true now — but nothing else here says so, and a reader has
no way to tell a deliberate record from a line nobody revisited. For the current
position: `frontend/public/_headers` now defers the CSP on the inline theme
script alone, which a hash or a nonce covers, and the "Still open, in one place"
list in `IMPLEMENTATION_GUIDE.md` tracks it as live work.

### Remote migrations moved to the root

`backend`'s `db:migrate:remote` could only ever have failed — it resolves
against `backend/wrangler.toml`, whose database id is a placeholder. Remote
migrations are now root scripts, where the real ids live:

```bash
npm run db:migrate:remote    # production
npm run db:migrate:preview   # preview
```

### `_redirects` is redundant, and stays

Verified during this phase: Pages' own HTML handling already serves
`index.html` for a path that matches no asset, so deep links work with the rule
ignored. `wrangler pages dev` *does* ignore it, reporting
`Infinite loop detected in this rule` on every run — a
[known false positive](https://github.com/cloudflare/workers-sdk/issues/11824)
in the local validator, not a real rejection. The file stays: platform defaults
change, and a stated rule costs one line. Both facts are now written into it so
nobody "fixes" a correct file.

One edge that same default has: a request for a missing `/assets/*.js` chunk
also returns `index.html` with a 200, so a tab left open across a deploy
receives HTML where it expects JavaScript. That is precisely the failure the
Phase 5 error boundary's second state was built for.

### Verified locally, before any account existed

`npm run preview` builds the frontend and runs `wrangler pages dev` over the
real deployed shape — one origin, static assets plus the Function, against the
same local D1 the dev loop already migrated. What it confirmed:

- `/api/health` → `{"status":"ok","llm":"fallback","database":"ok"}` — the
  Function reaches D1 through the Pages binding
- `/api/universities` returns real data
- `/matches`, `/majors/nursing`, `/shared/tok123` all serve `index.html`
- `Parsed 2 valid header rules`; `/shared/x` carries `no-referrer`
- 465 tests and three typechecks still green

This is the part §7.7 warns cannot be fully de-risked ahead of deploy day, and
it is now as close as local emulation gets.

---

## The runbook

Everything below needs your Cloudflare account. Commands assume the repo root.
`wrangler` is already a devDependency — there is no `npm install -D wrangler`
step, contrary to §7.2.

### 1. Sign in

```bash
backend/node_modules/.bin/wrangler login
```

Opens a browser for OAuth. Nothing else in this runbook works until it
succeeds.

### 2. Create both databases

```bash
backend/node_modules/.bin/wrangler d1 create compass-db
backend/node_modules/.bin/wrangler d1 create compass-db-preview
```

Each prints a `database_id`. Put them in the root `wrangler.toml`, replacing
`REPLACE-WITH-PRODUCTION-D1-DATABASE-ID` and
`REPLACE-WITH-PREVIEW-D1-DATABASE-ID`. Commit that change — it is not a secret,
and a database id in git is what makes the config reproducible.

Naming follows §7.6: `college-compass-web` for the project, `compass-db` for the
database, `compass-db-preview` beside it so the two sort together in a
dashboard that will eventually hold several projects.

### 3. Apply migrations to both

```bash
npm run db:migrate:remote
npm run db:migrate:preview
```

Run this **before** the first deploy. `wrangler dev` will happily boot against
a database with no tables; so will production, and every route will 500.

### 4. Connect the repo — as a Worker, not a Pages project

**Rewritten 2026-09-18.** There is no Pages option left to pick: Dashboard →
**Workers & Pages → Create** lands on a Workers setup screen, and that is the
flow to use. Repo: `Ram-Kandakatla/AI-Admissions-Advisor` (renamed from
`kandakatla-ram/…`; git redirects, the dashboard picker does not).

| Setting | Value |
|---|---|
| Project name | `college-compass-web` — must match `name` in `wrangler.toml` |
| Production branch | `main` |
| Build command | `npm run build:deploy` |
| Deploy command | `npx wrangler deploy --env=""` |
| Builds for non-production branches | **off** — see below |

**The build command is not §7.2's.** The guide gives
`npm install --prefix frontend && npm run build --prefix frontend`, which
installs frontend dependencies only — and then the bundler cannot resolve
`hono`, `@anthropic-ai/sdk` or `openai`, all of which live in
`backend/node_modules`. `build:deploy` installs both halves. It is a root npm
script rather than a dashboard string so that it is in git and reviewable.

**The `--env=""` is not cosmetic.** The root config defines an `[env.preview]`
environment, and `wrangler deploy` with no `--env` warns that it is guessing.
The empty string says "the top-level environment" explicitly, which is
production. Leaving it off happens to do the right thing today and would stop
doing so the moment someone adds another environment.

**Non-production builds are off deliberately.** Under Pages, `[env.preview]`
was picked up by every preview deployment automatically. Workers does not do
that — a deploy uses the top-level config unless passed `--env preview` — so a
PR preview wired up carelessly comes up bound to **production D1**. Off is the
safe state until that is wired and verified; the root `wrangler.toml` says the
same thing at the `[env.preview]` block.

### 5. Secrets — production only

```bash
backend/node_modules/.bin/wrangler secret put ANTHROPIC_API_KEY --name college-compass-web
```

Note this is `wrangler secret put`, not `wrangler pages secret put` — the Pages
form fails against a Worker for the same reason the Pages deploy did.

With no key set, `llmService` runs its offline keyword fallback, so the app is
fully usable and spends no API money. `/api/health` reports `"llm":"fallback"`
when this is the case, which is how to tell the two apart at a glance.

### 6. Custom domain (§7.5)

If the domain's DNS is already on Cloudflare this is a dashboard toggle with
automatic SSL. If it is elsewhere, add the CNAME the dashboard shows you.

Do this **before** step 7 — see below for why that ordering is forced rather
than preferred. Afterwards, three things need the real hostname:

- `CORS_ORIGIN` in the root `wrangler.toml`
- the three `https://compass.example.com` URLs in `frontend/index.html`
  (canonical, `og:url`, `og:image`). Open Graph requires absolute URLs, which
  is why they could not be filled in earlier.
- `Policy` and `Canonical` in `frontend/public/.well-known/security.txt`,
  which the legal round added after this runbook was written. `Canonical` is
  the one with teeth: RFC 9116 treats it as valid only if the file is
  genuinely served from that exact URL, so a stale value invalidates the file
  rather than merely pointing somewhere wrong. While in there, push `Expires`
  out from the deploy date — it is set just under a year deliberately, because
  a strict validator reads exactly twelve months as out of range, and every
  scanner treats an expired file as stale.

### 7. The global rate limit — read the blocker below first

PHASE-1 left the global 300/15min limit as a WAF rule to create here. It is not
straightforwardly creatable; see
[Blocked, not pending](#blocked-not-pending) before attempting it.

### 8. Smoke test (§7.7)

In one browser: sign up, complete a profile, confirm recommendations render,
send one chat message. The chat step confirms whichever LLM path is live —
a real answer means the key works, a canned one means the fallback does, and
both are passes.

Then open the app on a **second browser or device** and sign in. This is the
step that matters most and it is easy to skip because it feels redundant.
Workers keep no memory between requests by design, so this is what proves the
state genuinely lives in D1 and that nothing quietly depends on something left
in memory during local `wrangler dev` testing.

Watch it live with:

```bash
backend/node_modules/.bin/wrangler tail college-compass-web
```

---

## Blocked, not pending

Two items the guide treats as deploy-day chores are actually gated on decisions
you have not made yet. Both are written here rather than left to be discovered.

### The global rate limit needs a paid plan *and* a custom domain

PHASE-1 specifies two WAF rules: `compass-global` at 300 requests / 15 min per
IP on `/api/*`, and `compass-chat-edge` at 60 / 15 min on `/api/chat`. Neither
is creatable as written on a starting account:

- **WAF rate limiting rules are zone-scoped.** The deployed `workers.dev`
  hostname is not a
  zone in your account, so there is nothing to attach a rule to until §7.5
  attaches a domain you control. The rate limit is therefore blocked on the
  custom domain, which is why step 6 comes before step 7.
- **A 15-minute counting period requires a Business plan.** Free and Pro cap
  the counting period at **1 minute**; only Business and Enterprise offer the
  longer windows. Free also allows **one rule total**, Pro two, Business five.

So on Free with a domain attached, the honest translation of PHASE-1's intent
is a single rule: `/api/*`, **20 requests per 60 seconds per IP**. Same average
rate as 300/15min, considerably burstier — a student opening the app fires
several API calls at once, so watch for false positives before trusting it.

**Until a domain exists, there is no global rate limit at all.** What that does
and does not mean:

- LLM spend is still capped. The `/api/chat` limiter is in code (30/15min, keyed
  per account since Phase 2, per IP for guests) and does not depend on the WAF.
- `/api/shared/:token` has no in-code limit and PHASE-6 explicitly leaned on the
  WAF rule here. A 122-bit token is not brute-forceable, so this is a cost and
  noise concern rather than an access one.
- Everything else is unmetered. On the Workers Free plan the 100,000
  requests/day account cap becomes the de-facto limiter, which is itself a way
  to take the app down.

This is a reasonable state for an app whose users are the person who wrote it.
It should not stay true once the link is shared.

### PBKDF2 at 100k iterations exceeds the free plan's CPU limit

Unchanged from PHASE-2 and still unresolved, because the plan is undecided.
Confirmed current against Cloudflare's limits page: **Workers Free caps CPU at
10 ms per invocation**; Paid defaults to 30 s. PBKDF2 at 100,000 iterations
costs roughly 40–60 ms.

Signup and login — and nothing else — exceed that. On Free they will fail
outright, not degrade.

If the answer is Free, lower `ITERATIONS` in
[`backend/src/auth/password.ts`](backend/src/auth/password.ts). It is one named
constant and existing hashes keep verifying, because the cost travels with them
in the stored format. That is a real reduction in password-cracking cost and
should be a deliberate choice, not a reaction to a 500 during the smoke test.

**Settle this before the first real signup**, in either direction.

---

## Left for later

- **The placeholder origin.** Three `https://compass.example.com` URLs in
  `frontend/index.html`, waiting on §7.5. Sharing a link before then produces a
  broken Open Graph card — the tags are otherwise correct.
- **A Content-Security-Policy** on the document, per `_headers` above.
- **`[env.preview]` has no separate `CORS_ORIGIN` that could ever be right.**
  Each preview is served from its own generated hostname and no static
  allowlist can enumerate those. It does not matter while previews are
  same-origin; it would immediately matter under a split deployment. Moot
  while non-production builds are off.
- **Branch protection** (Phase 3.4) is still blocked on the repository being
  private on a free GitHub plan. Cloudflare's git integration does not care,
  but nothing stops a red CI run from being merged.
- **Sentry** (§4.2) was deferred explicitly until there were outside users. A
  public URL is the trigger that section named.
- **A `webcal://` subscription feed** (PHASE-6) needs the public URL that this
  phase produces. The §6.7 token machinery is most of the work.
- **A `manualChunks` vendor split** (PHASE-5) — ~182 kB of React and Router is
  re-downloaded by returning visitors on every deploy. Four lines, and it
  matters more once deploys are frequent.
- **One flaky test**, `App.test.tsx > /majors > falls back to the default for a
  slug nothing matches`, noted in PHASE-6 and not yet chased down.
