// TOTP (RFC 6238) and recovery codes. Hand-written rather than a dependency,
// so totp.test.ts checks it against the RFC's own test vectors.
//
// SHA-1 is required, not a choice: authenticator apps ignore the algorithm
// parameter and assume it, so anything else silently generates wrong codes.
// HMAC does not rely on the collision resistance SHA-1 lost.

import { sha256Hex, timingSafeEqual } from "../crypto.js";

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
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  // No "=" padding: several authenticator apps reject it.
  return out;
}

/**
 * Accepts spaces, hyphens, lower case and padding, since it parses what a
 * person typed. Any other stray character throws rather than being dropped.
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

/** 160 bits, per RFC 4226 §4 R6. */
const SECRET_BYTES = 20;

export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;

/** RFC 6238's T. */
export function timeStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

/** Dynamic truncation is RFC 4226 §5.3 verbatim, including the sign-bit mask. */
export async function totpCode(secretBase32: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secretBase32) as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );

  // Two 32-bit halves: JS bitwise operators truncate to 32 bits.
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

/** Steps accepted either side of now: absorbs clock skew and slow typing. */
const WINDOW = 1;

/**
 * Returns the matched step so the caller can refuse it next time; otherwise a
 * shoulder-surfed code stays valid for its whole window. Every step is checked
 * so timing does not reveal which one matched.
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
 * The issuer appears twice on purpose: older apps read only the label prefix,
 * newer ones only the parameter.
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

export function formatSecretForDisplay(secretBase32: string): string {
  return secretBase32.replace(/(.{4})/g, "$1 ").trim();
}

// ---- Recovery codes ----

export const RECOVERY_CODE_COUNT = 10;
/** 12 base32 characters = 60 bits. */
const RECOVERY_CODE_CHARS = 12;

/** Base32 has no 0, 1 or 8, so fewer characters get misread off paper. */
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
 * Maps 0→O and 8→B, which are unambiguous since base32 has neither digit.
 * `1` is deliberately not mapped: it could be I or L.
 */
export function normalizeRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/0/g, "O")
    .replace(/8/g, "B");
}

/** A fast hash is enough for 60 random bits; there is no dictionary to slow down. */
export function hashRecoveryCode(code: string): Promise<string> {
  return sha256Hex(normalizeRecoveryCode(code));
}
