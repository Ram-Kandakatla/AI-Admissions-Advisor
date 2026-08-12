import { useEffect, useState } from "react";
import { api } from "./api";
import type { Meta, StudentRecord } from "./types";
import Home from "./components/Home";
import ProfileForm from "./components/ProfileForm";
import Recommendations from "./components/Recommendations";
import UniversityExplorer from "./components/UniversityExplorer";
import ChatBot from "./components/ChatBot";
import ApplicationTracker from "./components/ApplicationTracker";
import MajorDeepDive from "./components/MajorDeepDive";
import BrandMark from "./components/BrandMark";

type View = "home" | "profile" | "matches" | "tracker" | "majors" | "explore" | "chat";
type Theme = "light" | "dark";

// The pre-paint script in index.html has already put the right theme on
// <html>; read it back rather than guessing, so the two never disagree.
const initialTheme = (): Theme =>
  (document.documentElement.getAttribute("data-theme") as Theme) ?? "light";

export default function App() {
  const [view, setView] = useState<View>("home");
  const [student, setStudent] = useState<StudentRecord | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  // A question handed to the chatbot from another page (the major deep dive
  // sends "tell me about X at Y"). Cleared once the chatbot has sent it.
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);

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

  const go = (v: View) => {
    setView(v);
    setMenuOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const onProfileSaved = (record: StudentRecord) => {
    setStudent(record);
    go("matches");
  };

  const navItems: { key: View; label: string; needsProfile?: boolean }[] = [
    { key: "home", label: "Home" },
    { key: "profile", label: "Your Profile" },
    { key: "matches", label: "Matches", needsProfile: true },
    { key: "tracker", label: "Tracker", needsProfile: true },
    { key: "majors", label: "Majors" },
    { key: "explore", label: "Explore" },
    { key: "chat", label: "Ask Compass" },
  ];

  return (
    <div className="app">
      <header className="header">
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

          <nav className="nav" data-open={menuOpen}>
            {navItems.map((item) => (
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
            ))}

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
            <Recommendations student={student} onEdit={() => go("profile")} onAsk={() => go("chat")} />
          )}
          {view === "matches" && !student && (
            <NeedsProfile onGo={() => go("profile")} />
          )}
          {view === "tracker" && student && (
            <ApplicationTracker student={student} onGoMatches={() => go("matches")} />
          )}
          {view === "tracker" && !student && <NeedsProfile onGo={() => go("profile")} />}
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

      <footer className="footer">
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
