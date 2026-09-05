import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import type { AuthUser, StudentRecord } from "../types";

export type AccountMode = "signup" | "login";

/**
 * Sign in / create an account.
 *
 * Composed like the hero rather than as a centred card in an empty page: the
 * left column says what an account is actually for, the right one is the form.
 * A visitor lands here holding an unsaved list, so the page has a job beyond
 * collecting a password — it has to answer "why would I".
 */
export default function Account({
  mode,
  guestProfile,
  onSignedIn,
}: {
  mode: AccountMode;
  /** The unsaved profile this visitor built, if any. */
  guestProfile: StudentRecord | null;
  onSignedIn: (user: AuthUser, studentId: string | null, replacedDraft: boolean) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Switching tabs should land the cursor in the first field, not leave focus
  // on the tab the pointer just used — a keyboard user would otherwise have to
  // tab back into the form every time.
  useEffect(() => {
    emailRef.current?.focus();
    setErrors([]);
  }, [mode]);

  const signingUp = mode === "signup";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors([]);
    try {
      if (signingUp) {
        const { user, studentId } = await api.signup(email, password);
        onSignedIn(user, studentId, false);
      } else {
        const { user, studentId, discardedGuestProfile } = await api.login(email, password);
        onSignedIn(user, studentId, discardedGuestProfile);
      }
    } catch (err) {
      setErrors([err instanceof Error ? err.message : "Something went wrong."]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="acct">
      <div className="acct-grid">
        <div className="acct-pitch">
          <span className="eyebrow">{signingUp ? "Save your work" : "Welcome back"}</span>
          {signingUp ? (
            <h1>
              This list should still be here in <em>October</em>.
            </h1>
          ) : (
            <h1>
              Pick up where you <em>left off</em>.
            </h1>
          )}

          <p className="lead">
            {signingUp
              ? "Right now your profile lives in this browser and nowhere else — clear your history and it's gone. An account ties it to an email instead."
              : "Your college list, your notes on each school, and every deadline you're tracking come back exactly as you left them."}
          </p>

          {signingUp && (
            <ul className="acct-keeps">
              <li>Your profile and the matches built from it</li>
              <li>Every school you've starred and the notes you've written</li>
              <li>Your application tracker, deadlines and checklists</li>
              <li>The same list on your phone, your laptop, and a library computer</li>
            </ul>
          )}
        </div>

        <div className="panel acct-panel">
          <div className="segmented acct-tabs" role="group" aria-label="Account">
            {/* A two-state control styled as a segmented switch, so it stays
                a pair of buttons rather than links — but each state is a real
                URL now, so switching navigates. `replace`, because flipping
                tabs four times should not be four presses of back. */}
            <button
              type="button"
              aria-pressed={signingUp}
              onClick={() => navigate("/signup", { replace: true })}
            >
              Create account
            </button>
            <button
              type="button"
              aria-pressed={!signingUp}
              onClick={() => navigate("/signin", { replace: true })}
            >
              Sign in
            </button>
          </div>

          {/* What happens to the work in progress, said before they commit to
              it rather than after. Signing up keeps the draft; signing in to an
              existing account replaces it, and that is worth a warning. */}
          {guestProfile && (
            <p className={`banner ${signingUp ? "" : "banner-warn"} acct-draft`}>
              {signingUp
                ? `${guestProfile.name}'s profile will be saved to this account.`
                : `You have an unsaved profile for ${guestProfile.name}. Signing in loads the list already on that account instead.`}
            </p>
          )}

          {errors.length > 0 && (
            <div className="form-error" role="alert">
              {errors.join(" ")}
            </div>
          )}

          <form onSubmit={submit} noValidate>
            <div className="field">
              <label htmlFor="acct-email">Email</label>
              <input
                id="acct-email"
                ref={emailRef}
                type="email"
                value={email}
                autoComplete="email"
                required
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@school.edu"
              />
            </div>

            <div className="field acct-field">
              <label htmlFor="acct-password">
                Password{" "}
                {signingUp && <span className="hint">at least 8 characters</span>}
              </label>
              <input
                id="acct-password"
                type="password"
                value={password}
                // Tells a password manager to offer a new one rather than
                // autofilling the old one into a signup form.
                autoComplete={signingUp ? "new-password" : "current-password"}
                required
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <button type="submit" className="btn btn-primary acct-submit" disabled={busy}>
              {busy
                ? signingUp
                  ? "Creating your account…"
                  : "Signing you in…"
                : signingUp
                  ? "Create my account"
                  : "Sign in"}{" "}
              <span className="btn-arrow">→</span>
            </button>
          </form>

        </div>
      </div>
    </section>
  );
}
