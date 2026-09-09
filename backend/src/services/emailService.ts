// Sending mail from a Worker.
//
// WHY AN HTTP API AND NOT SMTP
//
// A Worker cannot open a TCP socket to port 25/587 — the runtime has no raw
// sockets for this — so every SMTP library is not merely slower here, it does
// not run. Transactional mail from Workers is an HTTPS call to a provider, and
// the only question is which one. (MailChannels used to relay from Workers for
// free with no account at all, which is what most older Cloudflare tutorials
// still describe; that offering ended in 2024.)
//
// WHY THIS MIRRORS llmService.ts
//
// Same shape on purpose: a `createEmailService(env)` factory, the key checked
// once at construction rather than at each call, and a defined degraded mode
// when there is no key. That pattern already earns its keep for the LLM — the
// app runs with no ANTHROPIC_API_KEY — and it earns it twice here, because it
// means a developer can exercise the whole password-reset flow locally without
// signing up for anything.
//
// WHAT DEGRADED MODE MEANS HERE, AND WHY IT IS NOT THE LLM'S
//
// The chatbot's fallback answers the question worse. There is no worse-but-
// still-useful way to deliver an email, so this one reports that it could not
// send, and the route decides what to tell the user. It never pretends.

import { createLogger, errorFields } from "../log.js";
import type { Env } from "../types.js";

export type EmailProvider = "resend" | "unconfigured";

export interface SendResult {
  delivered: boolean;
  provider: EmailProvider;
}

export interface EmailService {
  readonly provider: EmailProvider;
  /** True when mail can actually leave this deployment. */
  readonly available: boolean;
  sendPasswordReset(to: string, resetUrl: string, ttlMinutes: number): Promise<SendResult>;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Does this look like a Resend key at all?
 *
 * The same cheap shape check llmService does on the model keys, for the same
 * reason: a placeholder left in a config file should degrade to "not
 * configured" — a state the app handles — rather than to a 401 at the moment
 * someone is locked out of their account and least able to cope with it.
 */
function looksLikeResendKey(value: string | undefined): boolean {
  return typeof value === "string" && /^re_[A-Za-z0-9_-]{10,}$/.test(value.trim());
}

/**
 * The reset email.
 *
 * Deliberately plain, and deliberately short. Three things it does that a
 * templated marketing-style email would not:
 *
 *   - Says how long the link lasts, because the single most common support
 *     question about a reset is "I clicked it and it didn't work".
 *   - Tells someone who did *not* request this that they can ignore it and
 *     that nothing has changed yet. That is true — requesting a reset alters
 *     nothing — and saying so stops a spurious request from reading as a
 *     compromise.
 *   - Contains no tracking pixel, no click wrapper, and no images. A wrapped
 *     link would route a password reset through a third-party redirector, and
 *     the whole point of self-hosting the fonts was to stop doing that kind of
 *     thing to people.
 */
function resetEmail(resetUrl: string, ttlMinutes: number) {
  const text = [
    "Someone asked to reset the password on your Compass account.",
    "",
    `Open this link to choose a new one. It works once and expires in ${ttlMinutes} minutes:`,
    resetUrl,
    "",
    "If that wasn't you, you can ignore this email — nothing has changed, and",
    "your password still works. Nobody can change it without this link.",
    "",
    "— Compass",
  ].join("\n");

  // A minimal HTML part alongside the text one. Both, because a text-only
  // message is more likely to be filtered as spam, and an HTML-only one is
  // unreadable in the clients that prefer text.
  const html = [
    `<p>Someone asked to reset the password on your Compass account.</p>`,
    `<p>Open this link to choose a new one. It works once and expires in ${ttlMinutes} minutes:</p>`,
    `<p><a href="${resetUrl}">${resetUrl}</a></p>`,
    `<p>If that wasn't you, you can ignore this email — nothing has changed, and your`,
    ` password still works. Nobody can change it without this link.</p>`,
    `<p>— Compass</p>`,
  ].join("");

  return { subject: "Reset your Compass password", text, html };
}

export function createEmailService(env: Env): EmailService {
  const log = createLogger(env);
  const key = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();

  // Both halves are required. A key with no From address cannot send, and
  // saying which one is missing turns a silent non-delivery into a fixable
  // configuration error.
  const configured = looksLikeResendKey(key) && !!from;
  const provider: EmailProvider = configured ? "resend" : "unconfigured";

  if (!configured) {
    log.warn("email is not configured — password reset cannot deliver", {
      hasKey: !!key,
      keyLooksValid: looksLikeResendKey(key),
      hasFrom: !!from,
    });
  }

  async function sendPasswordReset(
    to: string,
    resetUrl: string,
    ttlMinutes: number
  ): Promise<SendResult> {
    if (!configured) return { delivered: false, provider };

    const { subject, text, html } = resetEmail(resetUrl, ttlMinutes);
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
      });

      if (!res.ok) {
        // The body, not just the status: Resend explains a rejected From
        // domain or an unverified sender in it, and those are the two things
        // that actually go wrong on a first deploy. The recipient address is
        // never logged — see the note at the top of log.ts.
        log.error("password reset email rejected", {
          status: res.status,
          detail: (await res.text()).slice(0, 300),
        });
        return { delivered: false, provider };
      }
      return { delivered: true, provider };
    } catch (err) {
      log.error("password reset email failed to send", errorFields(err));
      return { delivered: false, provider };
    }
  }

  return { provider, available: configured, sendPasswordReset };
}
