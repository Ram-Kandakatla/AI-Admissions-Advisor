import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

/**
 * `/forgot` — ask for a reset link.
 *
 * WHY THE SUCCESS SCREEN IS DELIBERATELY VAGUE
 *
 * It says "if an account exists for that address" and never "we've sent you an
 * email", because the server cannot tell the client which of those is true
 * without turning this page into a membership oracle: paste in a list of
 * addresses, read the responses, and learn which of them belong to teenagers
 * with a college-planning account. That inference is worth more to the wrong
 * person than any single account, so the vagueness is the feature.
 *
 * It is also the thing a future "helpful" edit is most likely to break — the
 * obvious improvement is to say "no account found, want to sign up?", and that
 * is exactly the sentence that cannot be written here.
 */
export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      // Only a malformed address or an unreachable API reaches here — an
      // unknown address is a 202 like any other.
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <section className="acct">
        <div className="panel acct-panel acct-sent">
          <h1 className="acct-hd">Check your email</h1>
          <p>
            If an account exists for <strong>{email.trim()}</strong>, a reset link is on its
            way. It works once and expires in an hour.
          </p>
          <p className="acct-sent-note">
            Nothing has changed on your account yet — asking for a link doesn&apos;t alter
            anything, so if you remember your password you can still sign in with it.
          </p>
          <p className="acct-sent-note">
            No email after a few minutes? Check your spam folder, then{" "}
            <button
              type="button"
              className="linkish"
              onClick={() => {
                setSent(false);
                setBusy(false);
              }}
            >
              try a different address
            </button>
            .
          </p>
          <Link className="btn btn-ghost" to="/signin">
            Back to sign in
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="acct">
      <div className="panel acct-panel">
        <h1 className="acct-hd">Reset your password</h1>
        <p className="acct-sub">
          Enter the email you signed up with and we&apos;ll send you a link to choose a new
          password.
        </p>

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="forgot-email">Email</label>
            <input
              id="forgot-email"
              type="email"
              value={email}
              autoComplete="email"
              required
              autoFocus
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@school.edu"
            />
          </div>

          <button type="submit" className="btn btn-primary acct-submit" disabled={busy}>
            {busy ? "Sending…" : "Send me a link"} <span className="btn-arrow">→</span>
          </button>
        </form>

        <p className="acct-alt">
          Remembered it? <Link to="/signin">Sign in</Link>
        </p>
        <p className="acct-alt acct-guest-note">
          Never made an account? A guest list lives only in the browser that built it and
          has no password to reset — there is nothing to recover it with.
        </p>
      </div>
    </section>
  );
}
