import { useEffect, useState } from "react";
import { api } from "../api";
import type { ShareLink, StudentRecord } from "../types";

// Handing a parent or counselor a read-only view of the plan.
//
// The whole screen is written around one fact the student has to understand
// before they press anything: the link is the password. There is no sign-in on
// the other end, so anyone the URL reaches — including anyone it is forwarded
// to — can read the plan until it is revoked. Saying that plainly, next to the
// button, is the actual safety feature here; a confirmation dialog after the
// fact would be theatre.

/** What the reader will and won't see, stated before the link exists. */
const SHARED = [
  "Your profile — GPA, test scores, intended majors, and activities",
  "Your matches, with the reach/target/safety reasoning behind them",
  "Your scholarship list",
  "Your tracked applications, deadlines, and checklist progress",
  "Your saved schools and the notes you wrote on them",
];

const WITHHELD = [
  "Your conversations with Compass — both the advisor and the essay assistant",
  "Your email address and anything else about your account",
  "How much financial help you said your family needs",
];

export default function ShareSettings({ student }: { student: StudentRecord }) {
  const [link, setLink] = useState<ShareLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingRotate, setConfirmingRotate] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .shareLink(student.id)
      .then((res) => live && setLink(res.link))
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [student.id]);

  // Built here rather than server-side: the API has no idea what origin the
  // app is served from, and in Phase 7 that is a custom domain it is never
  // told about.
  const url = link ? `${window.location.origin}/shared/${link.token}` : "";

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => setLink((await api.createShareLink(student.id)).link));

  const rotate = () =>
    run(async () => {
      setLink((await api.createShareLink(student.id, true)).link);
      setConfirmingRotate(false);
      setCopied(false);
    });

  const revoke = () =>
    run(async () => {
      await api.revokeShareLink(student.id);
      setLink(null);
      setCopied(false);
    });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard access is refused in some browsers and over plain http. The
      // input below is selectable and read-only, so there is always a manual
      // path — no need to turn this into an error.
      setError("Couldn't copy automatically — select the link and copy it.");
    }
  };

  return (
    <div>
      <div className="view-head">
        <span className="eyebrow">Share your plan</span>
        <h1 className="section-title">Let someone follow along.</h1>
        <p className="lead">
          A counselor or a parent can open a read-only version of your plan — no account, nothing
          to install. You can turn the link off at any time.
        </p>
      </div>

      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="spinner" aria-label="Loading your share link" />
      ) : (
        <div className="panel share-panel">
          {link ? (
            <>
              <h2 className="share-hd">Your link is live</h2>
              <p className="share-sub">
                Anyone with this link can read your plan. Send it to people you trust, and revoke
                it when you&apos;re done.
              </p>

              <div className="share-url">
                <label className="sr-only" htmlFor="share-url">
                  Your share link
                </label>
                <input
                  id="share-url"
                  type="text"
                  readOnly
                  value={url}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button className="btn btn-primary btn-sm" onClick={copy} disabled={busy}>
                  {copied ? "Copied" : "Copy link"}
                </button>
              </div>
              {/* The copy button's label changes, which a screen reader will
                  not necessarily announce on its own. */}
              <span className="note-status" role="status">
                {copied ? "Link copied to your clipboard" : ""}
              </span>

              <div className="share-actions">
                {confirmingRotate ? (
                  <div className="share-confirm" role="group" aria-label="Replace this link">
                    <span>
                      Replacing it breaks the old link straight away. Anyone you already sent it to
                      will need the new one.
                    </span>
                    <button className="btn btn-sm btn-primary" onClick={rotate} disabled={busy}>
                      Replace it
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => setConfirmingRotate(false)}
                      disabled={busy}
                    >
                      Keep the current link
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => setConfirmingRotate(true)}
                      disabled={busy}
                    >
                      Replace with a new link
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={revoke} disabled={busy}>
                      Turn sharing off
                    </button>
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              <h2 className="share-hd">Sharing is off</h2>
              <p className="share-sub">
                Nobody can see your plan. Create a link when you want to show it to someone.
              </p>
              <button className="btn btn-primary" onClick={create} disabled={busy}>
                {busy ? "Creating…" : "Create a share link"}{" "}
                <span className="btn-arrow">→</span>
              </button>
            </>
          )}
        </div>
      )}

      {/* Deliberately below the button and always visible, not tucked behind a
          "learn more". What a link exposes is the decision being made. */}
      <div className="share-scope">
        <section>
          <h2>What they&apos;ll see</h2>
          <ul>
            {SHARED.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
        <section>
          <h2>What stays private</h2>
          <ul className="share-private">
            {WITHHELD.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      </div>

      <p className="md-note">
        Treat the link like a password: anyone who has it can open your plan, including anyone it
        gets forwarded to. It shows whatever your plan says at the moment they open it, so edits
        you make later are visible to them too.
      </p>
    </div>
  );
}
