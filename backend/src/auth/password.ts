// PBKDF2 via crypto.subtle: bcrypt is a native addon and cannot load in a
// Worker, and this needs no dependency.

import { sha256Hex, timingSafeEqual, toHex } from "../crypto.js";

/**
 * Sized to the Workers Free plan's 10ms CPU cap, and well under OWASP's
 * guidance. Raise it on Workers Paid; each hash records its own cost, so no
 * migration is needed. Security.tsx states this number to users.
 */
const ITERATIONS = 25_000;
const KEY_BITS = 256;
const SALT_BYTES = 16;
const PREFIX = "pbkdf2";
const HASH = "SHA-256";

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

/** Returns `pbkdf2$SHA-256$<iterations>$<salt>$<hash>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return [PREFIX, HASH, ITERATIONS, toHex(salt), hash].join("$");
}

/** False, never a throw, for a missing hash: guest rows have none by design. */
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
 * Burns the same CPU as a real check, for an unknown email, so response time
 * does not reveal which addresses have accounts.
 */
export async function fakeVerify(password: string): Promise<false> {
  await derive(password, new Uint8Array(SALT_BYTES), ITERATIONS);
  return false;
}

/**
 * Keeps fakeVerify honest: it burns ITERATIONS, so a hash stored at any other
 * cost makes real and fake checks take different times. Login rehashes on
 * success; dormant accounts keep their old cost, so a sharp raise also needs
 * a sweep.
 */
export function needsRehash(stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [prefix, hashName, iterations] = stored.split("$");
  if (prefix !== PREFIX || hashName !== HASH) return false;
  return Number(iterations) !== ITERATIONS;
}

// ---- Opaque bearer tokens ----
//
// The login MFA challenge ("reset" in the names is historical). 256 random
// bits need a fast hash, not PBKDF2: there is no dictionary to slow down.

const TOKEN_BYTES = 32;

/** base64url: URL-safe without percent-encoding, and shorter than hex. */
export function generateResetToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Unsalted on purpose: the row is looked up by this hash. */
export function hashResetToken(token: string): Promise<string> {
  return sha256Hex(token);
}
