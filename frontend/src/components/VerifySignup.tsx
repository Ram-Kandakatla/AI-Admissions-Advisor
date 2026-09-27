import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import type { AuthUser } from "../types";

/**
 * Redeems the token on load, once: a ref guards against StrictMode's double
 * effect, whose racing second call would show "already has an account".
 * Outside the browser that signed up, the server asks for the signup password.
 */
export default function VerifySignup({
  onSignedIn,
}: {
  onSignedIn: (user: AuthUser, studentId: string | null, replacedDraft: boolean) => void;
}) {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requested = useRef(false);

  useEffect(() => {
    if (!token || requested.current) return;
    requested.current = true;
    api
      .verifySignup(token)
      .then((result) => {
        if (result.passwordRequired) setNeedsPassword(true);
        else onSignedIn(result.user, result.studentId, result.discardedGuestProfile);
      })
      .catch((err: Error) => setError(err.message));
  }, [token, onSignedIn]);

  // A link with no token at all — usually an email client that mangled the
  // URL. Nothing to redeem, so nothing is attempted.
  if (!token) {
    return (
      <section className="acct">
        <div className="panel acct-panel">
          <h1 className="acct-hd">This link is incomplete</h1>
          <p className="acct-sub">
            The link is missing its token — some email apps cut long links in half. Try
            opening it again from the email, or sign up again for a new one.
          </p>
          <Link className="btn btn-primary" to="/signup">
            Sign up again <span className="btn-arrow">→</span>
          </Link>
        </div>
      </section>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.verifySignup(token, password);
      if (result.passwordRequired) {
        setBusy(false);
        return;
      }
      onSignedIn(result.user, result.studentId, result.discardedGuestProfile);
    } catch (err) {
      // A wrong password leaves the link usable, so the form stays put.
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (needsPassword) {
    return (
      <section className="acct">
        <div className="panel acct-panel">
          <h1 className="acct-hd">Enter your password to finish</h1>
          <p className="acct-sub">
            This link was opened somewhere other than the browser you signed up in, so
            Compass needs the password you chose to be sure it&apos;s you.
          </p>

          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}

          <form onSubmit={submit} noValidate>
            <div className="field">
              <label htmlFor="verify-password">Password</label>
              <input
                id="verify-password"
                type="password"
                value={password}
                autoComplete="current-password"
                required
                autoFocus
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <button type="submit" className="btn btn-primary acct-submit" disabled={busy || !password}>
              {busy ? "Finishing…" : "Finish creating my account"}{" "}
              <span className="btn-arrow">→</span>
            </button>
          </form>

          <p className="acct-alt acct-guest-note">
            Didn&apos;t sign up for Compass? You can close this page. Without that password,
            nothing is created.
          </p>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="acct">
        <div className="panel acct-panel">
          <h1 className="acct-hd">This link didn&apos;t work</h1>
          <div className="form-error" role="alert">
            {error}
          </div>
          <p className="acct-alt">
            <Link to="/signup">Sign up again</Link> for a fresh link, or{" "}
            <Link to="/signin">sign in</Link> if your account is already set up.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="acct">
      <div className="panel acct-panel">
        <h1 className="acct-hd">Confirming your email…</h1>
        <p className="acct-sub" role="status">
          This only takes a moment.
        </p>
      </div>
    </section>
  );
}
