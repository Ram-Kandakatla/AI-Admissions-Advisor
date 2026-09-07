import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { api } from "./api";
import { toggleCompare } from "./compare";
import { slugifyMajor } from "./slug";
import { useSchoolNotes } from "./useSchoolNotes";
import type { AuthUser, ChatMode, Meta, StudentRecord } from "./types";
import Layout from "./components/Layout";
import Home from "./components/Home";
import ProfileForm from "./components/ProfileForm";
import NotFound from "./components/NotFound";
import ErrorBoundary from "./components/ErrorBoundary";

// ---- What ships in the first bundle, and what doesn't ----
//
// Eager: the chrome, Home, ProfileForm, and the 404. That is the whole of the
// path a first-time visitor walks — land, read the pitch, fill in the form —
// so splitting any of it would trade a smaller download for a spinner in the
// one place there is nothing yet to wait for.
//
// Lazy: everything else. Each of these pages is behind at least one click and
// starts by fetching something anyway, so the chunk arrives inside a wait the
// page was going to have regardless. The three the guide singles out —
// ChatBot, SchoolCompare, ApplicationTracker — are the heaviest, but the rest
// are split too: leaving a 6 kB page in the initial bundle to save it a
// request costs every visitor those 6 kB, including the ones who never open
// it.
const Recommendations = lazy(() => import("./components/Recommendations"));
const Scholarships = lazy(() => import("./components/Scholarships"));
const SavedSchools = lazy(() => import("./components/SavedSchools"));
const SchoolCompare = lazy(() => import("./components/SchoolCompare"));
const UniversityExplorer = lazy(() => import("./components/UniversityExplorer"));
const ChatBot = lazy(() => import("./components/ChatBot"));
const ApplicationTracker = lazy(() => import("./components/ApplicationTracker"));
const ApplicationTimeline = lazy(() => import("./components/ApplicationTimeline"));
const MajorDeepDive = lazy(() => import("./components/MajorDeepDive"));
const Account = lazy(() => import("./components/Account"));
const ShareSettings = lazy(() => import("./components/ShareSettings"));
const SharedPlanView = lazy(() => import("./components/SharedPlanView"));

// The legal and trust pages. Lazy like everything else behind a click, and
// grouped into one chunk each — they are text, they share a layout component,
// and a visitor who opens the privacy policy has already decided to read
// rather than to browse, so a request they never notice is the right cost.
const Terms = lazy(() => import("./components/legal/Terms"));
const Privacy = lazy(() => import("./components/legal/Privacy"));
const CookiePolicy = lazy(() => import("./components/legal/CookiePolicy"));
const Security = lazy(() => import("./components/legal/Security"));

type Theme = "light" | "dark";

// The pre-paint script in index.html has already put the right theme on
// <html>; read it back rather than guessing, so the two never disagree.
const initialTheme = (): Theme =>
  (document.documentElement.getAttribute("data-theme") as Theme) ?? "light";

/**
 * Everything the pages share, plus the route map.
 *
 * The chrome moved to Layout when the router landed; what's left here is the
 * state that outlives any one page — the profile, the session, the notes
 * store, the compare selection — and the table of which URL shows what.
 */
