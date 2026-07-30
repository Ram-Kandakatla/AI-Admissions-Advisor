export default function Home({ onStart, hasProfile }: { onStart: () => void; hasProfile: boolean }) {
  return (
    <div>
      <section className="hero">
        <div className="hero-grid">
          <div>
            <span className="eyebrow">Your college list, thought through</span>
            <h1>
              Every application season feels like guesswork. <em>It shouldn&apos;t.</em>
            </h1>
            <p className="lead">
              Compass turns your grades, coursework, and ambitions into a balanced list of reach,
              target, and safety schools — and answers the admissions and financial-aid questions
              you were afraid to ask.
            </p>
            <div className="hero-actions">
              <button className="btn btn-primary" onClick={onStart}>
                {hasProfile ? "See my matches" : "Build my college list"} <span className="btn-arrow">→</span>
              </button>
              <span className="hero-note">Free · No account · 2 minutes</span>
            </div>
          </div>

          <div className="list-preview" aria-hidden="true">
            <div className="list-card">
              <div>
                <div className="lc-tier">Reach</div>
                <div className="lc-name">Carnegie Mellon</div>
              </div>
              <div className="lc-score">71</div>
            </div>
            <div className="list-card">
              <div>
                <div className="lc-tier">Target</div>
                <div className="lc-name">Georgia Tech</div>
              </div>
              <div className="lc-score">88</div>
            </div>
            <div className="list-card">
              <div>
                <div className="lc-tier">Safety</div>
                <div className="lc-name">Purdue</div>
              </div>
              <div className="lc-score">92</div>
            </div>
          </div>
        </div>
      </section>

      <section className="view" style={{ paddingBottom: 0 }}>
        <div className="view-head" style={{ marginBottom: 8 }}>
          <span className="eyebrow">How it works</span>
          <h2 className="section-title" style={{ marginTop: 14 }}>
            Three steps from &ldquo;where do I even start&rdquo; to a real plan.
          </h2>
        </div>

        <div className="features">
          <div className="feature">
            <div className="feature-num">Step 01</div>
            <h3>Tell us your story</h3>
            <p>
              GPA, test scores, the classes and activities you care about, intended majors, and what
              you can afford. No essays required yet.
            </p>
          </div>
          <div className="feature">
            <div className="feature-num">Step 02</div>
            <h3>Get a balanced list</h3>
            <p>
              We sort real universities into reach, target, and safety — each with a match score and
              plain-English reasons for why it fits you.
            </p>
          </div>
          <div className="feature">
            <div className="feature-num">Step 03</div>
            <h3>Ask anything</h3>
            <p>
              Deadlines, the FAFSA, essay openers, whether to submit your SAT — Compass answers with
              your profile in mind, any time.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
