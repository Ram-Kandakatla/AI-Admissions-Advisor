# Two-factor attempt limit

**Status:** built and merged in [PR #23](https://github.com/Ram-Kandakatla/AI-Admissions-Advisor/pull/23). Written as the plan beforehand; kept as the record of the design.
**Closes:** the security review finding "no per-account limit on 2FA guesses".

Every place Compass checks a second-factor code is rate limited per network and nowhere else. This document is the full set of steps to add a per-account limit: the design and why, every file that changes, the tests that prove it, and how to ship it.

**Files at a glance**

| File | Change |
|---|---|
| `backend/migrations/0011_mfa_attempts.sql` | new table |
| `backend/src/auth/secondFactorLimit.ts` | new: the wait schedule, pure functions |
| `backend/src/store/dataStore.ts` | claim, record-failure and clear methods |
| `backend/src/routes/auth.ts` | `verifySecondFactor()` takes a factor; four routes answer 429 when locked |
| `frontend/src/components/legal/Security.tsx`, `Privacy.tsx` | describe the limit and the stored count |
| `backend/test/twoFactorHelpers.ts` | new: helpers moved out of `twoFactor.test.ts` |
| `backend/test/twoFactorLimit.test.ts` | new: route and unit tests |
| `backend/test/twoFactor.test.ts` | use the shared helpers; deletion test checks the new table |

---

## 1. The gap

Every second-factor check goes through `verifySecondFactor()` in [backend/src/routes/auth.ts](backend/src/routes/auth.ts):

| Route | What gets a caller to the code prompt | Limit today | What a wrong code costs |
|---|---|---|---|
| `POST /api/auth/2fa/verify` | the password (a login challenge) | 15 per 15 min per network, shared `auth` bucket | the challenge; a new one needs only the password again |
| `POST /api/auth/reset` | a reset link, i.e. the inbox | same | nothing: the link stays valid for its hour |
| `POST /api/auth/2fa/disable` | a session and the password | same | nothing |
| `POST /api/auth/2fa/recovery-codes` | a session and the password | same | nothing |

`POST /api/auth/2fa/enable` also checks a code, but against a secret the caller staged a moment ago. There is nothing to guess, so it stays out of this.

A per-network limit stops one machine, not someone with many. A code is accepted across a ±1 step window, so each guess has about a 3-in-a-million chance. Through the reset route, where one request is one guess, a thousand addresses make 60,000 guesses an hour: a coin flip after about four hours. That attacker already needs the inbox (or, on the other routes, the password), but those are exactly the people two-factor exists to stop.

## 2. What the limit has to do

1. Bound guesses per account, whatever network they come from.
2. Never be trippable by a stranger. Each count can only be moved by someone who already holds a first factor.
3. Never let one stolen factor lock the owner out of recovering the account.
4. Leave ordinary typos free.
5. Add no dependencies. D1 only, like the rest of the rate limiting.

## 3. Design

### 3.1 One count per account, per first factor

Two separate budgets, named for the first factor that got the caller to the code prompt:

| Budget | Spent by | Who can spend it |
|---|---|---|
| `password` | `/2fa/verify`, `/2fa/disable`, `/2fa/recovery-codes` | someone who knows the password |
| `reset` | `/reset` | someone who can read the inbox |

**Why two and not one.** With a single budget, a person who has only the password could keep the account locked, and that would include the reset flow the owner needs to change that password. With two, the owner can always recover through the factor the other person does not have, and a right code there clears both (3.4). Only someone holding both the password and the inbox can lock both, and at that point the second factor is the last thing standing, so a lock is the right outcome.

### 3.2 Consecutive wrong codes, with a doubling wait

Count wrong codes since the last right one. The first five are free. After that, each further code has to wait, starting at a minute and doubling, capped at 24 hours:

| Wrong codes so far | Wait before the next code is checked |
|---|---|
| 1–4 | none |
| 5 | 1 minute |
| 6 | 2 minutes |
| 7 | 4 minutes |
| 10 | 32 minutes |
| 12 | about 2 hours |
| 15 | about 17 hours |
| 16 and up | 24 hours |

That allows 15 guesses in the first day and about 380 in a year: roughly a 1-in-900 chance of a correct guess per year, per budget. For comparison, a fixed window of 10 per hour sounds strict and allows 87,600 guesses a year, about a 23% chance.

This is also why the limit gets its own table instead of reusing `rate_limits` and `countHit()`. Fixed windows cannot count *consecutive* failures, a right code cannot reset them, and they cannot stop two guesses being checked at once (3.3).

### 3.3 Claim before checking

Two requests arriving together would both see "not locked" and both be checked. Sign-in cannot be run in parallel, because an account has only one live challenge at a time. The reset and settings routes can be. So each attempt first **claims** the account: a single upsert that succeeds only if the account is not locked, and that pushes the lock 5 seconds ahead while this one code is checked. Any other request in those seconds is refused. The outcome then replaces the lock:

- wrong code: failures + 1, and the lock moves to now plus the wait for the new count;
- right code: the account's rows are deleted (3.4).

If the Worker dies mid-check, the 5-second hold runs out by itself and the attempt is not counted. The cost to a legitimate user is small: a double-submitted form gets a "try again in a few seconds".

### 3.4 A right code clears everything

A correct TOTP or recovery code, on any route, deletes both budgets' rows for the account. So an owner who resets their password through email with a right code unlocks the sign-in budget in the same step, and the reset changes the password, which ends the other person's attempts. Switching two-factor off, or enrolling again, also clears the rows, so an old count never carries over to a new secret.

### 3.5 What stays as it is

- **A reset link survives a wrong code.** The per-account count is what bounds guessing. Burning the link would add a trip to the inbox to every typo without adding a real bound, since anyone holding the inbox can ask for another link.
- **A login challenge is still spent on every attempt**, right or wrong.
- **The per-network `auth` limiter stays** as a cheap first line.
- **An empty code, or an account without two-factor, is not an attempt.** Nothing was guessed, so nothing is counted.
- **Password guessing on `/login` is not covered.** A per-account password throttle is a separate item (section 6).

---

## 4. Steps

### Step 1: Migration

`backend/migrations/0011_mfa_attempts.sql`. Open it with a comment block on the why (per account, two factors, the claim), as the other migrations do.

```sql
CREATE TABLE IF NOT EXISTS mfa_attempts (
  -- CASCADE, so deleting the account takes its counts with it.
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'password' or 'reset': the first factor that reached the code prompt.
  factor       TEXT    NOT NULL,
  -- Wrong codes since the last right one.
  failures     INTEGER NOT NULL DEFAULT 0,
  -- ISO-8601 UTC. No code is checked for this account and factor before it.
  locked_until TEXT    NOT NULL,
  PRIMARY KEY (user_id, factor)
);
```

No other index is needed. Every read is by `(user_id, factor)`, and the clear is by `user_id`, the primary key's leading column.

### Step 2: The wait schedule

New `backend/src/auth/secondFactorLimit.ts`. Pure functions with no I/O, like `totp.ts`, so they can be unit tested directly.

```ts
export type FirstFactor = "password" | "reset";

/** Wrong codes allowed before any wait: enough for typos. */
export const FREE_FAILURES = 5;
const FIRST_WAIT_MS = 60_000;
const LONGEST_WAIT_MS = 24 * 60 * 60_000;

/** How long a claim holds the account while one code is checked. */
export const CLAIM_HOLD_MS = 5_000;

/** The wait after `failures` consecutive wrong codes. */
export function waitAfter(failures: number): number {
  if (failures < FREE_FAILURES) return 0;
  return Math.min(FIRST_WAIT_MS * 2 ** (failures - FREE_FAILURES), LONGEST_WAIT_MS);
}

/** "a few seconds", "12 minutes", "an hour", for the refusal message. */
export function describeWait(ms: number): string {
  if (ms <= 10_000) return "a few seconds";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return minutes === 1 ? "a minute" : `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}
