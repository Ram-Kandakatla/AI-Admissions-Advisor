// Email via Resend's HTTP API; a Worker has no raw sockets, so SMTP cannot run.
// With no key, sends report failure rather than pretending to deliver.
//
// Every message must be safe in the wrong inbox, since most go to an address
// somebody typed: nothing about the student or account, and no link that does
// more than its one job.

import { createLogger, errorFields } from "../log.js";
import type { Env } from "../types.js";

export type EmailProvider = "resend" | "unconfigured";

/** Logged on failure in place of the address. */
export type EmailKind = "password-reset" | "signup-confirmation" | "signup-notice";

export interface SendResult {
  delivered: boolean;
  provider: EmailProvider;
}

export interface EmailService {
  readonly provider: EmailProvider;
  /** True when mail can actually leave this deployment. */
  readonly available: boolean;
  sendPasswordReset(to: string, resetUrl: string, ttlMinutes: number): Promise<SendResult>;
  sendSignupConfirmation(to: string, confirmUrl: string, ttlHours: number): Promise<SendResult>;
  sendSignupNotice(to: string, signInUrl: string, forgotUrl: string): Promise<SendResult>;
}

interface Message {
  subject: string;
  text: string;
  html: string;
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
function resetEmail(resetUrl: string, ttlMinutes: number): Message {
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

/**
 * The confirmation email, sent when an address has no account yet.
 *
 * It has two readers and is written for both: the person who just filled in
 * the form, and someone whose address was typed in by somebody else. The
 * second needs to hear plainly that ignoring it is safe — and it is, because no
 * account exists until the link is used, and opened in any browser but the one
 * that asked, the link wants a password that person never chose.
 */
function confirmationEmail(confirmUrl: string, ttlHours: number): Message {
  const text = [
    "Someone asked to create a Compass account with this email address.",
    "",
    `If that was you, open this link to finish. It works once and expires in ${ttlHours} hours:`,
    confirmUrl,
    "",
    "If it wasn't you, you can ignore this email. No account is created unless",
    "the link is used.",
    "",
    "— Compass",
  ].join("\n");

  const html = [
    `<p>Someone asked to create a Compass account with this email address.</p>`,
    `<p>If that was you, open this link to finish. It works once and expires in ${ttlHours} hours:</p>`,
    `<p><a href="${confirmUrl}">${confirmUrl}</a></p>`,
    `<p>If it wasn't you, you can ignore this email. No account is created unless the`,
    ` link is used.</p>`,
    `<p>— Compass</p>`,
  ].join("");

  return { subject: "Finish creating your Compass account", text, html };
}

/**
 * The note sent instead of a confirmation, when the address already has an
 * account.
 *
 * This is where the difference the signup response refuses to show ends up:
 * in the one inbox entitled to know it. It carries no token — nothing can be
 * created or changed from it — only the ordinary sign-in and reset pages, which
 * is what the owner needs if the attempt was their own forgetfulness.
 */
function noticeEmail(signInUrl: string, forgotUrl: string): Message {
  const text = [
    "Someone just tried to create a new Compass account with this email address,",
    "but it already has one. Nothing was created, and nothing about your account",
    "has changed.",
    "",
    "If that was you, sign in instead:",
    signInUrl,
    "",
    "Forgotten your password? You can reset it here:",
    forgotUrl,
    "",
    "If it wasn't you, you can ignore this email.",
    "",
    "— Compass",
  ].join("\n");

  const html = [
    `<p>Someone just tried to create a new Compass account with this email address, but`,
    ` it already has one. Nothing was created, and nothing about your account has changed.</p>`,
    `<p>If that was you, <a href="${signInUrl}">sign in instead</a>.</p>`,
    `<p>Forgotten your password? <a href="${forgotUrl}">You can reset it here</a>.</p>`,
    `<p>If it wasn't you, you can ignore this email.</p>`,
    `<p>— Compass</p>`,
  ].join("");

  return { subject: "Someone tried to sign up to Compass with your email", text, html };
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
    log.warn("email is not configured — reset and sign-up emails cannot be delivered", {
      hasKey: !!key,
      keyLooksValid: looksLikeResendKey(key),
      hasFrom: !!from,
    });
  }

  async function send(kind: EmailKind, to: string, message: Message): Promise<SendResult> {
    if (!configured) return { delivered: false, provider };

    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from, to: [to], ...message }),
      });

      if (!res.ok) {
        // The body, not just the status: Resend explains a rejected From
        // domain or an unverified sender in it, and those are the two things
        // that actually go wrong on a first deploy. The recipient address is
        // never logged — see the note at the top of log.ts.
        log.error("email rejected", {
          kind,
          status: res.status,
          detail: (await res.text()).slice(0, 300),
        });
        return { delivered: false, provider };
      }
      return { delivered: true, provider };
    } catch (err) {
      log.error("email failed to send", { kind, ...errorFields(err) });
      return { delivered: false, provider };
    }
  }

  return {
    provider,
    available: configured,
    sendPasswordReset: (to, resetUrl, ttlMinutes) =>
      send("password-reset", to, resetEmail(resetUrl, ttlMinutes)),
    sendSignupConfirmation: (to, confirmUrl, ttlHours) =>
      send("signup-confirmation", to, confirmationEmail(confirmUrl, ttlHours)),
    sendSignupNotice: (to, signInUrl, forgotUrl) =>
      send("signup-notice", to, noticeEmail(signInUrl, forgotUrl)),
  };
}
