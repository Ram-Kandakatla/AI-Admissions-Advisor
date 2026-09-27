import { Link } from "react-router-dom";
import LegalPage, { Unfilled, type LegalSection } from "./LegalPage";
import {
  CONTACT_EMAIL,
  formatLegalDate,
  GOVERNING_LAW,
  LEGAL_EFFECTIVE,
  OPERATOR_NAME,
  REPO_URL,
} from "../../legal";

/**
 * The sections that matter are §3 (what Compass is not) and §6 (the AI can be
 * wrong). Disclaimers name specific things a student might rely on, since a
 * generic "as-is" clause reads as noise.
 */
export default function Terms() {
  const sections: LegalSection[] = [
    {
      id: "agreement",
      title: "The agreement",
      body: (
        <>
          <p>
            Compass is a free college-planning tool operated by{" "}
            <Unfilled>{OPERATOR_NAME}</Unfilled> as a personal, non-commercial project. It
            is not a company, not a school, not a counselling service, and not a business.
          </p>
          <p>
            Using Compass means you accept these terms. If you do not, the remedy is
            simple and complete: stop using it. Nothing is charged and nothing is owed
            either way.
          </p>
          <p>
            These terms take effect{" "}
            <time dateTime={LEGAL_EFFECTIVE}>{formatLegalDate(LEGAL_EFFECTIVE)}</time>.
          </p>
        </>
      ),
    },
    {
      id: "who-may-use",
      title: "Who may use Compass",
      body: (
        <>
          <p>
            Compass is built for high school students, which means it is built for minors.
            You may use it if you are 13 or older.
          </p>
          <p>
            <strong>If you are under 13, you may not use Compass</strong> — not as a
            judgement about you, but because it is not built to obtain the verifiable
            parental consent that US law requires before collecting personal information
            from a child that age. See the{" "}
            <Link to="/privacy#children">Privacy Policy</Link>.
          </p>
          <p>
            If you are under 18, you should tell a parent or guardian that you are using
            Compass, and they are entitled to see everything in your account.
          </p>
          <p>
            If a parent, guardian, counselor, or teacher agrees to these terms on behalf of
            a student, they are agreeing for both of them.
          </p>
        </>
      ),
    },
    {
      id: "what-compass-is",
      title: "What Compass is, and what it is not",
      body: (
        <>
          <p>
            Compass takes what you tell it about your grades, coursework, and interests and
            produces a balanced list of reach, target, and safety schools, plus
            scholarships, deadlines, and answers to admissions questions. It is a way to
            organise a decision and to see options you had not thought of.
          </p>
          <p className="legal-warn">
            <strong>
              Compass is not a substitute for your school counselor, and it does not
              predict admissions decisions.
            </strong>{" "}
            It has no relationship with any college, no access to any admissions office,
            and no knowledge of anything about you that you did not type into it.
          </p>
          <p>Specifically, and these are the ones that matter:</p>
          <ul className="legal-list">
            <li>
              <strong>A match score is not a probability.</strong> It is a comparison
              between your stated profile and published institutional statistics.
              Admissions committees read essays, recommendations, context, and institutional
              priorities that no number here can see. A &ldquo;safety&rdquo; school can
              reject you and a &ldquo;reach&rdquo; can admit you.
            </li>
            <li>
              <strong>Deadlines shown in Compass are conventions, not calendars.</strong>{" "}
              Where a date is typical rather than confirmed, the app labels it as such —
              and even a confirmed one can move. The college&apos;s own admissions page is
              the only authority. Missing a deadline because Compass said November 1 is not
              something Compass can fix.
            </li>
            <li>
              <strong>Scholarship listings are a hand-curated snapshot</strong> of national
              awards, not a live feed. Amounts, deadlines, and eligibility change. Confirm
              every one with the sponsor before you rely on it.
            </li>
            <li>
              <strong>Financial figures are sticker prices and averages</strong>, not an
              offer, a quote, or an estimate of what you will actually pay. Aid rules change
              constantly, FAFSA above all.
            </li>
            <li>
              <strong>Compass gives no legal, financial, immigration, or tax advice</strong>,
              and nothing here is a professional opinion of any kind.
            </li>
          </ul>
          <p>
            Confirm anything that matters against the college&apos;s own site and with a
            human who knows you. That is the whole of the advice this section is trying to
            give.
          </p>
        </>
      ),
    },
    {
      id: "accounts",
      title: "Accounts, and lists without one",
      body: (
        <>
          <p>
            You can use Compass without an account. That work lives in an anonymous session
            tied to your browser, and when the session expires it becomes unreachable — by
            anyone, including you. The app warns you about this; it is the trade you make
            for not signing up.
          </p>
          <p>
            If you do create an account, keep the password to yourself and do not let anyone
            else use it. If you think someone has, change it. Anything done through your
            account is treated as done by you.
          </p>
          <p>
            Give a real email address you can actually receive mail at. The account is only
            created once you open the link sent to it, and after that it is the only way to
            reach you about your account — there is no other recovery path.
          </p>
        </>
      ),
    },
    {
      id: "your-content",
      title: "What you write stays yours",
      body: (
        <>
          <p>
            Your profile, your notes, your essays, your questions, and everything else you
            put into Compass belong to you. No ownership is claimed, no licence is taken to
            republish it, and none of it is used to train any model.
          </p>
          <p>
            The only permission Compass takes is the obvious one: to store your content and
            show it back to you, and to send your chat messages to the model provider so
            that a reply can be generated. See{" "}
            <Link to="/privacy#ai">the Privacy Policy</Link> for exactly what that means.
          </p>
          <p>
            If you create a share link, you are choosing to publish that plan to whoever
            holds the URL. That is your decision to make and yours to revoke.
          </p>
        </>
      ),
    },
    {
      id: "ai-output",
      title: "The AI can be wrong",
      body: (
        <>
          <p>
            The advisor and the essay assistant are large language models. They are useful
            and they are also confidently wrong sometimes — about a deadline, a requirement,
            a statistic, a scholarship, or a fact about a school. This is a property of the
            technology, not a bug that is about to be fixed.
          </p>
          <p className="legal-warn">
            <strong>Verify anything you would act on.</strong> If Compass tells you a school
            requires two recommendation letters, check the school&apos;s site before you ask
            for two.
          </p>
          <p>
            The essay assistant is built to help you think — prompts, angles, structure,
            questions about your own experience. It is not there to write your essay, and an
            essay written by a model is both a bad essay and, at most colleges, an integrity
            violation you would be answering for rather than Compass. Application
            integrity rules are between you and the college; using an AI tool does not
            change them and Compass cannot make them not apply.
          </p>
        </>
      ),
    },
    {
      id: "acceptable-use",
      title: "Acceptable use",
      body: (
        <>
          <p>Do not:</p>
          <ul className="legal-list">
            <li>
              Use Compass to break the law, or to harass, impersonate, or endanger anyone.
            </li>
            <li>
              Enter another person&apos;s personal information without their permission.
            </li>
            <li>
              Try to get at accounts, data, or parts of the system that are not yours. If
              you are looking for vulnerabilities in good faith, the{" "}
              <Link to="/security">Security page</Link> tells you how to do that with
              permission — which is a genuinely open invitation, not a formality.
            </li>
            <li>
              Attack the service: no denial of service, no scraping at volume, no working
              around the rate limits, no automated bulk requests. The limits exist because
              model calls cost real money paid by a person, not a company.
            </li>
            <li>Resell Compass or pass it off as your own service.</li>
            <li>
              Use the AI to generate anything a college would consider academic dishonesty
              if you submitted it.
            </li>
          </ul>
          <p>
            Compass is open source under the licence in its repository. That licence governs
            what you may do with the <em>code</em>; this section governs what you may do
            with the <em>hosted service</em>. They are different things.
          </p>
        </>
      ),
    },
    {
      id: "availability",
      title: "Availability, changes, and ending it",
      body: (
        <>
          <p>
            Compass is free and offered with no promise that it will be up, that it will
            keep working the way it does now, or that it will exist next year. Features can
            change or be removed. A personal project can also simply stop.
          </p>
          <p>
            Because of that, <strong>keep your own copy of anything you would miss.</strong>{" "}
            Compass exports your list and saved schools to CSV and any page to PDF,
            deliberately, for exactly this reason.
          </p>
          <p>
            Access can be suspended for anyone who breaks the acceptable-use rules above. You
            can stop at any time, and can ask for your account and everything in it to be
            deleted on <Link to="/account">your account page</Link>, which does it
            immediately rather than putting it in a queue.
          </p>
        </>
      ),
    },
    {
      id: "third-parties",
      title: "Links and third parties",
      body: (
        <p>
          Compass links to college admissions pages, scholarship sponsors, the FAFSA, and
          other outside sites. Those are not run by Compass, are not endorsed by it, and
          have their own terms and privacy practices. What is on the other side of a link is
          the responsibility of whoever put it there.
        </p>
      ),
    },
    {
      id: "warranty",
      title: "No warranty",
      body: (
        <p>
          Compass is provided <strong>&ldquo;as is&rdquo; and &ldquo;as available&rdquo;</strong>
          , without warranties of any kind, express or implied — including any implied
          warranty of merchantability, fitness for a particular purpose, accuracy, or
          non-infringement. No promise is made that Compass will be uninterrupted, secure,
          error-free, or that anything it tells you is correct. Some jurisdictions do not
          allow these exclusions, in which case they apply to you only as far as the law
          allows.
        </p>
      ),
    },
    {
      id: "liability",
      title: "Limitation of liability",
      body: (
        <>
          <p>
            To the fullest extent the law allows, <Unfilled>{OPERATOR_NAME}</Unfilled> is not
            liable for indirect, incidental, special, consequential, or punitive damages
            arising out of your use of Compass — including a missed deadline, a rejected
            application, a scholarship you did not get, lost data, or a decision you made
            based on something Compass told you.
          </p>
          <p>
            Because Compass is free, total liability for any claim is limited to the amount
            you paid to use it, which is nothing. Where a jurisdiction does not permit that
            limitation, liability is limited to the smallest amount that jurisdiction allows.
          </p>
          <p>
            Nothing here tries to exclude liability that cannot lawfully be excluded — such
            as for fraud, or for death or personal injury caused by negligence.
          </p>
        </>
      ),
    },
    {
      id: "governing-law",
      title: "Governing law",
      body: (
        <p>
          These terms are governed by the laws of <Unfilled>{GOVERNING_LAW}</Unfilled>,
          without regard to its conflict-of-law rules, and any dispute belongs in the courts
          located there. If you are a consumer in a place whose law gives you the right to
          bring a claim locally, this clause does not take that right away.
        </p>
      ),
    },
    {
      id: "changes",
      title: "Changes to these terms",
      body: (
        <p>
          These terms can change. When they do, the date at the top changes, and — because
          Compass is open source — the exact edit is visible in the{" "}
          <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
            public commit history
          </a>
          . Continuing to use Compass after a change means you accept it. If a change is one
          you do not accept, stop using the service and{" "}
          <Link to="/account">delete your data</Link>.
        </p>
      ),
    },
    {
      id: "contact",
      title: "Contact",
      body: (
        <p>
          Questions about these terms go to <Unfilled>{CONTACT_EMAIL}</Unfilled>. Security
          reports go to the <Link to="/security">Security page</Link> instead.
        </p>
      ),
    },
  ];

  return (
    <LegalPage
      eyebrow="Terms"
      title="Terms of Service"
      lead="Compass is free, run by one person, and used mostly by teenagers. These terms are written to be read by them — short sentences, no defined terms, and the parts that actually matter said plainly rather than buried in capital letters."
      sections={sections}
      summary={
        <ul className="legal-tldr">
          <li>Compass is free, personal, and non-commercial. Nothing is charged.</li>
          <li>
            <strong>It is not a substitute for your school counselor</strong>, and it cannot
            predict whether you will get in.
          </li>
          <li>
            <strong>The AI is sometimes wrong.</strong> Verify deadlines, requirements, and
            costs on the college&apos;s own site before you act on them.
          </li>
          <li>What you write stays yours. It is not used to train any model.</li>
          <li>
            Don&apos;t attack the service or submit AI-written work as your own — that last
            one is between you and the college, and Compass can&apos;t shield you from it.
          </li>
          <li>
            <strong>Export anything you would miss.</strong> A personal project can stop.
          </li>
        </ul>
      }
    />
  );
}