```

### Step 3: Store methods

In [backend/src/store/dataStore.ts](backend/src/store/dataStore.ts), next to the other two-factor statements:

```ts
// Succeeds only if the account is not locked, and pushes the lock ahead while
// one code is checked. A locked account updates nothing, so RETURNING is empty.
const claimAttemptRow = db.prepare(`
  INSERT INTO mfa_attempts (user_id, factor, failures, locked_until)
  VALUES (?, ?, 0, ?)
  ON CONFLICT (user_id, factor) DO UPDATE SET locked_until = excluded.locked_until
  WHERE mfa_attempts.locked_until <= ?
  RETURNING failures
`);
const selectAttemptLock = db.prepare(
  "SELECT locked_until FROM mfa_attempts WHERE user_id = ? AND factor = ?"
);
const recordAttemptFailureRow = db.prepare(
  "UPDATE mfa_attempts SET failures = failures + 1, locked_until = ? WHERE user_id = ? AND factor = ?"
);
const clearAttemptRows = db.prepare("DELETE FROM mfa_attempts WHERE user_id = ?");
```

```ts
async function claimSecondFactorAttempt(
  userId: number,
  factor: FirstFactor,
  holdMs: number
): Promise<{ claimed: true; failures: number } | { claimed: false; retryAfterMs: number }> {
  const now = Date.now();
  const row = await claimAttemptRow
    .bind(userId, factor, new Date(now + holdMs).toISOString(), new Date(now).toISOString())
    .first<{ failures: number }>();
  if (row) return { claimed: true, failures: row.failures };

  const lock = await selectAttemptLock.bind(userId, factor).first<{ locked_until: string }>();
  const until = lock ? Date.parse(lock.locked_until) : now;
  return { claimed: false, retryAfterMs: Math.max(0, until - now) };
}

