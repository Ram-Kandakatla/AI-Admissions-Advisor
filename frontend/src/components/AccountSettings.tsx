import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { AuthUser } from "../types";

/**
 * `/account` — what Compass holds about you, and the button that erases it.
 *
 * WHY THIS PAGE EXISTS
 *
 * The privacy policy claimed five self-serve rights and delivered four. See
 * it, correct it, export it, delete parts of it — all true. Delete *all* of it
 * was "email us and we'll do it by hand", which for an app whose users are
 * mostly minors is the weakest possible answer to the request that matters
 * most to someone who has changed their mind. This is the button that was
 * missing.
 *
 * WHY IT OFFERS AN EXPORT FIRST
 *
 * Erasure and portability are two different rights, and the moment someone
 * exercises the first is the last moment they can exercise the second. A
 * student deleting an account in March has a college list they may well still
 * want in April, and the CSV takes one click. Putting it here is not a dark
 * pattern to slow them down — nothing is hidden and nothing is discouraged —
 * it is the one piece of information that is genuinely useful at this moment
 * and useless five seconds later.
 *
 * WHY THE CONFIRMATION IS TYPE-TO-CONFIRM AND NOT A DIALOG
 *
 * A modal with a Cancel and a Delete is dismissed by muscle memory; the whole
 * interaction can be completed without reading a word. Typing the word cannot
 * be, and that is the entire point for an action with no undo. A signed-in
 * account additionally has to retype its password, which is what stops a
 * borrowed laptop or an unlocked phone being enough.
 */
export default function AccountSettings({
  user,
  hasProfile,
  onDeleted,
}: {
  /** `undefined` while the session is still being restored. */
  user: AuthUser | null | undefined;
  hasProfile: boolean;
  onDeleted: (hadProfile: boolean) => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user === undefined) {
    return <div className="spinner" aria-label="Loading your account" />;
  }

  // No session at all. Nothing to show and nothing to delete — and saying so
  // is better than an empty danger zone that implies there is something here.
  if (!user) {
    return (
      <div className="empty">
        <h1>No account on this browser</h1>
        <p>
          You&apos;re not signed in and haven&apos;t started a profile, so Compass
          isn&apos;t storing anything about you.
        </p>
        <div className="empty-actions">
          <Link className="btn btn-primary" to="/signin">
            Sign in <span className="btn-arrow">→</span>
          </Link>
          <Link className="btn btn-ghost" to="/profile">
            Start a profile
          </Link>
        </div>
      </div>
    );
  }

  const isGuest = user.guest;
  // A guest has no password_hash by construction, so there is nothing to
  // retype and asking would be asking for something that cannot exist.
  const ready = confirm.trim().toUpperCase() === "DELETE" && (isGuest || password !== "");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { hadProfile } = await api.deleteAccount(isGuest ? undefined : password);
      // App clears the shared state and navigates; this component unmounts.
      onDeleted(hadProfile);
    } catch (err) {
      setError((err as Error).message);
      // Cleared on failure, never on success — a wrong password left in the
      // box invites a second attempt with the same wrong value.
      setPassword("");
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="view-head">
        <span className="eyebrow">Your account</span>
        <h1 className="section-title">
          {isGuest ? "This list isn't saved to an account" : "Account settings"}
        </h1>
        <p className="lead">
          {isGuest
            ? "You're using Compass as a guest. Your work lives in this browser's session and nowhere else — which also means it disappears on its own when the session expires."
            : "You're signed in, so your work is saved to your account and follows you between devices."}
        </p>
      </div>

      <div className="panel acct-who">
        <dl>
          <div>
            <dt>Signed in as</dt>
            <dd>{isGuest ? <em>Guest — no email on this account</em> : user.email}</dd>
          </div>
          <div>
            <dt>Account created</dt>
            <dd>
              <time dateTime={user.createdAt}>
                {new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(
                  new Date(user.createdAt)
                )}
              </time>
            </dd>
          </div>
        </dl>
        {isGuest && (
          <p className="acct-upgrade">
            <Link className="btn btn-primary btn-sm" to="/signup">
              Save this list to an account <span className="btn-arrow">→</span>
            </Link>
          </p>
        )}
      </div>

      {hasProfile && (
        <div className="panel acct-export">
          <h2 className="acct-hd">Take a copy first?</h2>
          <p>
            Deleting is permanent, and exporting is the only thing you can do now that you
            can&apos;t do afterwards. Your saved schools and college list download as a
            spreadsheet, and any page saves as a PDF through your browser&apos;s print
            dialog.
          </p>
          <div className="acct-export-links">
            <Link className="btn btn-ghost btn-sm" to="/saved">
              Export saved schools
            </Link>
            <Link className="btn btn-ghost btn-sm" to="/matches">
              Export my college list
            </Link>
          </div>
        </div>
      )}

      <form className="panel acct-danger" onSubmit={submit}>
        <h2 className="acct-hd acct-hd-danger">
          {isGuest ? "Erase everything in this browser" : "Delete this account"}
        </h2>
        <p>
          This removes {isGuest ? "your guest profile" : "your account"} and everything
          attached to it, immediately and permanently. There is no undo and no grace
          period — Compass keeps no backup copy it could restore you from.
        </p>

        <p className="acct-goes-label" id="acct-goes">
          What goes:
        </p>
        <ul className="legal-list" aria-labelledby="acct-goes">
          <li>Your profile — GPA, test scores, majors, activities, and career goal</li>
          <li>Every school note, star, and counselor contact you saved</li>
          <li>Your tracked applications, deadlines, and checklist progress</li>
          <li>Both conversations — the advisor and the essay assistant</li>
          <li>Any share link, so a URL you sent someone stops working</li>
          {!isGuest && <li>Your email address and password</li>}
          <li>
            Every signed-in session, so you&apos;re signed out everywhere, not just here
          </li>
        </ul>

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}

        {!isGuest && (
          <div className="field">
            <label htmlFor="acct-password">Confirm your password</label>
            <input
              id="acct-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
            <span className="hint">
              Asked again because a valid session isn&apos;t enough authority to destroy
              everything you&apos;ve built — a borrowed laptop has one too.
            </span>
          </div>
        )}

        <div className="field">
          <label htmlFor="acct-confirm">
            Type <code>DELETE</code> to confirm
          </label>
          <input
            id="acct-confirm"
            type="text"
            // Every one of these off: a browser helpfully completing the word
            // that exists to prove deliberateness would defeat the control.
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
            aria-describedby="acct-confirm-hint"
          />
          <span className="hint" id="acct-confirm-hint">
            Typing it is the confirmation — there&apos;s no second dialog after this.
          </span>
        </div>

        <div className="acct-danger-actions">
          <button type="submit" className="btn btn-danger" disabled={!ready || busy}>
            {busy
              ? "Deleting…"
              : isGuest
                ? "Erase everything"
                : "Delete my account permanently"}
          </button>
          <Link className="btn btn-ghost" to="/">
            Never mind
          </Link>
        </div>
      </form>

      <p className="acct-foot">
        What Compass stores and why is in the <Link to="/privacy">Privacy Policy</Link>.
      </p>
    </div>
  );
}
