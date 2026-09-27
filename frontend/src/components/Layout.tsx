import { Suspense, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { titleFor } from "../titles";
import type { AuthUser, StudentRecord } from "../types";
import BrandMark from "./BrandMark";
import ErrorBoundary from "./ErrorBoundary";
import CookieNotice from "./CookieNotice";

type Theme = "light" | "dark";

interface NavItem {
  to: string;
  label: string;
  needsProfile?: boolean;
}

type NavEntry =
  | { kind: "link"; item: NavItem }
  | { kind: "group"; id: string; label: string; items: NavItem[] };

// Plan and Research collapse into menus; Home, Profile and Ask stay top level.
const NAV: NavEntry[] = [
  { kind: "link", item: { to: "/", label: "Home" } },
  { kind: "link", item: { to: "/profile", label: "Your Profile" } },
  {
    kind: "group",
    id: "plan",
    label: "Plan",
    items: [
      { to: "/matches", label: "Matches", needsProfile: true },
      { to: "/scholarships", label: "Scholarships", needsProfile: true },
      { to: "/saved", label: "Saved", needsProfile: true },
      { to: "/tracker", label: "Tracker", needsProfile: true },
      { to: "/timeline", label: "Timeline" },
      { to: "/share", label: "Share", needsProfile: true },
    ],
  },
  {
    kind: "group",
    id: "research",
    label: "Research",
    items: [
      { to: "/compare", label: "Compare" },
      { to: "/majors", label: "Majors" },
      { to: "/explore", label: "Explore" },
    ],
  },
  { kind: "link", item: { to: "/chat", label: "Ask Compass" } },
];

/** Below this, menus render as flat sections. Keep in sync with global.css. */
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

/** For highlighting a closed menu; matches whole path segments only. */
function isUnder(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** Header, nav, banners and footer around the routed page. */
export default function Layout({
  theme,
  onToggleTheme,
  user,
  student,
  notice,
  onDismissNotice,
  savePrompt,
  onDismissSavePrompt,
  onSignOut,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  user: AuthUser | null | undefined;
  student: StudentRecord | null;
  notice: string | null;
  onDismissNotice: () => void;
  savePrompt: boolean;
  onDismissSavePrompt: () => void;
  onSignOut: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const compact = useCompactNav();
  const navRef = useRef<HTMLElement>(null);
  const { pathname, search } = useLocation();
  const navigate = useNavigate();

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

  // Keyed on location so back/forward and typed URLs are covered too.
  useEffect(() => {
    document.title = titleFor(pathname, search);
  }, [pathname, search]);

  // On navigation, close menus and scroll to the top.
  useEffect(() => {
    setMenuOpen(false);
    setOpenGroup(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [pathname]);

  // A guest with a profile has work that dies with this browser. Everyone else
  // — signed in, or not started yet — has nothing to warn about.
  const unsaved = user?.guest === true && student !== null;
  // /verify counts: a "this list isn't saved yet" banner above the page that is
  // in the middle of saving it would be telling the person the opposite.
  const onAccountPage = pathname === "/signin" || pathname === "/signup" || pathname === "/verify";

  const renderItem = (item: NavItem) => {
    // Anchors have no disabled state, and faking one with pointer-events
    // leaves it keyboard-reachable. A destination that isn't ready yet stays
    // a button — it was never a link in the first place.
    if (item.needsProfile && !student) {
      return (
        <button key={item.to} className="nav-link" disabled title="Build your profile first">
          {item.label}
        </button>
      );
    }
    return (
      <NavLink key={item.to} to={item.to} end={item.to === "/"} className="nav-link">
        {item.label}
      </NavLink>
    );
  };

  return (
    <div className="app">
      {/* First thing in the tab order and invisible until it has focus: on the
          tracker, forty-odd nav and card controls sit between the top of the
          page and the content, and a keyboard user should not have to pass
          through them on every navigation. */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="header no-print">
        <div className="container header-inner">
          <NavLink to="/" className="brand" aria-label="Compass home">
            <BrandMark className="brand-mark" />
            <span className="brand-name">
              Com<b>pass</b>
            </span>
          </NavLink>

          <button
            className="nav-toggle"
            aria-label="Toggle menu"
            aria-expanded={menuOpen}
            aria-controls="site-nav"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span />
            <span />
            <span />
          </button>

          <nav
            className="nav"
            id="site-nav"
            aria-label="Main"
            data-open={menuOpen}
            ref={navRef}
          >
            {NAV.map((entry) => {
              if (entry.kind === "link") return renderItem(entry.item);

              const active = entry.items.some((i) => isUnder(pathname, i.to));

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
                    // Not aria-current: the button contains the page, it isn't the page.
                    data-current={active}
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
              onClick={onToggleTheme}
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
                  {/* The email is the account, so it is also the link to the
                      page about it — the convention everywhere else, and it
                      costs no room in a nav that has none to spare. */}
                  <NavLink
                    className="account-email"
                    to="/account"
                    title={user.email ?? undefined}
                  >
                    {user.email}
                  </NavLink>
                  <button className="nav-link account-out" onClick={onSignOut}>
                    Sign out
                  </button>
                </div>
              ) : (
                <NavLink className="btn account-in" to={student ? "/signup" : "/signin"}>
                  {student ? "Save my list" : "Sign in"}
                </NavLink>
              ))}
          </nav>
        </div>
      </header>

      <main className="view" id="main" tabIndex={-1}>
        <div className="container">
          {/* One-off outcome of an action the user just took, dismissed by
              taking any other action rather than sitting there forever. */}
          {notice && !onAccountPage && (
            <p className="banner" role="status">
              {notice}
              <button className="banner-x" aria-label="Dismiss" onClick={onDismissNotice}>
                ×
              </button>
            </p>
          )}

          {/* The guest nudge. Deliberately not a modal and not on every page
              load: it appears once there is real work to lose, and stays gone
              for the session once dismissed. */}
          {unsaved && savePrompt && !onAccountPage && (
            <p className="banner save-prompt" role="status">
              <span>
                <strong>This list isn't saved yet.</strong> It lives in this browser only —
                an account keeps it on every device.
              </span>
              <button
                className="btn btn-sm save-prompt-go"
                onClick={() => navigate("/signup")}
              >
                Save it
              </button>
              <button className="banner-x" aria-label="Dismiss" onClick={onDismissSavePrompt}>
                ×
              </button>
            </p>
          )}

          {/* Every page but Home and the profile form is a separate chunk, so
              the boundary goes here rather than around the whole app: the
              header, nav and footer are already on screen and stay there while
              the next page downloads. Wrapping <Routes> instead would blank
              the chrome on every navigation, which looks like a page load
              even when it is a 40 kB fetch off a warm cache.

              One boundary for all of them, not one per route. They share a
              fallback and none of them can be on screen at the same time, so
              twelve boundaries would be twelve copies of the same thing. */}
          {/* Inside the chrome, so a page that throws leaves the nav and the
              footer standing and the app stays navigable. Keyed on the
              pathname: clicking any other link clears the error, which is
              what someone will try first. */}
          <ErrorBoundary resetKey={pathname}>
            <Suspense fallback={<PageLoading />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>

      <footer className="footer no-print">
        <div className="container footer-inner">
          <span>
            <strong>Compass</strong> — a college-planning companion, not a substitute for your school counselor.
          </span>
          <span>Deadlines &amp; aid rules change — always confirm on official college sites.</span>

          {/* The legal row lives in the footer and nowhere else, on purpose.
              These four are destinations someone goes looking for — usually
              once, usually before deciding to type a GPA into the thing — and
              the footer is the first place anybody looks for them. Putting
              them in the nav would spend four of eleven top-level slots on
              pages nobody visits twice.

              Its own <nav> with a label rather than loose links: a screen
              reader user scanning landmarks should be able to find "Legal"
              without reading the disclaimer sentences above it first. */}
          <nav className="footer-legal" aria-label="Legal">
            <NavLink to="/terms">Terms</NavLink>
            <NavLink to="/privacy">Privacy</NavLink>
            <NavLink to="/cookies">Cookies</NavLink>
            <NavLink to="/security">Security</NavLink>
          </nav>
        </div>
      </footer>

      {/* Last in the document and outside every landmark above it, which is
          what keeps it out of the way: a keyboard user reaches it after the
          page content rather than before it, and it never sits between the
          nav and the thing they came for. It renders nothing at all once
          dismissed. */}
      <CookieNotice />
    </div>
  );
}

/** Delayed in CSS (`.spinner-delayed`) so a fast chunk load doesn't flicker. */
function PageLoading() {
  return <div className="spinner spinner-delayed" role="status" aria-label="Loading" />;
}
