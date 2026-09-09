// TOTP (RFC 6238) and recovery codes, on Web Crypto.
//
// WHY THIS IS HAND-WRITTEN
//
// The project's zero-new-dependencies rule, and in this case the rule costs
// almost nothing: TOTP is a HMAC, a big-endian counter, and a truncation, and
// `crypto.subtle` already does the only hard part. What a library would add is
// mostly QR rendering, which enrollment here deliberately does without.
//
// Everything below is checked against the published test vectors in RFC 6238
// Appendix B — see totp.test.ts. A hand-rolled implementation of a standard is
// only defensible if it is verified against the standard's own numbers, and
// those vectors are the difference between "this passes my tests" and "this
// interoperates with Google Authenticator".
//
// WHY SHA-1
//
// RFC 6238 permits SHA-256 and SHA-512, and every authenticator app in
// practice implements only SHA-1 — Google Authenticator ignores the algorithm
// parameter in the otpauth URI entirely and assumes SHA-1. Choosing anything
// else produces an enrollment that silently generates wrong codes. The
// weakness that matters for SHA-1 is collision resistance, which HMAC does not
// rely on; HMAC-SHA1 has no practical break and is what the standard specifies.

/** RFC 4648 base32, which is what every authenticator app speaks. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // Whatever is left, padded on the right to a full 5-bit group.
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  // No "=" padding: the otpauth URI spec omits it and several apps reject it.
  return out;
}

/**
 * Decode base32, tolerantly.
 *
 * Spaces, hyphens and lower case are all accepted because this parses what a
 * human typed off a screen, and the setup key is *displayed* in hyphenated
 * groups of four precisely so it can be read aloud and copied without losing
 * one's place. Padding is skipped rather than rejected for the same reason.
 * Anything that is still not a base32 character throws — a silently-dropped
 * character would produce a secret that is wrong in a way nobody could debug.
 */
export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** 160 bits, the size RFC 4226 §4 R6 recommends for a shared secret. */
const SECRET_BYTES = 20;

export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/** Seconds per code. 30 is the default every authenticator app assumes. */
export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;

/** The counter value for a moment in time — RFC 6238's T. */
export function timeStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * The code for one counter value.
 *
 * The truncation is RFC 4226 §5.3 verbatim: take the low nibble of the last
 * byte as an offset, read four bytes from there, mask off the sign bit, and
 * take the last `DIGITS` decimal digits. The mask is not decoration — without
 * it the value is interpreted as signed on some platforms and half of all
 * codes come out negative.
 */
export async function totpCode(secretBase32: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secretBase32) as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );

  // The counter as 8 bytes, big-endian. Written through a DataView as two
  // 32-bit halves because a JS bitwise operation truncates to 32 bits, so
  // shifting a counter past 2^31 by hand silently produces the wrong bytes.
  const message = new ArrayBuffer(8);
  const view = new DataView(message);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;

  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

/**
 * How many steps either side of now are accepted.
 *
 * One, which is the usual choice and means a code is valid for somewhere
 * between 30 and 90 seconds depending on where in the window it was read. It
 * absorbs the two things that actually go wrong: a phone clock a few seconds
 * off, and a person who starts typing a code with four seconds left on it.
 * Widening it multiplies the guessing surface for no real usability gain.
 */
const WINDOW = 1;

/**
 * Check a code, and report which step matched.
 *
 * Returning the step rather than a boolean is what makes replay prevention
 * possible: the caller records the step it consumed and refuses anything at or
 * below it next time. Without that, a code shouldersurfed off a screen stays
 * usable for the rest of its window — which is exactly the situation a second
 * factor is supposed to cover.
 *
 * Every candidate step is checked even after one matches. An early return
 * would make the function's running time depend on *which* step was correct,
 * and the whole loop is three HMACs.
 */
export async function verifyTotp(
  secretBase32: string,
  code: string,
  atMs: number = Date.now()
): Promise<{ valid: boolean; step: number }> {
  const typed = code.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(typed)) return { valid: false, step: -1 };

  const now = timeStep(atMs);
  let matched = -1;
  for (let offset = -WINDOW; offset <= WINDOW; offset++) {
    const step = now + offset;
    const expected = await totpCode(secretBase32, step);
    if (timingSafeEqual(expected, typed) && matched === -1) matched = step;
  }
  return { valid: matched !== -1, step: matched };
}

/**
 * Constant-time string comparison.
 *
 * `===` on strings short-circuits at the first differing character, which
 * leaks how many leading digits were right. That is a weak oracle against a
 * six-digit code — an attacker would need an enormous number of samples
 * through a rate limiter that stops them long before — but it costs one loop
 * to remove, and "too small to matter" is how timing leaks end up shipped.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The URI an authenticator app consumes.
 *
 * Also what makes enrollment work without a QR code: on a phone this is a
 * tappable link that opens the authenticator directly, and on a desktop the
 * secret below it is typed in by hand. Both halves are shown, because which
 * one is useful depends on which device is reading the screen.
 *
 * The issuer appears twice — once as a label prefix and once as a parameter —
 * which looks redundant and is not: older apps read only the prefix, newer
 * ones only the parameter, and an app that reads neither files the account
 * under a bare email address with no hint which site it belongs to.
 */
export function otpauthUri(secretBase32: string, account: string, issuer = "Compass"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** The setup key as displayed: groups of four, which is what makes a 32
 *  character string transcribable without losing your place. */
export function formatSecretForDisplay(secretBase32: string): string {
  return secretBase32.replace(/(.{4})/g, "$1 ").trim();
}

// ---- Recovery codes ----

/** How many are issued at once. Ten is the near-universal choice. */
export const RECOVERY_CODE_COUNT = 10;
/** Characters per code, before hyphens. 12 base32 chars is 60 bits, which is
 *  far past guessable through a rate limiter and still short enough to read
 *  off a piece of paper. */
const RECOVERY_CODE_CHARS = 12;

/**
 * A batch of recovery codes.
 *
 * Deliberately drawn from the same base32 alphabet as the secret, which has no
 * 0/O or 1/I/L pairs in it — these get written on paper and read back later by
 * someone who is already locked out and not in the mood to guess whether that
 * was a zero.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_CHARS));
    const raw = [...bytes].map((b) => BASE32_ALPHABET[b % 32]).join("");
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return codes;
}

/**
 * Strip formatting so "abcd-efgh" and "ABCDEFGH" are the same code, and
 * forgive the two digits base32 does not contain.
 *
 * These codes get written on paper and typed back months later by someone who
 * is already locked out. The alphabet has no 0 and no 8, so a round character
 * can only be an O and a double-loop can only be a B — mapping them is
 * unambiguous and saves a failed attempt at the worst possible moment.
 *
 * `1` is deliberately NOT mapped, and that is the interesting case: base32
 * contains both I and L, so a typed 1 has two plausible readings and guessing
 * either would be wrong half the time. Better to fail than to silently pick.
 */
export function normalizeRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/0/g, "O")
    .replace(/8/g, "B");
}

/**
 * The stored form. SHA-256 for the same reason reset tokens use it: 60 bits
 * from a CSPRNG has no dictionary to attack, so the expensive hash that
 * protects a human-chosen password would buy nothing here.
 */
export async function hashRecoveryCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalizeRecoveryCode(code))
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
