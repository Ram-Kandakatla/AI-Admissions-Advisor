import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { toggleCompare } from "./compare";
import { useSchoolNotes } from "./useSchoolNotes";
import type { AuthUser, Meta, StudentRecord } from "./types";
import Home from "./components/Home";
import ProfileForm from "./components/ProfileForm";
import Recommendations from "./components/Recommendations";
import Scholarships from "./components/Scholarships";
import SavedSchools from "./components/SavedSchools";
import SchoolCompare from "./components/SchoolCompare";
import UniversityExplorer from "./components/UniversityExplorer";
import ChatBot from "./components/ChatBot";
import ApplicationTracker from "./components/ApplicationTracker";
import ApplicationTimeline from "./components/ApplicationTimeline";
import MajorDeepDive from "./components/MajorDeepDive";
import BrandMark from "./components/BrandMark";
import Account, { type AccountMode } from "./components/Account";

type View =
  | "home"
  | "profile"
  | "matches"
  | "scholarships"
  | "saved"
  | "compare"
  | "tracker"
  | "timeline"
  | "majors"
  | "explore"
  | "chat"
  | "account";
type Theme = "light" | "dark";

interface NavItem {
  key: View;
  label: string;
  needsProfile?: boolean;
}

type NavEntry =
  | { kind: "link"; item: NavItem }
  | { kind: "group"; id: string; label: string; items: NavItem[] };

// Eleven destinations is too many for one flat row, so the two that form a
// natural pair of jobs — building the list versus working it — collapse into
// menus. Home, Profile, and Ask stay at the top level: they're the entry, the
// prerequisite, and the escape hatch, and burying any of them would cost more
// than the row width it saves.
const NAV: NavEntry[] = [
  { kind: "link", item: { key: "home", label: "Home" } },
  { kind: "link", item: { key: "profile", label: "Your Profile" } },
  {
    kind: "group",
    id: "plan",
    label: "Plan",
    items: [
      { key: "matches", label: "Matches", needsProfile: true },
      { key: "scholarships", label: "Scholarships", needsProfile: true },
      { key: "saved", label: "Saved", needsProfile: true },
      { key: "tracker", label: "Tracker", needsProfile: true },
      { key: "timeline", label: "Timeline" },
    ],
  },
  {
    kind: "group",
    id: "research",
    label: "Research",
    items: [
      { key: "compare", label: "Compare" },
      { key: "majors", label: "Majors" },
      { key: "explore", label: "Explore" },
    ],
  },
  { kind: "link", item: { key: "chat", label: "Ask Compass" } },
];

// The pre-paint script in index.html has already put the right theme on
// <html>; read it back rather than guessing, so the two never disagree.
const initialTheme = (): Theme =>
  (document.documentElement.getAttribute("data-theme") as Theme) ?? "light";

/**
 * Below this width the nav is a full-height panel with room to spare, so the
 * groups drop their dropdowns and render as labelled sections — no nested
 * menu to tap through on a phone. Keep in sync with the matching breakpoint
 * in global.css.
 */
const COMPACT_NAV = "(max-width: 980px)";

function useCompactNav(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_NAV).matches);
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_NAV);
    const onChange = (e: MediaQueryListEvent) => setCompact(e.matches);
    setCompact(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return compact;
}

