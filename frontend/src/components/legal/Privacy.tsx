import { Link } from "react-router-dom";
import LegalPage, { Unfilled, type LegalSection } from "./LegalPage";
import { CONTACT_EMAIL, OPERATOR_NAME, REPO_URL } from "../../legal";

/**
 * Written from the code, so update it when these change: middleware/auth.ts
 * (cookie), log.ts and requestLog.ts (logs), llmService.ts and emailService.ts
 * (third parties), rateLimit.ts (IP use), studentProfile.ts and migrations/
 * (stored data), index.html (no off-origin requests).
 */
export default function Privacy() {
  const sections: LegalSection[] = [
    {
      id: "what-we-collect",
      title: "What Compass collects",
      body: (
        <>
          <p>
            Everything below is something you typed or something the app needed to work.
            There is no category of data here that was collected because it might be
            useful later.
          </p>
          <h3>Your profile</h3>
          <p>
            The fields on the profile form, and only those: the name you type, your GPA,
            your SAT and ACT scores if you enter them, the majors you pick, the activities
            you list, a free-text career goal, a broad financial-need band (high, medium,
            or low), and your preferred regions.
          </p>
          <p>
            The name field is whatever you put in it. Compass uses it to address you and
            never to identify you — a first name, a nickname, or two letters all work
            exactly as well, and nothing checks it against anything.
          </p>
          <h3>Your account</h3>
          <p>
            If you create one: an email address and a password. The password is never
            stored — what is stored is a PBKDF2-HMAC-SHA-256 hash of it with a random
            per-account salt, which cannot be reversed back into your password.
          </p>
          <p>
            Creating one starts with an email to that address. Until you open the link in
            it, the address and the password hash wait as an unconfirmed sign-up, which is
            deleted when you confirm — or after 24 hours, if you never do.
          </p>
          <p>
            You do not need an account to use Compass. Without one you get an anonymous
            session, which owns your work until the session expires.
          </p>
          <h3>What you write in the app</h3>
          <p>
            Your school notes, your application tracker entries and checklists, and your
            conversations with both the advisor and the essay assistant.
          </p>
          <h3>Technical data</h3>
          <p>
            One log line per request, holding the HTTP method, the{" "}
            <em>route pattern</em>, the response status, how long it took, and
            Cloudflare's request id. The pattern is the point: the log records{" "}
            <code>/api/students/:id</code> and never the actual id, so the operational
            record of the app carries no identifier for the student who generated it.
          </p>
          <p>
            Your IP address is visible to Cloudflare, which serves the app. Compass&apos;s
            own code uses it for one thing: rate limiting. Signing in or up, password
            resets, two-factor codes, deleting an account, starting a profile, and chat for
            anyone not signed in are each counted per address, so one machine cannot guess
            passwords or run up costs without limit. The counter stores a SHA-256 hash of
            the address, never the address itself, and the row is cleared once its
            fifteen-minute window has passed. Sign-up emails are capped the same way per
            email address: a hash of the address being signed up is counted for an hour, so
            nobody can use Compass to flood someone&apos;s inbox.
          </p>
        </>
      ),
    },
    {
      id: "not-collected",
      title: "What Compass deliberately does not collect",
      body: (
        <>
          <p>These are design decisions in the code, not promises about intent.</p>
          <ul className="legal-list">
            <li>
              <strong>No demographics.</strong> Compass never asks your race, ethnicity,
              gender, sexuality, religion, disability, or citizenship, and it never infers
              them. This has a visible consequence: scholarships restricted to a
              particular group are shown to everyone with the condition stated, and are
              capped at &ldquo;target&rdquo; rather than promoted to &ldquo;safety&rdquo;,
              because Compass will not rank an award on a fact about you it does not hold.
            </li>
            <li>
              <strong>No date of birth, address, phone number, or school name.</strong>
            </li>
            <li>
              <strong>No analytics and no advertising trackers.</strong> There is no
              Google Analytics, no Plausible, no PostHog, no Segment, no Meta pixel, and
              no error-reporting service. The app ships no third-party JavaScript at all.
            </li>
            <li>
              <strong>No cross-site tracking.</strong> Nothing in Compass follows you to
              another site, and nothing on another site can identify you here.
            </li>
            <li>
              <strong>No sale of data, ever.</strong> Compass does not sell, rent, or
              share personal information for money or for anything else of value, and has
              no advertising business that would create a reason to.
            </li>
          </ul>
          <p className="legal-check">
            You can verify most of this yourself: the source is public at{" "}
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
              {REPO_URL.replace("https://", "")}
            </a>
            , and your browser&apos;s network tab shows every request a page makes.
          </p>
        </>
      ),
    },
    {
      id: "why",
      title: "Why Compass holds each thing",
      body: (
        <>
          <ul className="legal-list">
            <li>
              <strong>Your profile</strong> — to compute your matches, your scholarship
              list, and the reach/target/safety reasoning attached to each. This is the
              product; without it there is nothing to show you.
            </li>
            <li>
              <strong>Your account</strong> — so your list survives a lost browser and
              follows you to a second device.
            </li>
            <li>
              <strong>Your notes and tracker</strong> — so they are there when you come
              back.
            </li>
            <li>
              <strong>Your chat history</strong> — so a conversation has context, and so
              the advisor is not meeting you fresh at every message.
            </li>
            <li>
              <strong>Request logs and the rate-limit counter</strong> — to keep the app
              working and to stop one client from exhausting a shared, paid resource.
            </li>
          </ul>
          <p>
            If you are in a jurisdiction that asks for a lawful basis under the GDPR:
            performance of the service you asked for, for everything you typed, and
            legitimate interest in keeping a free service available and not abused, for
            the logs and the rate limiter.
          </p>
        </>
      ),
    },
    {
      id: "ai",
      title: "What the AI sees, and who runs it",
      body: (
        <>
          <p>
            When you use the advisor or the essay assistant, Compass sends the model
            provider three things: the assistant&apos;s system instructions, the messages
            in that conversation, and a short context line summarising your profile so the
            answer is about your situation rather than a generic one.
          </p>
          <p>
            The provider is <strong>Anthropic</strong>, or <strong>OpenAI</strong> if the
            deployment is configured that way. Your message is processed under that
            provider&apos;s terms and privacy policy, which are theirs and not Compass&apos;s
            — read them if this matters to you. Your email address, your password, your
            account id, and your student id are <em>not</em> sent; the model is given a
            profile summary, not an identity.
          </p>
          <p>
            If no model key is configured, Compass answers from a built-in offline
            knowledge base instead and nothing leaves the server at all.
          </p>
          <p className="legal-warn">
            Treat the chat like a conversation in a school hallway, not like a sealed
            envelope. It is a good place to think through an essay and a bad place to put
            a medical diagnosis, an immigration status, a family financial document, or
            anything else you would not want a third company to process.
          </p>
        </>
      ),
    },
    {
      id: "sharing",
      title: "Who else can see your data",
      body: (
        <>
          <p>Four parties, and nobody else.</p>
          <ul className="legal-list">
            <li>
              <strong>Cloudflare</strong> — hosts the app, the API, and the D1 database
              your data lives in, and holds the request logs. Everything Compass stores is
              stored there.
            </li>
            <li>
              <strong>Anthropic or OpenAI</strong> — receives your chat messages and
              profile summary, as described above, and only when you use the chat.
            </li>
            <li>
              <strong>Resend</strong> — delivers Compass&apos;s emails: password-reset links,
              sign-up confirmation links, and the note sent when someone tries to sign up
              with an address that already has an account. It receives the address and that
              one message, only when one of those is requested for the address, and nothing
              else about your account or your plan.
            </li>
            <li>
              <strong>Anyone you hand a share link to.</strong> See below.
            </li>
          </ul>
          <p className="legal-check">
            <strong>Nothing else. Loading a page in Compass makes no request to any other
            company</strong> — no fonts from a CDN, no scripts, no images, no beacons. The
            typefaces are served from Compass&apos;s own origin precisely so that reading
            this page does not hand your IP address to someone you did not choose. Open
            your browser&apos;s network tab and check.
          </p>
          <p>
            Compass will also disclose data if a valid legal process requires it. Given
            what is here, that is a remote scenario; it is stated because pretending
            otherwise would be false.
          </p>
        </>
      ),
    },
    {
      id: "share-links",
      title: "Share links are public until you revoke them",
      body: (
        <>
          <p>
            If you create a share link, the URL <em>is</em> the password. There is no
            sign-in on the other end — anyone who has the link, including anyone it gets
            forwarded to, can read the plan it points at.
          </p>
          <p>
            A shared view shows your profile, matches, scholarships, tracked applications,
            saved schools, and school notes. It deliberately withholds your conversations
            with Compass, your email address, and your stated financial need.
          </p>
          <p>
            Revoking a link takes effect immediately and the old URL stops working for
            everyone. Rotating gives you a new URL and kills the old one in the same step.
            Neither can reach into a page someone already has open, or un-send a
            screenshot.
          </p>
        </>
      ),
    },
    {
      id: "cookies",
      title: "Cookies and browser storage",
      body: (
        <>
          <p>
            Compass sets one cookie, <code>__Host-compass_session</code>, which is what keeps you
            signed in. It is strictly necessary, so there is no consent banner asking you
            to approve something the app cannot work without and you cannot meaningfully
            decline. There are no advertising or analytics cookies to consent to, because
            there are none at all.
          </p>
          <p>
            The full inventory, including the two <code>localStorage</code> keys that
            remember your theme, is in the <Link to="/cookies">Cookie Policy</Link>.
          </p>
        </>
      ),
    },
    {
      id: "retention",
      title: "How long things are kept",
      body: (
        <>
          <ul className="legal-list">
            <li>
              <strong>Your profile, notes, tracker, and chat history</strong> — kept until
              you delete them or ask for the account to be deleted. They are not aged out
              on a timer, because a college list is a two-year project and silently
              expiring one would be worse than useless.
            </li>
            <li>
              <strong>Sessions</strong> — 30 days from creation, not extended by use. The
              row is deleted at sign-out, which is a real revocation rather than the
              browser politely forgetting a token that would still work.
            </li>
            <li>
              <strong>Rate-limit counters</strong> — swept once their window has passed:
              fifteen minutes, or an hour for the sign-up email cap.
            </li>
            <li>
              <strong>Counts of wrong two-factor codes</strong> — kept until a right code is
              entered, two-factor is switched off or set up again, or the account is deleted.
            </li>
            <li>
              <strong>Unconfirmed sign-ups</strong> — deleted when the emailed link is opened,
              or after 24 hours if it never is.
            </li>
            <li>
              <strong>Request logs</strong> — retained by Cloudflare under its own
              retention schedule. They contain no student identifier.
            </li>
            <li>
              <strong>Anonymous guest data</strong> — a profile built without an account is
              reachable only through that session&apos;s cookie. When the session expires,
              nothing can reach the row again, including you.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "your-choices",
      title: "Your choices and your rights",
      body: (
        <>
          <p>Things you can do right now, in the app:</p>
          <ul className="legal-list">
            <li>
              <strong>See everything Compass holds about you</strong> — it is all on screen.
              Your profile page, your matches, your saved schools, your tracker, and your
              chat history are the data, not a rendering of some larger hidden record.
            </li>
            <li>
              <strong>Correct anything</strong> — edit your profile; it overwrites in place.
            </li>
            <li>
              <strong>Export</strong> — your college list and saved schools download as CSV,
              and any page saves to PDF through your browser&apos;s print dialog.
            </li>
            <li>
              <strong>Delete individual things</strong> — notes, tracked applications, and
              share links each delete on their own.
            </li>
            <li>
              <strong>Use Compass without an account at all.</strong>
            </li>
            <li>
              <strong>Delete everything, yourself, right now.</strong>{" "}
              <Link to="/account">Your account page</Link> erases your profile, notes,
              tracker, both conversations, every share link, and every signed-in session —
              immediately and permanently. It is not a request that goes into a queue and
              there is no grace period: Compass keeps no backup it could restore you from.
              This works for a guest account too, which is the case that matters on a
              shared or library computer.
            </li>
          </ul>
          <p>
            If any of that fails or you would rather a person did it, email{" "}
            <Unfilled>{CONTACT_EMAIL}</Unfilled>.
          </p>
          <p>
            Depending on where you live — the EU or UK under the GDPR, California under the
            CCPA/CPRA, and a growing number of US states — you may have enforceable rights
            to access, correct, delete, port, or restrict the processing of your data, and
            to complain to a regulator. Compass tries to make the first four true for
            everyone regardless of address, because a right that depends on your postcode
            is a poor design for a product used by teenagers. There is no
            &ldquo;sale&rdquo; or &ldquo;sharing&rdquo; of personal information to opt out
            of, and no targeted advertising.
          </p>
        </>
      ),
    },
    {
      id: "children",
      title: "Students under 18, and under 13",
      body: (
        <>
          <p>
            Compass is built for high school students, so most of the people using it are
            minors. That is the intended audience, not an edge case.
          </p>
          <p>
            <strong>If you are under 13, please do not use Compass or create an account.</strong>{" "}
            Compass is not designed to obtain verifiable parental consent under the US
            Children&apos;s Online Privacy Protection Act, and cannot lawfully collect
            personal information from children under 13 without it. If a parent or guardian
            believes a child under 13 has entered information here, email{" "}
            <Unfilled>{CONTACT_EMAIL}</Unfilled> and it will be deleted.
          </p>
          <p>
            <strong>If you are 13 to 17</strong>, you are welcome here, and you should tell
            a parent or guardian you are using it. The profile is deliberately shallow for
            this reason — no address, no birthday, no school — so that the worst case if
            something went wrong is a GPA and a list of colleges, not an identity.
          </p>
          <p>
            <strong>If you are a parent or guardian</strong>, you can ask to see, correct,
            or delete your child&apos;s data at the address above. A student can also just
            show you: a share link gives you a read-only view of the whole plan.
          </p>
          <p>
            Compass is not a school-operated service and is not acting as a school
            official, so student records here are not education records under FERPA. If
            your school district is considering adopting it, that changes and it should be
            reviewed accordingly.
          </p>
        </>
      ),
    },
    {
      id: "security",
      title: "How your data is protected",
      body: (
        <>
          <p>
            Sessions are server-side rows behind an <code>httpOnly</code>,{" "}
            <code>SameSite=Lax</code> cookie that JavaScript cannot read; passwords are
            PBKDF2-hashed with a per-account salt; every route that touches student data
            checks ownership on a single code path; request bodies are capped; and the
            logs are written so that no student identifier can reach them.
          </p>
          <p>
            The full picture, including the limitations Compass currently has, is on the{" "}
            <Link to="/security">Security page</Link> — along with how to report a
            vulnerability.
          </p>
        </>
      ),
    },
    {
      id: "international",
      title: "Where your data is",
      body: (
        <p>
          Compass runs on Cloudflare&apos;s network and stores data in Cloudflare D1. Model
          requests go to Anthropic or OpenAI, both US companies. If you are outside the
          United States, using Compass means your data is processed there and in whatever
          regions those providers operate.
        </p>
      ),
    },
    {
      id: "changes",
      title: "Changes to this policy",
      body: (
        <p>
          If this policy changes in a way that affects what Compass collects or who it goes
          to, the date at the top changes and the change will be visible in the
          project&apos;s public commit history — which is a stronger record than a
          notification, because you can read exactly what was altered and when. Continuing
          to use Compass after a change means the updated policy applies.
        </p>
      ),
    },
    {
      id: "contact",
      title: "Contact",
      body: (
        <>
          <p>
            Privacy questions, data requests, and anything a parent wants to ask go to{" "}
            <Unfilled>{CONTACT_EMAIL}</Unfilled>. Compass is operated by{" "}
            <Unfilled>{OPERATOR_NAME}</Unfilled> as a personal, non-commercial project.
          </p>
          <p>
            Security vulnerabilities go somewhere else on purpose — see the{" "}
            <Link to="/security">Security page</Link>.
          </p>
        </>
      ),
    },
  ];

  return (
    <LegalPage
      eyebrow="Privacy"
      title="What Compass knows about you"
      lead="Compass is a college-planning tool used mostly by minors, so this policy is written to be read rather than to be defensible. It says exactly what is collected, exactly who else sees it, and exactly how to delete all of it."
      sections={sections}
      summary={
        <ul className="legal-tldr">
          <li>
            Compass stores what you type — your profile, notes, tracker, and chats — and
            almost nothing else.
          </li>
          <li>
            <strong>No analytics, no advertising trackers, no third-party scripts.</strong>{" "}
            One cookie, and it is the one that keeps you signed in.
          </li>
          <li>
            <strong>Your data is never sold or shared for value.</strong> There is no
            advertising business here to create a reason to.
          </li>
          <li>
            Your chat messages and a summary of your profile go to Anthropic (or OpenAI) to
            generate a reply. Your email and account never do.
          </li>
          <li>
            Compass never asks your race, gender, sexuality, religion, address, birthday, or
            school — and never infers them.
          </li>
          <li>
            <strong>No third-party requests at all</strong> — the fonts are served from
            here, not from Google&apos;s CDN.
          </li>
          <li>
            <strong>You can delete all of it yourself, in one place</strong> — permanently,
            with no waiting period.
          </li>
        </ul>
      }
      footer={
        <p className="legal-note">
          This policy describes a real system and was written against its source code. If
          you find a place where the app and this page disagree, that is a bug in one of
          them —{" "}
          <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
            report it
          </a>
          .
        </p>
      }
    />
  );
}
