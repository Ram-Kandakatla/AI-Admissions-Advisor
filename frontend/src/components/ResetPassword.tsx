import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import type { AuthUser } from "../types";

/** Matches the server's MIN_PASSWORD. Checked here so a too-short password is
 *  caught before it spends the one-use link. */
const MIN_PASSWORD = 8;

/**
 * `/reset?token=…` — choose a new password.
 *
 * WHY THE TOKEN IS IN THE QUERY STRING
 *
 * Because it arrived in an email, and a URL is the only thing an email can
 * hand back. It is a bearer credential in an address bar, which is not
 * wonderful — it lands in browser history, and it would ride along in a
 * Referer header on any outbound link — which is why the page is deliberately
 * bare: it links only to /signin and to the app's own pages, has no external
 * links at all, and the token is one-use and expires in an hour. Every
 * mainstream implementation of this flow makes the same trade for the same
 * reason.
 *
 * WHY IT SIGNS YOU IN INSTEAD OF SENDING YOU TO THE LOGIN FORM
 *
 * Whoever gets here has proved control of the mailbox *and* chosen a password,
 * which is strictly more than signing in asks for. Making them retype what
 * they typed ten seconds ago is friction with nothing to show for it.
 */
export default function ResetPassword({
  onSignedIn,
}: {
  onSignedIn: (user: AuthUser, studentId: string | null) => void;
}) {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A link with no token at all — usually an email client that mangled the
  // URL, or someone who typed /reset by hand. Nothing to submit, so the form
  // is never shown rather than being shown and then failing.
  if (!token) {
    return (
      <section className="acct">
        <div className="panel acct-panel">
          <h1 className="acct-hd">This link is incomplete</h1>
          <p className="acct-sub">
            The reset link is missing its token — some email apps cut long links in half.
            Try opening it again from the email, or ask for a new one.
          </p>
          <Link className="btn btn-primary" to="/forgot">
            Send a new link <span className="btn-arrow">→</span>
          </Link>
        </div>
      </section>
    );
  }

  const tooShort = password !== "" && password.length < MIN_PASSWORD;
  const mismatch = confirm !== "" && password !== confirm;
  const ready = password.length >= MIN_PASSWORD && password === confirm;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { user, studentId } = await api.resetPassword(token, password);
      onSignedIn(user, studentId);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <section className="acct">
      <div className="panel acct-panel">
        <h1 className="acct-hd">Choose a new password</h1>
        <p className="acct-sub">
          This link works once. Once you set a password here you&apos;ll be signed in, and
          anywhere else that was signed in to this account will be signed out.
        </p>

        {error && (
          <div className="form-error" role="alert">
            {error}
            {/* A dead link is the most likely failure, and the fix is a new
                one — so offer it rather than leaving them at a dead end. */}
            <span className="reset-retry">
              {" "}
              <Link to="/forgot">Ask for a new link</Link>
            </span>
          </div>
        )}

        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="reset-password">
              New password <span className="hint">at least {MIN_PASSWORD} characters</span>
            </label>
            <input
              id="reset-password"
              type="password"
              value={password}
              autoComplete="new-password"
              required
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={tooShort || undefined}
            />
          </div>

          <div className="field">
            <label htmlFor="reset-confirm">Type it again</label>
            <input
              id="reset-confirm"
              type="password"
              value={confirm}
              autoComplete="new-password"
              required
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch || undefined}
            />
            {/* Live, and only once there is something to be wrong about — a
                mismatch warning that appears on the first keystroke of the
                second field is noise every single time. */}
            {mismatch && (
              <span className="hint hint-warn" role="status">
                These two don&apos;t match yet.
              </span>
            )}
          </div>

          <button type="submit" className="btn btn-primary acct-submit" disabled={!ready || busy}>
            {busy ? "Setting your password…" : "Set my password"}{" "}
            <span className="btn-arrow">→</span>
          </button>
        </form>
      </div>
    </section>
  );
}