export default function App() {
  const [view, setView] = useState<View>("home");
  const [student, setStudent] = useState<StudentRecord | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  // Who the session says we are. `undefined` means "not asked yet", which is
  // distinct from "asked, nobody" — rendering a Sign in button during that gap
  // would flash the wrong state at every returning visitor on every load.
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [accountMode, setAccountMode] = useState<AccountMode>("signup");
  const [savePrompt, setSavePrompt] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  // Schools picked for side-by-side. Lifted here so ticking "Compare" on a
  // match card survives the trip to the comparison page.
  const [compareIds, setCompareIds] = useState<number[]>([]);
  // A question handed to the chatbot from another page (the major deep dive
  // sends "tell me about X at Y"). Cleared once the chatbot has sent it.
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);

  // Notes and stars are shared by five pages, so they live here rather than
  // in any one of them — a star tapped on a match card has to be lit when the
  // explorer renders the same school a second later.
  const notes = useSchoolNotes(student?.id ?? null);

  const compact = useCompactNav();
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    api.meta().then(setMeta).catch(() => setMeta(null));
  }, []);

  // Restore the session on load.
  //
  // This is also the first time Compass survives a refresh at all: before
  // Phase 2 the student id lived only in this component's state, so reloading
  // the page silently discarded a finished profile. The cookie now outlives
  // the tab, and the profile comes back with it.
  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then(async ({ user: current, studentId }) => {
        if (cancelled) return;
        setUser(current);
        if (!studentId) return;
        const record = await api.student(studentId).catch(() => null);
        if (!cancelled && record) setStudent(record);
      })
      .catch(() => {
        // An unreachable API is not a signed-out visitor, but there is nothing
        // better to show than the logged-out shell until it answers.
        if (!cancelled) setUser(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("compass-theme", theme);
    } catch {
      /* private mode — the theme just won't persist */
    }
  }, [theme]);

  // An open dropdown closes on a click anywhere else and on Escape — the two
  // things anyone tries first when a menu is in the way.
  useEffect(() => {
    if (!openGroup) return;
    const away = (e: PointerEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpenGroup(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenGroup(null);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [openGroup]);

  const go = (v: View) => {
    setView(v);
    setMenuOpen(false);
    setOpenGroup(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const onProfileSaved = (record: StudentRecord) => {
    setStudent(record);
    // A guest who just built a profile now has something to lose, so the
    // prompt to save it becomes relevant again even if they dismissed it
    // before there was anything behind it.
    setSavePrompt(true);

    // Who we are may have just changed. A first-time visitor has no session
    // until POST /api/students mints the anonymous account that owns the
    // profile — so without re-asking, `user` stays the null from page load and
    // nothing ever knows this list belongs to a guest.
    if (!user) {
      api
        .me()
        .then(({ user: current }) => setUser(current))
        .catch(() => {
          /* the profile saved; knowing our own account name can wait */
        });
    }

    go("matches");
  };

  const onSignedIn = async (
    account: AuthUser,
    studentId: string | null,
    replacedDraft: boolean
  ) => {
    setUser(account);
    const record = studentId ? await api.student(studentId).catch(() => null) : null;
    setStudent(record);
    setNotice(
      replacedDraft
        ? "Signed in. We loaded the list saved to this account — the unsaved one you were building is not part of it."
        : null
    );
    go(record ? "matches" : "profile");
  };

  const signOut = async () => {
    await api.logout().catch(() => {
      /* the cookie is the session; a failed call leaves it in place */
    });
    setUser(null);
    setStudent(null);
    setCompareIds([]);
    setNotice(null);
    go("home");
  };

  // A guest with a profile has work that dies with this browser. Everyone else
  // — signed in, or not started yet — has nothing to warn about.
  const unsaved = user?.guest === true && student !== null;

  const renderItem = (item: NavItem) => (
    <button
      key={item.key}
      className="nav-link"
      aria-current={view === item.key}
      disabled={item.needsProfile && !student}
      title={item.needsProfile && !student ? "Build your profile first" : undefined}
      onClick={() => go(item.key)}
    >
      {item.label}
    </button>
  );

  return (
    <div className="app">
      <header className="header no-print">
        <div className="container header-inner">
          <button className="brand" onClick={() => go("home")} aria-label="Compass home">
            <BrandMark className="brand-mark" />
            <span className="brand-name">
              Comp<b>ass</b>
            </span>
          </button>

          <button
            className="nav-toggle"
            aria-label="Toggle menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span />
            <span />
            <span />
          </button>

          <nav className="nav" data-open={menuOpen} ref={navRef}>
            {NAV.map((entry) => {
              if (entry.kind === "link") return renderItem(entry.item);

              const active = entry.items.some((i) => i.key === view);

              // In the mobile panel the group is a heading over its links —
              // there's vertical room, and a menu inside a menu is a tap tax.
              if (compact) {
                return (
                  <div className="nav-section" key={entry.id}>
                    <span className="nav-section-label">{entry.label}</span>
                    {entry.items.map(renderItem)}
                  </div>
                );
              }

              return (
                <div className="nav-group" key={entry.id}>
                  <button
                    className="nav-link nav-group-btn"
                    aria-haspopup="true"
                    aria-expanded={openGroup === entry.id}
                    aria-current={active}
                    onClick={() => setOpenGroup((g) => (g === entry.id ? null : entry.id))}
                  >
                    {entry.label}
                    <svg className="nav-caret" viewBox="0 0 12 12" aria-hidden="true">
                      <path d="M3 4.5 6 7.5 9 4.5" />
                    </svg>
                  </button>
                  {openGroup === entry.id && (
                    <div className="nav-menu">{entry.items.map(renderItem)}</div>
                  )}
                </div>
              );
            })}

            <button
              className="theme-toggle"
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              aria-pressed={theme === "dark"}
              aria-label="Dark mode"
            >
              <span className="tt-icon" aria-hidden="true">
                {theme === "dark" ? (
                  <svg viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="4.2" />
                    <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24">
                    <path d="M20.5 14.6A8.6 8.6 0 1 1 9.4 3.5a6.9 6.9 0 0 0 11.1 11.1z" />
                  </svg>
                )}
              </span>
              <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
              <span className="toggle-track">
                <span className="toggle-thumb" />
              </span>
            </button>

            {/* Nothing until /auth/me answers: a Sign in button that turns
                into an email a moment later is worse than a beat of nothing. */}
            {user !== undefined &&
              (user && !user.guest ? (
                <div className="account-box">
                  <span className="account-email" title={user.email ?? undefined}>
                    {user.email}
                  </span>
                  <button className="nav-link account-out" onClick={signOut}>
                    Sign out
                  </button>
                </div>
              ) : (
                <button
                  className="btn account-in"
                  aria-current={view === "account"}
                  onClick={() => {
                    setAccountMode(student ? "signup" : "login");
                    go("account");
                  }}
                >
                  {student ? "Save my list" : "Sign in"}
                </button>
              ))}
          </nav>
        </div>
      </header>

      <main className="view">
        <div className="container">
          {/* One-off outcome of an action the user just took, dismissed by
              taking any other action rather than sitting there forever. */}
          {notice && view !== "account" && (
            <p className="banner" role="status">
              {notice}
              <button className="banner-x" aria-label="Dismiss" onClick={() => setNotice(null)}>
                ×
              </button>
            </p>
          )}

          {/* The guest nudge. Deliberately not a modal and not on every page
              load: it appears once there is real work to lose, and stays gone
              for the session once dismissed. */}
          {unsaved && savePrompt && view !== "account" && (
            <p className="banner save-prompt" role="status">
              <span>
                <strong>This list isn't saved yet.</strong> It lives in this browser only —
                an account keeps it on every device.
              </span>
              <button
                className="btn btn-sm save-prompt-go"
                onClick={() => {
                  setAccountMode("signup");
                  go("account");
                }}
              >
                Save it
              </button>
              <button
                className="banner-x"
                aria-label="Dismiss"
                onClick={() => setSavePrompt(false)}
              >
                ×
              </button>
            </p>
          )}

          {view === "account" && (
            <Account
              mode={accountMode}
              onMode={setAccountMode}
              guestProfile={unsaved ? student : null}
              onSignedIn={onSignedIn}
            />
          )}
          {view === "home" && <Home onStart={() => go(student ? "matches" : "profile")} hasProfile={!!student} />}
          {view === "profile" && (
            <ProfileForm meta={meta} existing={student} onSaved={onProfileSaved} />
          )}
          {view === "matches" && student && (
            <Recommendations
              student={student}
              onEdit={() => go("profile")}
              onAsk={() => go("chat")}
              compareIds={compareIds}
              onToggleCompare={(id) => setCompareIds((ids) => toggleCompare(ids, id))}
              onGoCompare={() => go("compare")}
              notes={notes}
            />
          )}
          {view === "matches" && !student && (
            <NeedsProfile onGo={() => go("profile")} />
          )}
          {view === "scholarships" && student && (
            <Scholarships
              student={student}
              onEdit={() => go("profile")}
              onAsk={() => go("chat")}
            />
          )}
          {view === "scholarships" && !student && <NeedsProfile onGo={() => go("profile")} />}
          {view === "compare" && (
            <SchoolCompare
              student={student}
              selected={compareIds}
              onChange={setCompareIds}
              onGoMatches={() => go("matches")}
              notes={notes}
            />
          )}
          {view === "saved" && student && (
            <SavedSchools
              student={student}
              notes={notes}
              onGoMatches={() => go("matches")}
              onGoExplore={() => go("explore")}
            />
          )}
          {view === "saved" && !student && <NeedsProfile onGo={() => go("profile")} />}
          {view === "tracker" && student && (
            <ApplicationTracker student={student} onGoMatches={() => go("matches")} notes={notes} />
          )}
          {view === "tracker" && !student && <NeedsProfile onGo={() => go("profile")} />}
          {view === "timeline" && (
            <ApplicationTimeline
              student={student}
              onGoTracker={() => go(student ? "tracker" : "profile")}
            />
          )}
          {view === "majors" && (
            <MajorDeepDive
              student={student}
              onAsk={(question) => {
                setPendingQuestion(question);
                go("chat");
              }}
            />
          )}
          {view === "explore" && <UniversityExplorer meta={meta} notes={student ? notes : null} />}
          {view === "chat" && (
            <ChatBot
              student={student}
              onBuildProfile={() => go("profile")}
              initialQuestion={pendingQuestion}
              onQuestionSent={() => setPendingQuestion(null)}
            />
          )}
        </div>
      </main>

      <footer className="footer no-print">
        <div className="container footer-inner">
          <span>
            <strong>Compass</strong> — a college-planning companion, not a substitute for your school counselor.
          </span>
          <span>Deadlines &amp; aid rules change — always confirm on official college sites.</span>
        </div>
      </footer>
    </div>
  );
}

function NeedsProfile({ onGo }: { onGo: () => void }) {
  return (
    <div className="empty">
      <h3>Build your profile first</h3>
      <p>Your matches are personalized to your GPA, coursework, interests, and budget. Tell us about yourself to see them.</p>
      <button className="btn btn-primary" onClick={onGo}>
        Build my profile <span className="btn-arrow">→</span>
      </button>
    </div>
  );
}
