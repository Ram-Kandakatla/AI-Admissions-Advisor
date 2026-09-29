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

// Eager: the first-visit path (Home, ProfileForm, 404). Everything else is
// lazy; each page fetches data on arrival anyway, so the chunk loads in that wait.
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
const AccountSettings = lazy(() => import("./components/AccountSettings"));
const SharedPlanView = lazy(() => import("./components/SharedPlanView"));

const Terms = lazy(() => import("./components/legal/Terms"));
const Privacy = lazy(() => import("./components/legal/Privacy"));
const CookiePolicy = lazy(() => import("./components/legal/CookiePolicy"));
const Security = lazy(() => import("./components/legal/Security"));

type Theme = "light" | "dark";

// The pre-paint script in index.html has already put the right theme on
// <html>; read it back rather than guessing, so the two never disagree.
const initialTheme = (): Theme =>
  (document.documentElement.getAttribute("data-theme") as Theme) ?? "light";

/** State that outlives any one page, plus the route map. */
export default function App() {
  const [student, setStudent] = useState<StudentRecord | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  // `undefined` = not asked yet, so returning visitors don't see a flash of "Sign in".
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  // Keeps a bookmarked /matches from saying "build your profile first" while loading.
  const [restoring, setRestoring] = useState(true);
  const [savePrompt, setSavePrompt] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  // Schools picked for side-by-side. Lifted here so ticking "Compare" on a
  // match card survives the trip to the comparison page.
  const [compareIds, setCompareIds] = useState<number[]>([]);

  const navigate = useNavigate();

  // Shared by five pages, so a star set on one shows on the others.
  const notes = useSchoolNotes(student?.id ?? null);

  useEffect(() => {
    api.meta().then(setMeta).catch(() => setMeta(null));
  }, []);

  // Restore the session and profile on load.
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
        // API unreachable: show the signed-out shell.
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
    // Re-show the save prompt: the guest now has something to lose.
    setSavePrompt(true);

    // A first save creates the guest account, so fetch who we are now.
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

  /** Not signOut(): the server already deleted the session, so logout would 401. */
  const onAccountDeleted = (hadProfile: boolean) => {
    setUser(null);
    setStudent(null);
    setCompareIds([]);
    setSavePrompt(true);
    setNotice(
      hadProfile
        ? "Your account is deleted. Your profile, notes, tracker, and conversations are gone, and any share link you created has stopped working."
        : "Your account is deleted. Nothing of yours is stored here any more."
    );
    navigate("/");
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

        {/* The auth pages, /account and the legal pages are all ungated: their
            visitors may have no session or no profile. */}
        <Route
          path="/account"
          element={
            <AccountSettings
              user={user}
              hasProfile={!!student}
              onDeleted={onAccountDeleted}
              // Refetch the user: 2FA status lives on the user record.
              onSecurityChanged={() => {
                api
                  .me()
                  .then(({ user: current }) => setUser(current))
                  .catch(() => {
                    /* the change landed; the badge can be stale until reload */
                  });
              }}
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
 * Syncs `?ids=` with App's compare state: the URL seeds the state once on
 * arrival, then the state writes the URL (with `replace`, to spare the back
 * button).
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
    // Once only: depending on the search string would react to our own writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeded]);

  useEffect(() => {
    if (!seeded) return;
    // Not URLSearchParams, which would encode the commas as %2C.
    const search = selected.length > 0 ? `?ids=${selected.join(",")}` : "";
    if (search !== location.search) {
      navigate({ pathname: location.pathname, search }, { replace: true });
    }
  }, [selected, seeded, navigate, location.pathname, location.search]);

  return <SchoolCompare student={student} selected={selected} onChange={onChange} notes={notes} />;
}

/**
 * Outside Layout and ungated, since viewers have no session, so it brings its
 * own <main> landmark, Suspense and ErrorBoundary.
 */
function SharedRoute() {
  const { token } = useParams();
  useEffect(() => {
    document.title = "A shared college plan — Compass";
  }, []);
  return (
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
 * A handed-off question travels in history state, not the URL, so it isn't
 * shared or logged by accident. The mode is in the URL (`?mode=essay`) because
 * it names a page, not user text; unknown values fall back to advising.
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
      // `replace` so toggling doesn't fill history; advising uses the bare URL.
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
