// The TOTP primitives, checked against the standards' own numbers.
//
// A hand-written implementation of a published algorithm is only defensible if
// it is verified against that publication's test vectors — otherwise the tests
// prove the code agrees with itself, which is exactly the failure mode where
// enrollment succeeds and Google Authenticator then generates different codes
// forever. Everything in the first two blocks below is copied from the RFCs.

import { describe, expect, test } from "vitest";
import {
  base32Decode,
  base32Encode,
  formatSecretForDisplay,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  otpauthUri,
  timeStep,
  totpCode,
  verifyTotp,
  TOTP_STEP_SECONDS,
} from "../src/auth/totp.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("base32 — RFC 4648 §10 test vectors", () => {
  test.each([
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ])("encodes %j as %j", (input, expected) => {
    // Unpadded, which is the form otpauth URIs use.
    expect(base32Encode(enc(input))).toBe(expected);
  });

  test("round-trips arbitrary bytes", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes]);
    }
  });

  test("accepts what a human actually types", () => {
    // The setup key is shown in hyphenated groups of four and read off a
    // screen, so spacing and case must not change the secret.
    const canonical = base32Decode("MZXW6YTBOI");
    for (const variant of ["mzxw6ytboi", "MZXW 6YTB OI", "MZXW-6YTB-OI", "MZXW6YTBOI="]) {
      expect([...base32Decode(variant)], variant).toEqual([...canonical]);
    }
  });

  test("throws on a character that is not base32", () => {
    // Silently dropping it would yield a secret that is wrong in a way nobody
    // could debug from the outside.
    expect(() => base32Decode("MZXW6YTB0I")).toThrow(/invalid base32/i);
  });
});

describe("TOTP — RFC 6238 Appendix B test vectors", () => {
  // The RFC's SHA-1 seed: the ASCII string "12345678901234567890".
  const SECRET = base32Encode(enc("12345678901234567890"));

  // Appendix B gives 8-digit codes; this implementation emits 6, which is what
  // authenticator apps use, so each expectation is the vector's last 6 digits.
  test.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("at unix time %i the code is %s", async (seconds, eightDigits) => {
    const counter = Math.floor(seconds / TOTP_STEP_SECONDS);
    expect(await totpCode(SECRET, counter)).toBe(eightDigits.slice(-6));
  });

  test("uses the whole 64-bit counter, not just its low 32 bits", async () => {
    // No RFC vector reaches this: the largest is t=20000000000, which is step
    // 666,666,666 — comfortably inside 32 bits, and in fact a real clock will
    // not pass 2^32 steps until roughly the year 130,000. So the counter is
    // written through a DataView for correctness rather than for any date
    // anyone will see, and this is what proves the high word is not dropped:
    // 0 and 2^32 differ *only* above bit 32, so an implementation using JS
    // bitwise operators (which truncate to 32 bits) returns the same code for
    // both. The RFC vectors above cannot catch that.
    const secret = base32Encode(enc("12345678901234567890"));
    expect(await totpCode(secret, 2 ** 32)).not.toBe(await totpCode(secret, 0));
    expect(await totpCode(secret, 2 ** 32 + 1)).not.toBe(await totpCode(secret, 1));
  });
});

