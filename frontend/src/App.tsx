import { useEffect, useState } from "react";
import { api } from "./api";
import type { Meta, StudentRecord } from "./types";
import Home from "./components/Home";
import ProfileForm from "./components/ProfileForm";
import Recommendations from "./components/Recommendations";
import UniversityExplorer from "./components/UniversityExplorer";
import ChatBot from "./components/ChatBot";
import BrandMark from "./components/BrandMark";

type View = "home" | "profile" | "matches" | "explore" | "chat";

export default function App() {
  const [view, setView] = useState<View>("home");
  const [student, setStudent] = useState<StudentRecord | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    api.meta().then(setMeta).catch(() => setMeta(null));
  }, []);

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
          {view === "explore" && <UniversityExplorer meta={meta} />}
          {view === "chat" && <ChatBot student={student} onBuildProfile={() => go("profile")} />}
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
