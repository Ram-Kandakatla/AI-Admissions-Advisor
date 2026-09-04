# Phase 4 — Observability

What the API says about itself, who it says it to, and the one thing in §4.2
that was deliberately not built.

The short version: the backend could already tell you when four specific things
broke, and could not tell you that anything had happened. It now writes one
structured line per request, every log line in the codebase shares a single
field vocabulary, and none of them contain a student id.

## What was already done

**§4.3, the D1 health probe, shipped in Phase 1.** `GET /api/health` runs a
`SELECT 1` and answers `degraded` + 503 when it fails, so uptime monitoring can
tell "the Worker is up" apart from "the Worker is up but D1 is unreachable."
Pulling it forward cost one query and it has been covered by
[`api.test.ts`](backend/test/api.test.ts) ever since. Nothing in this phase
touched it.

So Phase 4 is §4.1 (logging), and a decision about §4.2 (Sentry).

## Six call sites, six vocabularies

The starting state was not "no logging." It was six hand-rolled
`console.*(JSON.stringify({…}))` calls, no two of which agreed on what to call
anything:

| Where | Fields |
|---|---|
| `/chat` catch | `level, route, detail` |
| `onError`, HTTPException | `level, method, path, status, detail` |
| `onError`, 500 | `level, method, path, status, detail` |
| rate limiter fail-open | `level, message, bucket, detail` |
| invalid API key | `level, message, problems, hint` |
| LLM API error | `level, message, detail` |

Three names for "what happened" (`message`, `detail`, and the bare `msg`-less
line), two for "where" (`route` vs. `method`+`path`). Every one of them was
reasonable in isolation, which is how this happens — nobody writes an
inconsistent log deliberately, they write six consistent ones a month apart.

The cost of that is not aesthetic. Workers Logs indexes the fields of a JSON log
line, so `msg` and `route` are queryable dimensions. Six vocabularies means six
things to remember when you are querying a log at the exact moment you are least
able to remember them.

[`src/log.ts`](backend/src/log.ts) is now the only file in `src/` that touches
`console`. Every line is `{ level, msg, …context }`, `level` and `msg` are typed
`never` in the context object so a field cannot shadow them, and there is one
`errorFields(err)` that replaces the four hand-written spellings of
`err instanceof Error ? err.message : String(err)`.

### No logging library

pino is the obvious reach and does not fit: its default transport is
sonic-boom, which writes to a file descriptor, and a Worker has no filesystem and
no stdout to point one at. What the platform gives you instead is that
`console.log`/`warn`/`error` are captured automatically — by `wrangler tail`
locally and by Workers Logs once deployed, already enabled via
`[observability]` in `wrangler.toml`. That reduces the entire job of a logger
here to "make the argument to `console` a consistently shaped string," which is
small enough to own outright.

Each level goes to its matching `console` method rather than everything to
`console.log`, because Workers Logs reads the method to set its own level —
that is what makes "errors only" work in the dashboard without parsing our JSON
first.

## One line per request

Before this, a successful request left no trace, and neither did a 403, a 429,
or a 404. The log could answer "what broke" and could not answer "what
happened," which is the question you actually have when a student reports that
something did not work and nothing threw.

[`middleware/requestLog.ts`](backend/src/middleware/requestLog.ts) is registered
**first** in `app.ts`, and that is load-bearing in the same way the
`requireOwner` block is, in the opposite direction: there, a route registered
above the guard is unprotected; here, a middleware registered above the logger is
unobserved. Being outermost is what lets it see and time the 413s `bodyLimit`
returns and the preflights CORS rejects.

```
{"level":"info","msg":"request","method":"GET","route":"/api/students/:id","status":200,"ms":0,"ray":"8f…"}
```

### The route pattern, never the path

This is the decision the rest of the phase is arranged around. `route` is
`/api/students/:id` — never `/api/students/2f1c-…`.

A student id identifies a real teenager, and Cloudflare retains logs. The
pattern carries every bit of the operational signal — which endpoint, how often,
what status, how slow — and none of the identifier. It also groups: "p95 of
`/api/students/:id/recommendations`" is a query you can write against patterns
and cannot write against raw paths.

`routePath(c, -1)` from `hono/route` reads the *last matched* route rather than
the currently executing one, which is what makes it work from the outermost
middleware. It also stays correct when a guard short-circuits — `requireOwner`
answering 403 before the handler runs still reports the route the caller was
reaching for, because the match happened whether or not the handler executed.
Nothing concrete matched means `route: null`; Hono's match includes the `*`
middleware entries, and reporting `/api/*` as though it were a route would turn
every 404 into a phantom endpoint.

**This also fixed a pre-existing leak.** `onError` was logging `c.req.path` —
the raw path — so every 500 and every malformed request on a `/students/:id`
route was already writing a student id into the log. Both branches now log the
pattern.

The one deliberate exception to all of this is `detail` and `stack` on an error,
which are logged verbatim. A redacted stack trace cannot be debugged. That is a
trade made knowingly, and it is the only path by which a bound value could reach
the log.

### 4xx is information, not a warning

The tempting mapping is 4xx → `warn`. It is wrong for this API. A 401 is what a
returning student gets whenever their 30-day session has expired — it is the
mechanism by which the frontend learns to show the signed-out state — and 404s
are mostly bots trying paths. If routine traffic is a warning, a real warning is
one line among thousands. Below 500 is `info`, 500 and up is `error`, and
`status` is its own indexed field for anyone who wants to filter on it.

### Health checks are `debug`