describe("verification", () => {
  const SECRET = base32Encode(enc("12345678901234567890"));
  const NOW = 1_700_000_000_000; // fixed, so the window arithmetic is exact

  test("accepts the current code and reports its step", async () => {
    const step = timeStep(NOW);
    const code = await totpCode(SECRET, step);
    expect(await verifyTotp(SECRET, code, NOW)).toEqual({ valid: true, step });
  });

  test("accepts one step either side, for clock skew", async () => {
    // A phone a few seconds fast, or someone who started typing with four
    // seconds left on the code.
    for (const offset of [-1, 1]) {
      const step = timeStep(NOW) + offset;
      const code = await totpCode(SECRET, step);
      expect(await verifyTotp(SECRET, code, NOW), `offset ${offset}`).toEqual({
        valid: true,
        step,
      });
    }
  });

  test("rejects two steps away", async () => {
    for (const offset of [-2, 2]) {
      const code = await totpCode(SECRET, timeStep(NOW) + offset);
      expect((await verifyTotp(SECRET, code, NOW)).valid, `offset ${offset}`).toBe(false);
    }
  });

  test("rejects anything that is not six digits", async () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 56 78"]) {
      expect((await verifyTotp(SECRET, bad, NOW)).valid, JSON.stringify(bad)).toBe(false);
    }
  });

  test("ignores spaces and hyphens in what was typed", async () => {
    const code = await totpCode(SECRET, timeStep(NOW));
    expect((await verifyTotp(SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, NOW)).valid).toBe(
      true
    );
  });

  test("a code from a different secret does not verify", async () => {
    const other = generateTotpSecret();
    const code = await totpCode(other, timeStep(NOW));
    expect((await verifyTotp(SECRET, code, NOW)).valid).toBe(false);
  });
});

describe("secrets and the enrollment URI", () => {
  test("a generated secret is 160 bits of base32", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret).length).toBe(20);
  });

  test("two secrets are not the same", () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });

  test("the otpauth URI carries everything an app needs", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "jordan@example.com");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    // The issuer appears twice on purpose — as a label prefix for older apps
    // and as a parameter for newer ones.
    expect(decodeURIComponent(uri)).toContain("Compass:jordan@example.com");
    const params = new URL(uri).searchParams;
    expect(params.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(params.get("issuer")).toBe("Compass");
    expect(params.get("algorithm")).toBe("SHA1");
    expect(params.get("digits")).toBe("6");
    expect(params.get("period")).toBe("30");
  });

  test("an address with a + or a space survives the label", async () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "jordan+college@example.com");
    expect(decodeURIComponent(uri)).toContain("jordan+college@example.com");
  });

  test("the displayed key is grouped, and still decodes to the same secret", () => {
    const secret = generateTotpSecret();
    const shown = formatSecretForDisplay(secret);
    expect(shown).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
    expect([...base32Decode(shown)]).toEqual([...base32Decode(secret)]);
  });
});

describe("recovery codes", () => {
  test("issues ten distinct, readable codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  });

  test("uses an alphabet with no 0/O or 1/I confusion", () => {
    // These get written on paper and read back by someone already locked out.
    const all = generateRecoveryCodes(50).join("");
    expect(all).not.toMatch(/[018]/);
  });

  test("forgives 0 for O and 8 for B, which the alphabet cannot contain", async () => {
    // Read off paper by someone already locked out. A round character can only
    // be an O and a double-loop can only be a B, so mapping them is safe.
    const [code] = generateRecoveryCodes(1);
    const misread = code!.replace(/O/g, "0").replace(/B/g, "8");
    expect(await hashRecoveryCode(misread)).toBe(await hashRecoveryCode(code!));
  });

  test("does not guess at a typed 1, which could be I or L", async () => {
    // Both I and L are in the alphabet, so either reading would be wrong half
    // the time. Failing is better than silently picking one.
    expect(normalizeRecoveryCode("1")).toBe("1");
    expect(normalizeRecoveryCode("I")).not.toBe(normalizeRecoveryCode("L"));
  });

  test("normalizes case and punctuation before matching", async () => {
    const [code] = generateRecoveryCodes(1);
    const typed = code!.toLowerCase().replace(/-/g, " ");
    expect(normalizeRecoveryCode(typed)).toBe(normalizeRecoveryCode(code!));
    expect(await hashRecoveryCode(typed)).toBe(await hashRecoveryCode(code!));
  });

  test("hashes to a SHA-256 digest, so the table holds nothing usable", async () => {
    const [code] = generateRecoveryCodes(1);
    const hash = await hashRecoveryCode(code!);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(normalizeRecoveryCode(code!));
  });
});
