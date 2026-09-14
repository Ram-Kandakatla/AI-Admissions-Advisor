import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { TwoFactorStatus } from "../types";

/**
 * The two-factor section of /account: switch it on, switch it off, print new
 * recovery codes.
 *
 * WHY ENROLLMENT IS THREE STEPS AND NOT ONE
 *
 *   password → secret shown → code confirms it
 *
 * The middle step exists because the secret has to get into an app before any
 * code can be produced, and the last one exists because the single likeliest
 * way to break this feature is to switch 2FA on for someone whose app is not
 * actually working. Nothing is enabled server-side until a real code comes
 * back, so a mistyped setup key costs a retry rather than an account.
 *
 * WHY THERE IS NO QR CODE
 *
 * The project's zero-new-dependencies rule, and a QR encoder is ~350 lines of
 * Reed-Solomon to write by hand. What replaces it is the pair of things a QR
 * code would have produced anyway: on a phone, the otpauth:// link is tappable
 * and opens the authenticator directly, which is *fewer* steps than scanning;
 * on a desktop, the setup key is shown in groups of four to be typed or pasted
 * into a password manager. Every authenticator app supports manual entry.
 */
export default function TwoFactorPanel({ onChanged }: { onChanged: () => void }) {
  /**
   * `null` until the server answers, and again if asking fails — and neither
   * means "off". Only an answer saying it is off gets the offer to turn it on:
   * offering it on a guess is how an account that already had 2FA could be
   * sent into setup.
   */
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [stage, setStage] = useState<"idle" | "password" | "confirm" | "codes" | "off">("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Shown on the summary when a step ended without changing anything. */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Whether the password step is on its way to a fresh batch of codes rather
   * than to enrollment. Both need the same two proofs, so they share the form
   * and differ only in what happens on submit.
   */
  const [regenerating, setRegenerating] = useState(false);

  const loadStatus = async () => {
    setStatusFailed(false);
    try {
      setStatus(await api.twoFactorStatus());
    } catch {
      setStatus(null);
      setStatusFailed(true);
    }
  };

  useEffect(() => {
    void loadStatus();
    // Once, on mount — loadStatus only calls state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = () => {
    setStage("idle");
    setPassword("");
    setCode("");
    setSecret(null);
    setError(null);
    setNotice(null);
    setBusy(false);
    setRegenerating(false);
  };

  const refresh = async () => {
    await loadStatus();
    onChanged();
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  // ---- The codes screen, shown after enabling or regenerating ----
  if (codes) {
    return (
      <div className="panel acct-2fa acct-2fa-codes">
        <h2 className="acct-hd">Save your recovery codes</h2>
        <p className="acct-warn-strong">
          This is the only time these are shown. They are stored hashed, so nobody —
          including whoever runs Compass — can look them up for you later.
        </p>
        <p>
          Each one works once, in place of a code from your app.{" "}
          <strong>
            If you lose your phone and these codes, you cannot get back into this account.
          </strong>{" "}
          A password reset will not let you skip the second factor. Print them, or put them
          in a password manager.
        </p>

        <ol className="recovery-codes">
          {codes.map((c) => (
            <li key={c}>
              <code>{c}</code>
            </li>
          ))}
        </ol>

        <div className="acct-2fa-actions">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => navigator.clipboard?.writeText(codes.join("\n"))}
          >
            Copy all
          </button>
          {/* The same print path the rest of the app uses for a PDF. */}
          <button className="btn btn-ghost btn-sm" onClick={() => window.print()}>
            Print
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              setCodes(null);
              reset();
              void refresh();
            }}
          >
            I&apos;ve saved them
          </button>
        </div>
      </div>
    );
  }

  // ---- Enrollment: step 2, the secret ----
  if (stage === "confirm" && secret) {
    return (
      <div className="panel acct-2fa">
        <h2 className="acct-hd">Add Compass to your authenticator app</h2>
        <p>
          Use any authenticator app — Google Authenticator, Authy, 1Password, or the one
          built into your password manager.
        </p>

        <ol className="acct-2fa-steps">
          <li>
            <strong>On this phone?</strong>{" "}
            <a href={secret.otpauthUri} className="acct-2fa-link">
              Tap here to add it
            </a>{" "}
            — your authenticator app will open.
          </li>
          <li>
            <strong>On a computer?</strong> Choose &ldquo;enter a setup key&rdquo; in your
            app and type this:
            <code className="acct-2fa-secret">{format(secret.secret)}</code>
          </li>
        </ol>

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const { recoveryCodes } = await api.enableTwoFactor(code);
              setCodes(recoveryCodes);
            });
          }}
        >
          <div className="field">
            <label htmlFor="tfa-confirm">Then enter the six-digit code it shows</label>
            <input
              id="tfa-confirm"
              type="text"
              value={code}
              autoComplete="one-time-code"
              inputMode="numeric"
              autoFocus
              required
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
            />
            <span className="hint">
              Nothing is switched on until this code works, so a mistyped key costs you a
              retry and not your account.
            </span>
          </div>
          <div className="acct-2fa-actions">
            <button className="btn btn-primary" disabled={busy || !code.trim()}>
              {busy ? "Checking…" : "Turn on two-factor"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={reset}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    );
  }

  // ---- Enrollment step 1, and teardown: both ask for the password ----
  if (stage === "password" || stage === "off") {
    const turningOff = stage === "off";
    // Both of these replace or remove the codes someone is relying on, so both
    // ask for a current second factor as well as the password.
    const needsCode = turningOff || regenerating;
    return (
      <div className="panel acct-2fa">
        <h2 className="acct-hd">
          {turningOff
            ? "Turn off two-factor authentication"
            : regenerating
              ? "Generate new recovery codes"
              : "Turn on two-factor authentication"}
        </h2>
        <p>
          {turningOff
            ? "Your account will be protected by its password alone again, and your recovery codes will stop working."
            : regenerating
              ? "A new batch replaces every existing code, so any printout you're holding stops working the moment these are issued."
              : "First, confirm your password — a signed-in session isn't enough authority to change how your account is protected."}
        </p>

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (turningOff) {
                await api.disableTwoFactor(password, code);
                reset();
                await refresh();
              } else if (regenerating) {
                const { recoveryCodes } = await api.regenerateRecoveryCodes(password, code);
                setCodes(recoveryCodes);
              } else {
                try {
                  setSecret(await api.startTwoFactor(password));
                } catch (err) {
                  if (!(err instanceof ApiError && err.status === 409)) throw err;
                  // Already on: it was switched on somewhere else after this
                  // page loaded. The server changed nothing, and setting it up
                  // again would need a code this form doesn't ask for — so
                  // back to a summary that has caught up. The stale answer is
                  // dropped first, or "Off." and its button would sit under
                  // this notice until the new one arrived.
                  reset();
                  setNotice(
                    "Two-factor authentication was already on — it was switched on after this page loaded — so nothing was changed."
                  );
                  setStatus(null);
                  await refresh();
                  return;
                }
                setPassword("");
                setStage("confirm");
              }
            });
          }}
        >
          <div className="field">
            <label htmlFor="tfa-password">Your password</label>
            <input
              id="tfa-password"
              type="password"
              value={password}
              autoComplete="current-password"
              autoFocus
              required
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {needsCode && (
            <div className="field">
              <label htmlFor="tfa-off-code">A code from your app</label>
              <input
                id="tfa-off-code"
                type="text"
                value={code}
                autoComplete="one-time-code"
                inputMode="numeric"
                required
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
              />
              <span className="hint">
                {turningOff
                  ? "Both are needed: a stolen password shouldn't be able to remove the thing that's blocking it, and neither should a borrowed phone."
                  : "Both are needed, since a new batch silently retires the codes you already have."}
              </span>
            </div>
          )}

          <div className="acct-2fa-actions">
            <button
              className={`btn ${turningOff ? "btn-danger" : "btn-primary"}`}
              disabled={busy || !password || (needsCode && !code.trim())}
            >
              {busy
                ? "Checking…"
                : turningOff
                  ? "Turn it off"
                  : regenerating
                    ? "Generate new codes"
                    : "Continue"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={reset}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    );
  }

  // ---- Idle: the summary ----
  return (
    <div className="panel acct-2fa">
      <h2 className="acct-hd">Two-factor authentication</h2>
      {notice && (
        <p role="status">
          <strong>{notice}</strong>
        </p>
      )}
      {!status ? (
        statusFailed ? (
          <>
            <p>Couldn&apos;t check whether two-factor authentication is on.</p>
            <div className="acct-2fa-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => void loadStatus()}>
                Try again
              </button>
            </div>
          </>
        ) : (
          <p>Checking…</p>
        )
      ) : status.enabled ? (
        <>
          <p className="acct-2fa-on">
            <span className="acct-2fa-dot" aria-hidden="true" />
            <strong>On.</strong> Signing in needs a code from your authenticator app as well
            as your password.
          </p>
          <p>
            <strong>
              {status.recoveryCodesRemaining} of {status.recoveryCodesTotal} recovery codes
              left.
            </strong>{" "}
            {status.recoveryCodesRemaining <= 3 && (
              <span className="acct-2fa-low">
                That&apos;s getting low — generate a fresh batch while you still can.
              </span>
            )}
          </p>
          <div className="acct-2fa-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setStage("off")}>
              Turn off
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setStage("password");
                setSecret(null);
                // Regeneration reuses the password+code form, then swaps the
                // codes screen in — see the submit handler below.
                setRegenerating(true);
              }}
            >
              New recovery codes
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            <strong>Off.</strong> Your password is the only thing protecting this account.
          </p>
          <p>
            Turning this on means signing in needs a code from your phone as well. It also
            means a password reset alone won&apos;t get you back in — which is the point,
            since anyone who can read your email can start a reset.
          </p>
          <div className="acct-2fa-actions">
            <button className="btn btn-primary btn-sm" onClick={() => setStage("password")}>
              Turn on two-factor <span className="btn-arrow">→</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Groups of four, so a 32-character key can be read off a screen. */
function format(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}