export default function App() {
  const [student, setStudent] = useState<StudentRecord | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  // Who the session says we are. `undefined` means "not asked yet", which is
  // distinct from "asked, nobody" — rendering a Sign in button during that gap
  // would flash the wrong state at every returning visitor on every load.
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  // True until the session and any profile behind it have finished loading.
  // Before the router this could not happen: you always arrived at Home and
  // clicked your way in, so by the time a profile page rendered the fetch was
  // long done. A bookmarked /matches renders immediately, and without this it
  // would show "Build your profile first" to someone who has one.
  const [restoring, setRestoring] = useState(true);
  const [savePrompt, setSavePrompt] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  // Schools picked for side-by-side. Lifted here so ticking "Compare" on a
  // match card survives the trip to the comparison page.
  const [compareIds, setCompareIds] = useState<number[]>([]);

  const navigate = useNavigate();

  // Notes and stars are shared by five pages, so they live here rather than
  // in any one of them — a star tapped on a match card has to be lit when the
  // explorer renders the same school a second later.
  const notes = useSchoolNotes(student?.id ?? null);

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
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
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

    navigate("/matches");
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
    navigate(record ? "/matches" : "/profile");
  };

  const signOut = async () => {
    await api.logout().catch(() => {
      /* the cookie is the session; a failed call leaves it in place */
    });
    setUser(null);
    setStudent(null);
    setCompareIds([]);
    setNotice(null);
    navigate("/");
  };

  // A guest with a profile has work that dies with this browser.
  const unsaved = user?.guest === true && student !== null;

  /** A page that needs a profile, once we know whether there is one. */
  const gated = (page: (s: StudentRecord) => JSX.Element) => {
    if (student) return page(student);
    return restoring ? <RestoringProfile /> : <NeedsProfile />;
  };

  return (
    <Routes>
      {/* Outside the Layout route on purpose. The person opening this has no
          account, no profile and no session, so the app's nav would offer them
          fourteen destinations they cannot use and a "Sign in" that implies
          this is theirs. It renders as its own page instead. */}
      <Route path="/shared/:token" element={<SharedRoute />} />

      <Route
        element={
          <Layout
            theme={theme}
            onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            user={user}
            student={student}
            notice={notice}
            onDismissNotice={() => setNotice(null)}
            savePrompt={savePrompt}
            onDismissSavePrompt={() => setSavePrompt(false)}
            onSignOut={signOut}
          />
        }
      >
        <Route path="/" element={<Home hasProfile={!!student} />} />

        <Route
          path="/profile"
          element={<ProfileForm meta={meta} existing={student} onSaved={onProfileSaved} />}
        />

        <Route
          path="/matches"
          element={gated((s) => (
            <Recommendations
              student={s}
              compareIds={compareIds}
              onToggleCompare={(id) => setCompareIds((ids) => toggleCompare(ids, id))}
              notes={notes}
            />
          ))}
        />

        <Route
          path="/scholarships"
          element={gated((s) => <Scholarships student={s} />)}
        />

        <Route path="/saved" element={gated((s) => <SavedSchools student={s} notes={notes} />)} />

        <Route
          path="/tracker"
          element={gated((s) => <ApplicationTracker student={s} notes={notes} />)}
        />

        <Route path="/timeline" element={<ApplicationTimeline student={student} />} />

        <Route path="/share" element={gated((s) => <ShareSettings student={s} />)} />

        <Route
          path="/compare"
          element={
            <CompareRoute student={student} selected={compareIds} onChange={setCompareIds} notes={notes} />
          }
        />

        {/* Both paths render the same page; the bare one redirects itself to
            the resolved major so every visit ends on a linkable URL. */}
        <Route path="/majors" element={<MajorsRoute student={student} />} />
        <Route path="/majors/:major" element={<MajorsRoute student={student} />} />

        <Route
          path="/explore"
          element={<UniversityExplorer meta={meta} notes={student ? notes : null} />}
        />

        <Route path="/chat" element={<ChatRoute student={student} />} />

        <Route
          path="/signin"
          element={
            <Account
              mode="login"
              guestProfile={unsaved ? student : null}
              onSignedIn={onSignedIn}
            />
          }
        />
        <Route
          path="/signup"
          element={
            <Account
              mode="signup"
              guestProfile={unsaved ? student : null}
              onSignedIn={onSignedIn}
            />
          }
        />

        {/* Ungated and outside every profile check, deliberately. A visitor
            deciding whether to trust Compass with a GPA reads these *before*
            there is anything to gate on, and a privacy policy you have to sign
            up to read is not a privacy policy. They are also the destinations
            a footer link has to reach from anywhere, including from the 404. */}
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/cookies" element={<CookiePolicy />} />
        <Route path="/security" element={<Security />} />

        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

/* ------------------------------------------------------- Route adapters */

/**
 * The comparison set, in the URL.
 *
 * `compareIds` stays App state because the ticks that build it happen on
 * /matches, where they have nowhere else to live. This bridges that state to
 * `?ids=` while the comparison page is open, in one direction each way: the
 * URL seeds the state once on arrival (so a shared link works), and after
 * that the state writes the URL (so the link stays current as you add and
 * remove schools). Writes are `replace` — twelve tick-throughs should not be
 * twelve presses of the back button.
 */
function CompareRoute({
  student,
  selected,
  onChange,
  notes,
}: {
  student: StudentRecord | null;
  selected: number[];
  onChange: (ids: number[]) => void;
  notes: ReturnType<typeof useSchoolNotes>;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (seeded) return;
    setSeeded(true);
    const fromUrl = (new URLSearchParams(location.search).get("ids") ?? "")
      .split(",")
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (fromUrl.length > 0) onChange(fromUrl);
    // Runs once, on arrival. The search string is deliberately not a
    // dependency: it changes on every write below, and reacting to our own
    // writes would put the URL back in charge and fight the user's next click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeded]);

  useEffect(() => {
    if (!seeded) return;
    // Built by hand rather than through URLSearchParams, which percent-encodes
    // the separator — "?ids=1%2C3" round-trips perfectly and looks like an
    // error to the person being sent it. A comma is legal in a query string.
    const search = selected.length > 0 ? `?ids=${selected.join(",")}` : "";
    if (search !== location.search) {
      navigate({ pathname: location.pathname, search }, { replace: true });
    }
  }, [selected, seeded, navigate, location.pathname, location.search]);

  return <SchoolCompare student={student} selected={selected} onChange={onChange} notes={notes} />;
}

/**
 * `/shared/:token` — the read-only view, for someone who is not the student.
 *
 * Chrome-free and gate-free by design: this page must render for a visitor
 * with no session at all, so it deliberately does not go through `gated()`.
 * Its own Suspense and ErrorBoundary, since it sits outside Layout's.
 */
function SharedRoute() {
  const { token } = useParams();
  useEffect(() => {
    document.title = "A shared college plan — Compass";
  }, []);
  return (
    // <main>, because this page renders outside Layout and so gets none of
    // its landmarks. Without it the whole document sits in no landmark at all,
    // which is a screen reader with no way to skip past anything.
    <main className="shared-page" id="main">
      <ErrorBoundary>
        <Suspense fallback={<div className="spinner" aria-label="Loading the shared plan" />}>
          <SharedPlanView token={token ?? ""} />
        </Suspense>
      </ErrorBoundary>
    </main>
  );
}

/** `/majors/:major` — the slug in, a navigation out. */
function MajorsRoute({ student }: { student: StudentRecord | null }) {
  const { major } = useParams();
  const navigate = useNavigate();

  const onSelectMajor = useCallback(
    (name: string, replace = false) => navigate(`/majors/${slugifyMajor(name)}`, { replace }),
    [navigate]
  );

  return (
    <MajorDeepDive
      student={student}
      majorSlug={major}
      onSelectMajor={onSelectMajor}
      onAsk={(question) => navigate("/chat", { state: { question } })}
    />
  );
}

/**
 * `/chat`, optionally carrying a question from the major deep dive.
 *
 * The handoff rides in history state rather than a query parameter. A question
 * is free text a student typed the app into asking on their behalf; putting it
 * in the address bar makes it something to share by accident and something a
 * proxy log keeps. History state is scoped to this tab's history entry and
 * never leaves the browser.
 *
 * The assistant *is* in the URL, though — `?mode=essay`. It names which of two
 * screens you are looking at rather than anything you typed, so it is exactly
 * the kind of state §5.1 put in the address bar: bookmarkable, shareable, and
 * survives a refresh. Unknown values fall back to advising rather than
 * erroring, since a mistyped query string should still show a usable page.
 */
function ChatRoute({ student }: { student: StudentRecord | null }) {
  const location = useLocation();
  const navigate = useNavigate();
  const question = (location.state as { question?: string } | null)?.question ?? null;

  const requested = new URLSearchParams(location.search).get("mode");
  const mode: ChatMode = requested === "essay" ? "essay" : "advising";

  return (
    <ChatBot
      student={student}
      mode={mode}
      // `replace`, so flipping the switch four times doesn't put four entries
      // between the student and the page they arrived from. Advising drops the
      // parameter entirely rather than writing ?mode=advising — the default
      // belongs at the bare URL.
      onModeChange={(next) =>
        navigate(
          { pathname: location.pathname, search: next === "essay" ? "?mode=essay" : "" },
          { replace: true, state: location.state }
        )
      }
      initialQuestion={question}
      // Drop it from the history entry once asked, or a refresh or a trip
      // back to this page would ask it again.
      onQuestionSent={() =>
        navigate(
          { pathname: location.pathname, search: location.search },
          { replace: true, state: null }
        )
      }
    />
  );
}

/* --------------------------------------------------------- Gate states */

function NeedsProfile() {
  return (
    <div className="empty">
      <h1>Build your profile first</h1>
      <p>Your matches are personalized to your GPA, coursework, interests, and budget. Tell us about yourself to see them.</p>
      <Link className="btn btn-primary" to="/profile">
        Build my profile <span className="btn-arrow">→</span>
      </Link>
    </div>
  );
}

/** The beat between a bookmarked URL rendering and the session answering. */
function RestoringProfile() {
  return <div className="spinner" aria-label="Loading your profile" />;
}
