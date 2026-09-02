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
// PBKDF2 is deliberately slow; that is the entire defense. 100k iterations of
// HMAC-SHA-256 costs roughly 40-60ms of CPU per call. That matters on
// Cloudflare specifically: the Workers free plan caps CPU at 10ms per
// invocation, so signup and login — and only those two routes — would exceed
// it. On the Workers Paid plan the ceiling is 30s and this is a rounding
// error. ITERATIONS is a single constant so that trade-off is one line to
// change, and the value is recorded *inside every hash* so lowering or raising
// it later does not invalidate the passwords already stored.

/** OWASP's floor for PBKDF2-HMAC-SHA256 at the time of writing. */
const ITERATIONS = 100_000;
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
 * `pbkdf2$SHA-256$100000$<salt>$<hash>` — so a future change to ITERATIONS
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
