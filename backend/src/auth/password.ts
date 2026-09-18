// Password hashing on Web Crypto.
//
// `bcrypt` is a native Node addon: a Worker runs JavaScript and WASM in a
// sandboxed isolate and cannot load compiled binaries at all, so it is not a
// "slower here" choice, it simply does not load. `bcryptjs` (pure JS) would
// work; PBKDF2 via `crypto.subtle` is preferred because it is already in the
// runtime — no dependency to audit, and the derivation itself runs in
// workerd's native BoringSSL rather than in interpreted JS.
//
// COST, AND WHY IT IS A NAMED CONSTANT
//
// PBKDF2 is deliberately slow; that is the entire defense. That cost has to fit
// inside Cloudflare's per-invocation CPU budget, which on the Workers free plan
// is 10ms — and signup and login are the only two routes that come near it. On
// Workers Paid the ceiling is 30s and this is a rounding error. ITERATIONS is a
// single constant so that trade-off is one line to change, and the value is
// recorded *inside every hash* so lowering or raising it later does not
// invalidate the passwords already stored.

/**
 * Lowered from 100,000 to fit the free plan's 10ms cap — a real reduction in
 * cracking cost, chosen deliberately rather than discovered during a 500.
 * OWASP's guidance is far higher than either figure. Raise this on Workers Paid;
 * hashes written at any cost keep verifying, so the change needs no migration.
 */
const ITERATIONS = 25_000;
const KEY_BITS = 256;
const SALT_BYTES = 16;
const PREFIX = "pbkdf2";
const HASH = "SHA-256";

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: HASH },
    key,
    KEY_BITS
  );
  return toHex(bits);
}

/**
 * Hash a password for storage.
 *
 * The returned string carries its own parameters —
 * `pbkdf2$SHA-256$25000$<salt>$<hash>` — so a future change to ITERATIONS
 * does not strand existing rows: verifyPassword reads the cost the hash was
 * written with, not the cost configured today.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return [PREFIX, HASH, ITERATIONS, toHex(salt), hash].join("$");
}

/** Compare two hex strings without leaking where they first differ. */
function timingSafeEqual(a: string, b: string): boolean {
  // Length is not secret — both sides are fixed-width hex of the same
  // derivation — but an early return on a mismatched length would skip the
  // constant-time loop entirely, so bail into a guaranteed-false compare.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Check a password against a stored hash.
 *
 * A malformed or absent hash returns false rather than throwing: an anonymous
 * user row has `password_hash` NULL by design, and a login attempt that
 * somehow reaches one must read as a wrong password, not a 500.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined
): Promise<boolean> {
  if (!stored) return false;
  const [prefix, hashName, iterations, saltHex, expected] = stored.split("$");
  if (prefix !== PREFIX || hashName !== HASH || !saltHex || !expected) return false;
  const rounds = Number(iterations);
  if (!Number.isInteger(rounds) || rounds < 1) return false;

  const actual = await derive(password, fromHex(saltHex), rounds);
  return timingSafeEqual(actual, expected);
}

/**
 * Burn the same CPU a real verification would, then fail.
 *
 * Called when the email does not exist. Without it, "no such user" returns in
 * microseconds while "wrong password" takes ~50ms, and that gap is a free
 * account-enumeration oracle for anyone with a stopwatch — the generic error
 * message the route returns would not hide a thing.
 */
export async function fakeVerify(password: string): Promise<false> {
  await derive(password, new Uint8Array(SALT_BYTES), ITERATIONS);
  return false;
}

// ---- Opaque bearer tokens ----
//
// Used by password reset and, since 2FA, by the short-lived challenge that
// carries "this caller's password was already checked" between the two halves
// of a login. Same primitive, same reasoning; the names say "reset" for
// historical reasons and are left alone rather than churning a merged file.
//
// A different primitive from the password hashing above, for a different job.
// See migrations/0008_password_resets.sql for the full reasoning; the short
// version is that a password is low-entropy and needs an expensive hash to
// survive being stolen, while a reset token is 256 bits of CSPRNG output and
// needs a fast one.

/** Bytes of entropy in a reset token. 32 = 256 bits, far past brute force. */
const TOKEN_BYTES = 32;

/**
 * A new reset token, in the form that goes in the URL.
 *
 * base64url rather than hex: the same entropy in 43 characters instead of 64,
 * and every character is already safe in a query string, so nothing has to be
 * percent-encoded on the way into an email client that may or may not get the
 * escaping right.
 */
export function generateResetToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  // btoa needs a binary string; spreading a 32-byte array is cheap.
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The value actually stored, so the table holds nothing usable.
 *
 * Deterministic and unsalted on purpose. A salt would make the row
 * unfindable — the lookup is "given this token, which row is it" — and buys
 * nothing here: salts defend against precomputation across a *guessable* input
 * space, and there is no rainbow table for 256 random bits.
 */
export async function hashResetToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
