import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { toggleCompare } from "./compare";
import type { Meta, StudentRecord } from "./types";
import Home from "./components/Home";
import ProfileForm from "./components/ProfileForm";
import Recommendations from "./components/Recommendations";
import Scholarships from "./components/Scholarships";
import SchoolCompare from "./components/SchoolCompare";
import UniversityExplorer from "./components/UniversityExplorer";
import ChatBot from "./components/ChatBot";
import ApplicationTracker from "./components/ApplicationTracker";
import ApplicationTimeline from "./components/ApplicationTimeline";
import MajorDeepDive from "./components/MajorDeepDive";
import BrandMark from "./components/BrandMark";

type View =
  | "home"
  | "profile"
  | "matches"
  | "scholarships"
  | "compare"
  | "tracker"
  | "timeline"
  | "majors"
  | "explore"
  | "chat";
type Theme = "light" | "dark";

interface NavItem {
  key: View;
  label: string;
  needsProfile?: boolean;
}

type NavEntry =
  | { kind: "link"; item: NavItem }
  | { kind: "group"; id: string; label: string; items: NavItem[] };

// Ten destinations is too many for one flat row, so the two that form a
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  // Schools picked for side-by-side. Lifted here so ticking "Compare" on a
  // match card survives the trip to the comparison page.
  const [compareIds, setCompareIds] = useState<number[]>([]);
  // A question handed to the chatbot from another page (the major deep dive
  // sends "tell me about X at Y"). Cleared once the chatbot has sent it.
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);

  const compact = useCompactNav();
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    api.meta().then(setMeta).catch(() => setMeta(null));
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
    go("matches");
  };

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
          </nav>
        </div>
      </header>

      <main className="view">
        <div className="container">
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
            />
          )}
          {view === "tracker" && student && (
            <ApplicationTracker student={student} onGoMatches={() => go("matches")} />
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
          {view === "explore" && <UniversityExplorer meta={meta} />}
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