Phase 8 puts uptime monitoring on `/api/health` every few minutes, forever. At
`info` those would eventually be most of the log by volume while saying the same
thing every time, so they drop to `debug` — still available when you want them,
out of the way of the traffic you are actually reading the log for. A *failing*
health check answers 503, which is ≥ 500 and logs as an error regardless.

### `ms` measures I/O, not CPU

Workers freeze `Date.now()` between I/O operations, so a purely computational
request reads `0`. That is the right measure here anyway: every slow request in
this app is slow because of D1 or an LLM call. Locally it reads ~0 across the
board, because local D1 is a file read rather than a network hop.

## `LOG_LEVEL`

A var in `wrangler.toml`, not a secret, precisely so it can be turned up in the
dashboard mid-incident without a redeploy. `debug | info | warn | error |
silent`, defaulting to `info`.

An unrecognised value falls back to `info` rather than throwing or going silent.
Nothing typechecks a toml var, and the failure this guards against is a typo
taking logging away at exactly the moment you reach for it.

The test suite runs at `silent` (set in
[`vitest.config.ts`](backend/vitest.config.ts) alongside the existing
`CORS_ORIGIN` and API-key overrides), because several hundred request lines would
bury the results and turn the CI log into scrollback. The logging tests raise it
per-test and put it back.

## §4.2 Sentry: deliberately not built

The guide's own prose says to skip it — *"Skip this until there are actual
outside users — it's noise before that"* — and that is what happened. It is the
right call for a reason worth writing down rather than just deferring to: error
tracking earns its keep by telling you about failures you would not otherwise
hear about, and right now every user of this app is the person who wrote it.
`wrangler tail` is a strictly better tool for that, in real time, with no DSN and
no vendor.

The trigger to revisit is **the first outside users**, which in practice means
Phase 7 putting this on a public URL. At that point:
[`@sentry/cloudflare`](https://docs.sentry.io/platforms/javascript/guides/cloudflare/)
on the backend (`@sentry/node` will not load in a Worker, same Node-API problem
as everything else in this project), plain `@sentry/react` on the frontend, since
that runs in the browser and not the Worker.

One thing to check when that day comes, which is not obvious: the frontend is
pinned to Vitest 3 / Vite 5 on purpose (see
[PHASE-3.md](PHASE-3.md#why-the-frontend-is-on-vitest-3-while-the-backend-is-on-4)),
so any new frontend dependency needs `npm ci --dry-run --os=linux --cpu=x64`
before it is trusted, or CI breaks on Linux the way it did in Phase 3.

The frontend also still has **no error boundary** — a throw in any component
unmounts the tree to a blank page. That is a real gap, it is not a logging gap,
and it belongs with the Phase 5 frontend work where it can be given a designed
error state rather than a bare `<div>`.

## Tests

**22 new tests, 165 total** (was 143). The ones that matter are not the ones
checking that a log line appears — they are the ones checking what is *not* in
it. A student id, an email, a password, and a session cookie are each asserted
absent from the raw log text, which catches a leak in a nested field or a stack
trace that a field-by-field check would walk straight past.

Asserting against raw strings rather than parsed fields is the whole point: the
next person to add a debug field to a log call will not think of these tests, and
these tests need to think of them.

### Why there are two logging test files

[`loggingD1Down.test.ts`](backend/test/loggingD1Down.test.ts) breaks the database
on purpose — dropping a table is the only honest way to reach the rate limiter's
fail-open path and the ≥ 500 half of the level mapping, neither of which any
amount of well-formed traffic will produce.

The Workers vitest pool rolls back **rows** between tests but **not schema**. A
dropped table stays dropped for the rest of its file, so a destructive test
sitting among ordinary ones would silently poison every test after it. Files,
however, each get their own D1 instance — that is real isolation rather than
isolation by convention, so the destructive tests get a file whose entire premise
is "the database is gone" and no comment anywhere asking future readers to
preserve an ordering.

Repairing the damage instead was considered and rejected: `applyD1Migrations`
skips anything its ledger already records as applied, so restoring one table
means dropping the ledger too and reasoning about which migrations are
idempotent. Cheaper to let the file end.

## One small change outside the logging files

`readJson` in [`http.ts`](backend/src/http.ts) raised its 400 and 413
`HTTPException`s with only a `res` and no `message`, which logged as
`"detail":""` — a field saying nothing. They now carry messages. This changes no
response: the supplied `res` is still exactly what the client receives, and the
message exists only for the log line. Found by looking at real output, which is
the argument for looking at real output.

## Left for later

- **Sentry (§4.2)**, as above. Trigger: the first outside users, i.e. Phase 7.
- **A frontend error boundary.** Belongs with Phase 5, where it can be designed
  rather than bolted on.
- **The global 300/15min rate limit** is still a WAF rule to create at deploy
  time, not code — unchanged from
  [PHASE-1.md](PHASE-1.md#left-for-deploy-day-the-global-rate-limit). Worth
  re-reading now that request logging exists, because the log is how you will
  find out whether the threshold is right.
- **No log sampling.** Every request writes a line. That is correct at this
  app's traffic and would not be at 100× — Workers Logs has a sampling
  configuration for when that day comes, and `LOG_LEVEL` is the cruder lever in
  the meantime.
- **No request id of our own.** `cf-ray` is the join key between a request line
  and an error line from the same request. It is absent under `wrangler dev` and
  in tests, so locally the two are joined by being adjacent — which is fine
  locally and is the reason the error lines carry `method` and `route`
  redundantly rather than relying on the join.