async function recordSecondFactorFailure(
  userId: number,
  factor: FirstFactor,
  waitMs: number
): Promise<void> {
  const lockedUntil = new Date(Date.now() + waitMs).toISOString();
  await recordAttemptFailureRow.bind(lockedUntil, userId, factor).run();
}

async function clearSecondFactorAttempts(userId: number): Promise<void> {
  await clearAttemptRows.bind(userId).run();
}
```

Also:

- add `clearAttemptRows.bind(userId)` to the `db.batch` in both `enableTotp` and `disableTotp`;
- export the three new methods from the object `createStore` returns;
- `import type { FirstFactor }` from `../auth/secondFactorLimit.js`.

The claim's wait is computed in JavaScript from `claim.failures + 1`. That is safe because the claim has already serialised attempts on this account and factor.

### Step 4: `verifySecondFactor()` takes the factor

In [backend/src/routes/auth.ts](backend/src/routes/auth.ts), move the current TOTP-then-recovery-code logic, unchanged, into a private `checkCode()`, and put the claim around it:

```ts
async function verifySecondFactor(
  c: Context<AppEnv>,
  userId: number,
  code: string,
  factor: FirstFactor
): Promise<{ ok: boolean; usedRecoveryCode: boolean; remaining?: number; retryAfterMs?: number }> {
  const store = c.get("store");
  const typed = code.trim();
  if (!typed) return { ok: false, usedRecoveryCode: false };

  const state = await store.getTotpState(userId);
  if (!state?.secret) return { ok: false, usedRecoveryCode: false };

  // Claimed before anything is checked or consumed: a locked attempt must not
  // test a TOTP code, and must not spend a recovery code.
  const claim = await store.claimSecondFactorAttempt(userId, factor, CLAIM_HOLD_MS);
  if (!claim.claimed) {
    return { ok: false, usedRecoveryCode: false, retryAfterMs: claim.retryAfterMs };
  }

  const result = await checkCode(c, userId, state.secret, typed);
  if (result.ok) await store.clearSecondFactorAttempts(userId);
  else await store.recordSecondFactorFailure(userId, factor, waitAfter(claim.failures + 1));
  return result;
}
```

And one response for every route that is refused:

```ts
function tooManyCodes(
  c: Context<AppEnv>,
  retryAfterMs: number,
  factor: FirstFactor,
  extra: Record<string, unknown> = {}
) {
  c.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  // Only ever shown to someone past the first factor, so it tells an attacker
  // nothing they do not already know.
  const hint =
    factor === "password"
      ? " If these weren't your attempts, someone may know your password — reset it from the sign-in page."
      : "";
  return c.json(
    {
      error: `Too many incorrect codes. For this account's protection, try again in ${describeWait(retryAfterMs)}.${hint}`,
      ...extra,
    },
    429
  );
}
```

Making `factor` a required parameter means TypeScript flags any call site that is missed.

### Step 5: Wire the four routes

At each call site, check for the lock before the existing wrong-code branch:

| Route | Factor | When locked |
|---|---|---|
| `/2fa/verify` | `"password"` | `tooManyCodes(c, ms, "password")`. The challenge is already spent, as today, so the person signs in again after the wait. |
| `/reset` | `"reset"` | `tooManyCodes(c, ms, "reset", { mfaRequired: true })`, so the page stays on the code step. The link is not spent. The "no code yet" answer (`mfaRequired: true`) stays *before* the claim, so asking for the prompt is never counted. |
| `/2fa/disable` | `"password"` | `tooManyCodes(c, ms, "password")` |
| `/2fa/recovery-codes` | `"password"` | `tooManyCodes(c, ms, "password")` |

```ts
const result = await verifySecondFactor(c, found.userId, code, "password");
if (result.retryAfterMs !== undefined) return tooManyCodes(c, result.retryAfterMs, "password");
if (!result.ok) {
  return c.json({ error: "That code isn't right. Please sign in again to get a new attempt." }, 401);
}
```

### Step 6: Frontend

No API shapes change. `request()` in `frontend/src/api.ts` already turns the `error` of any non-2xx response into the thrown message, so the lock message appears without code changes:

- the sign-in code step (`Account.tsx`: `submitCode` returns to the password step and shows it);
- `ResetPassword.tsx`, which stays on the code step;
- `TwoFactorPanel.tsx`.

Optional polish: `ResetPassword.tsx` adds "Ask for a new link" to every error, and after a lock a new link does not help, because the count belongs to the account. Hiding it needs the status: have `request()` throw an `ApiError` carrying `status`, and skip the link on 429.

### Step 7: Trust pages

`frontend/src/components/legal/Security.tsx`, extending the two-factor bullet:

> After five wrong codes, each further code has to wait — a minute, then two, doubling up to a day — counted per account, so switching networks buys nothing. Signing in and resetting a password keep separate counts, so someone who learns your password cannot also lock you out of recovering the account.

In the same file, add to the rate-limits bullet: "Two-factor codes are also limited per account, as above."

`frontend/src/components/legal/Privacy.tsx`, in the retention list:

> **Counts of wrong two-factor codes** — kept until a right code is entered, two-factor is switched off or set up again, or the account is deleted.

### Step 8: Tests

Move `secretFor`, `codeFor` and `enrolled` out of `backend/test/twoFactor.test.ts` into `backend/test/twoFactorHelpers.ts`, so the new file can share them. Then add `backend/test/twoFactorLimit.test.ts` with three small helpers:

- `fromNetwork(n)` returns `{ "CF-Connecting-IP": "198.51.100." + n }`, sent with every attempt. Each guess comes from a different address, which is the attack itself, and it shows the per-network limit is not what stops it.
- `unlock(userId, factor)` runs `UPDATE mfa_attempts SET locked_until = '2000-01-01T00:00:00.000Z' WHERE user_id = ? AND factor = ?`, skipping a wait without faking the clock.
- `countFor(userId, factor)` reads the row's `failures` and `locked_until`.

Route tests:

| Test | Key assertions |
|---|---|
| Five wrong codes are free; the sixth attempt waits, even with the right code | 5 sign-ins with a wrong code each give 401; the sixth, with the right code, gives 429 with `Retry-After`, and no session is issued |
| The wait doubles | after failures 5, 6 and 7, `locked_until` is about now + 1, 2 and 4 minutes |
| A lock does not spend a recovery code | locked + a valid recovery code gives 429; `GET /api/auth/2fa` still reports 10 remaining |
| A right code clears the count | 4 wrong, then 1 right: the row is gone, and the next wrong code counts as 1 |
| The sign-in budget cannot block recovery | lock `password`; `/reset` with the right code gives 200, and the `password` row is gone |
| The reset budget cannot block sign-in | lock `reset` (the link is still valid); signing in with the right code gives 200 |
| Settings routes spend the sign-in budget | wrong codes on `/2fa/disable` are counted on the `password` row |
| Asking is not guessing | `/reset` with no code gives `mfaRequired` and writes no row; an empty code writes no row |
| The wait ends | after `unlock()`, the right code gives 200 |
| Deleting the account removes the counts | extend the deletion test in `twoFactor.test.ts` to check `mfa_attempts` |

Unit tests for `secondFactorLimit.ts`: `waitAfter(0)` to `waitAfter(4)` are 0; `waitAfter(5)` is 60 seconds and each step doubles; `waitAfter(16)` and `waitAfter(1000)` are 24 hours; `describeWait` wording at 10 seconds, 1 minute, 59 minutes and 1 hour.

Existing tests should pass unchanged: no test in `twoFactor.test.ts` makes more than one wrong code on the same account.

Two guesses arriving at the same instant are hard to test deterministically in the Workers pool. The claim's SQL covers that case, and the first check in step 9 makes sure it cannot be removed unnoticed.

### Step 9: Prove the tests catch regressions

As with the last two changes: break each protection in a scratch copy, confirm the matching tests fail, then restore the file and check its checksum.

1. Remove the upsert's `WHERE`, so every claim succeeds. "The sixth attempt waits" and "A lock does not spend a recovery code" must fail.
2. Skip `clearSecondFactorAttempts` on success. "A right code clears the count" and "The sign-in budget cannot block recovery" must fail.
3. Pass the same factor from every route. The two separate-budget tests must fail.

### Step 10: Check and ship

1. `npm run typecheck` and `npm test` for both halves, `npm run build --prefix frontend`, and `backend/node_modules/.bin/wrangler pages functions build --outfile=/tmp/functions.js`.
2. `npm run db:migrate` to apply the migration locally.
3. Open a PR.
4. **Before deploying**, apply the migration to both remote databases with `npm run db:migrate:remote` and `npm run db:migrate:preview`. Without the table every second-factor check throws, which means nobody with two-factor on can sign in.

---

## 5. Decisions to confirm before building

1. **Free wrong codes: 5.** Fewer is harder on typos; more gives an attacker more guesses before the first wait.
2. **Longest wait: 24 hours.** NIST SP 800-63B caps consecutive failed attempts on one account at 100. With a 24-hour cap, continuous guessing passes 100 after about three months; a 7-day cap keeps a whole year under 70 guesses. A longer cap mostly costs an owner whose password someone else knows, and they can clear it by resetting through email.
3. **The sign-in lock message suggests resetting the password.** It is only shown to someone past the password, so it reveals nothing new to an attacker.

## 6. Out of scope

- A per-account throttle on password guessing at `/login`, the other half of the review's sign-in finding.
- Emailing the owner when a lock starts. Useful, but it is a message anyone holding the password could trigger, so it needs its own cap.
- Showing recent wrong-code attempts on the account page.
