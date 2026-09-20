import { Link } from "react-router-dom";
import LegalPage, { LegalTable, Unfilled, type LegalSection } from "./LegalPage";
import { CONTACT_EMAIL, REPO_URL, SECURITY_ADVISORY_URL } from "../../legal";

/**
 * The security / trust page: how to report a vulnerability, and what Compass
 * actually does to protect a student's data.
 *
 * WHY THE "KNOWN LIMITATIONS" SECTION EXISTS
 *
 * It is the section a trust page normally does not have, and it is the reason
 * to believe the rest of the page. Anyone can write "we take security
 * seriously"; the sentence carries no information because no product would ever
 * write the negation. A list of the things that are genuinely not done yet —
 * no self-serve account deletion, no 2FA, no independent audit, share links
 * that are bearer tokens — is checkable, and it is the part a researcher reads
 * first to decide whether the operator is worth talking to.
 *
 * WHY REPORTING GOES TO GITHUB RATHER THAN AN EMAIL ADDRESS
 *
 * See the note on SECURITY_ADVISORY_URL in src/legal.ts. Short version: no
 * inbox to harvest, a disclosure workflow attached, and it cannot rot the way a
 * personal address does.
 *
 * WHY THE SAFE HARBOUR IS WRITTEN AS A PROMISE, NOT A POLICY
 *
 * The thing that stops good-faith reports is not the absence of a form, it is
 * the fear of the CFAA and its equivalents. A researcher deciding whether to
 * poke at an app is asking one question — will this person call a lawyer — and
 * the only useful answer is an unambiguous no, stated in the first person and
 * before the rules rather than after them.
 *
 * Every defensive claim below names the file that implements it, so this page
 * can be re-verified rather than re-trusted.
 */
export default function Security() {
  const sections: LegalSection[] = [
    {
      id: "report",
      title: "Reporting a vulnerability",
      body: (
        <>
          <p>
            If you have found something, please report it — and thank you. Compass holds
            teenagers&apos; academic profiles, so a report here is worth more than the same
            report on most side projects.
          </p>
          <p className="legal-cta-row">
            <a
              className="btn btn-primary"
              href={SECURITY_ADVISORY_URL}
              target="_blank"
              rel="noreferrer noopener"
            >
              Report privately on GitHub <span className="btn-arrow">→</span>
            </a>
          </p>
          <p>
            That link opens GitHub&apos;s private vulnerability reporting on the Compass
            repository. The report is visible only to the maintainer until a fix ships, and
            it comes with a private branch and a coordinated-disclosure workflow already
            attached. If GitHub is not available to you, email{" "}
            <Unfilled>{CONTACT_EMAIL}</Unfilled> with &ldquo;security&rdquo; in the subject.
          </p>
          <p>A report is most useful when it has:</p>
          <ul className="legal-list">
            <li>What the issue is, and the impact you think it has.</li>
            <li>Steps to reproduce it — a request, a URL, a short script.</li>
            <li>Which environment you found it on, and roughly when.</li>
            <li>Anything you would want asked back.</li>
          </ul>
          <p className="legal-warn">
            Please report privately first. A public issue, a tweet, or a blog post before a
            fix exists puts every student using Compass at risk during the window in
            between — which is the one outcome nobody involved wants.
          </p>
        </>
      ),
    },
    {
      id: "safe-harbour",
      title: "Safe harbour — you will not be sued for this",
      body: (
        <>
          <p>
            Research done in good faith under the rules below is <strong>authorised</strong>.
            No legal action will be pursued, no law enforcement referral made, and no
            complaint filed with your employer or university over it. If a third party
            brings action against you for research that stayed inside this page, Compass
            will make it known that it was authorised.
          </p>
          <p>
            If you are partway through and unsure whether something is in scope, stop and
            ask first. Asking is always the safe move and will never be held against you.
          </p>
          <p>
            This is an authorisation to test, not a bug bounty. Compass is a free personal
            project with no revenue, so there is no money to offer. What is offered instead:
            a real reply from a person, credit in the advisory and the release notes if you
            want it, and a fix.
          </p>
        </>
      ),
    },
    {
      id: "scope",
      title: "Scope",
      body: (
        <>
          <LegalTable
            caption="What is in and out of scope for security testing"
            head={["", "What"]}
            rows={[
              [
                <span key="in" className="legal-yes">
                  In scope
                </span>,
                <>
                  The Compass web app and its API; authentication, sessions, and the
                  password flow; ownership and access-control checks between accounts; share
                  links; the chat endpoints, including prompt injection with real
                  consequences; stored or reflected XSS, CSRF, SSRF, and injection of any
                  kind; anything that discloses one student&apos;s data to another.
                </>,
              ],
              [
                <span key="out" className="legal-no">
                  Out of scope
                </span>,
                <>
                  Denial of service, load testing, and traffic floods; social engineering,
                  phishing, or physical attacks against anyone; findings against Cloudflare,
                  GitHub, Anthropic, or OpenAI themselves — report those to them; automated
                  scanner output with no demonstrated impact; missing headers or a
                  best-practice checklist item with no exploit path; and anything requiring
                  a fully compromised device or a browser the vendor no longer supports.
                </>,
              ],
            ]}
          />
          <p>The rules, and there are only four:</p>
          <ul className="legal-list">
            <li>
              <strong>Use your own account and your own test data.</strong> Make a second
              account if you need two.
            </li>
            <li>
              <strong>Never access, modify, save, or keep another person&apos;s data.</strong>{" "}
              If you can prove an access-control flaw with a status code, stop at the status
              code. If you do see someone&apos;s data by accident, stop, do not save it, and
              say so in the report.
            </li>
            <li>
              <strong>Do not degrade the service.</strong> No floods, no destructive
              payloads, no deleting other people&apos;s records.
            </li>
            <li>
              <strong>Give a fix a reasonable window</strong> before publishing — 90 days is
              the usual number and is fine here, and if it is fixed sooner you are welcome
              to publish sooner.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "response",
      title: "What happens after you report",
      body: (
        <>
          <p>
            Compass is maintained by one person, so these are honest intentions rather than
            a contractual SLA — which is exactly why they are written as targets and not as
            guarantees.
          </p>
          <LegalTable
            caption="Expected response times"
            head={["Stage", "Target"]}
            rows={[
              ["Acknowledged", "Within 3 business days"],
              ["Triaged, with an initial assessment", "Within 7 days"],
              [
                "Fixed",
                "Critical and high within 30 days; anything lower on the next reasonable release",
              ],
              ["Advisory published, with credit if you want it", "Once the fix is live"],
            ]}
          />
          <p>
            You will be told what was decided either way, including if the answer is that
            something is working as intended — a report that gets no reply is how a
            researcher learns not to bother next time.
          </p>
        </>
      ),
    },
    {
      id: "how-protected",
      title: "How Compass protects your data",
      body: (
        <>
          <p>
            Specific rather than reassuring, and each one points at the code that implements
            it so you can check instead of trusting.
          </p>
          <ul className="legal-list">
            <li>
              <strong>Sessions are server-side rows, not tokens.</strong> Signing out deletes
              the row, so it is a real revocation. A signed token would stay valid until it
              expired no matter what the server wanted.
            </li>
            <li>
              <strong>The session cookie is <code>httpOnly</code>, <code>SameSite=Lax</code>,
              and <code>Secure</code> over HTTPS</strong> — unreadable by injected script,
              unusable by another site, and it expires 30 days from sign-in without being
              extended by use. Over HTTPS it is named with the <code>__Host-</code> prefix,
              so the browser will only accept it from this exact host, never from a
              subdomain.
            </li>
            <li>
              <strong>Writes from another origin are refused.</strong> A browser request that
              changes anything must come from Compass itself. This goes further than
              SameSite does on purpose: every preview deployment of Compass shares its site,
              and a cookie setting alone would let one of them act on your account.
            </li>
            <li>
              <strong>Passwords are PBKDF2-HMAC-SHA-256, 25,000 iterations</strong>, with a
              random 16-byte salt per account and the iteration count stored inside the hash
              so it can be raised later without invalidating anyone. Plaintext passwords are
              never written anywhere.
            </li>
            <li>
              <strong>Ownership is checked on exactly one code path.</strong> Every route
              that touches student data goes through the same guard, and guests get a real
              account row for the same reason — two ownership paths would be two ways to
              write a check and one way to forget it.
            </li>
            <li>
              <strong>An account with no email cannot be logged into by construction.</strong>{" "}
              Anonymous accounts have a NULL email, and a SQL comparison against NULL is
              never true, so no credential can ever match one.
            </li>
            <li>
              <strong>Nothing tells a stranger whether an address has an account.</strong>{" "}
              A wrong password and an unknown address get the same answer in the same time,
              a reset request gets the same answer for every address, and signing up always
              says to check your inbox. A new address is sent a link to finish; one that
              already has an account is sent a note saying someone tried. Only the owner of
              the inbox can see which.
            </li>
            <li>
              <strong>Nobody can set up an account with your address and have you confirm
              it.</strong> A sign-up link finishes by itself only in the browser that signed
              up. Opened anywhere else it asks for the password chosen at sign-up, so a link
              you never asked for does nothing.
            </li>
            <li>
              <strong>Logs cannot hold student data.</strong> The request log records the
              route pattern <code>/api/students/:id</code>, never the concrete id, and no
              call site passes a body, a query string, an email, or a password. This is a
              property of the call sites rather than a redaction pass, so there is no
              scrubber that can fail open — and the test suite asserts on the raw response
              text to keep it that way.
            </li>
            <li>
              <strong>Two-factor authentication, if you switch it on.</strong> TOTP —
              an authenticator app, not SMS, which a SIM swap defeats. Codes are single-use
              even inside their validity window, so one read over your shoulder cannot be
              replayed. Ten recovery codes are issued at enrollment and stored hashed, so
              nobody here can look them up for you. Switching it off, issuing new recovery
              codes, or setting it up again on a new phone all take your password and a
              current code, so someone signed in on a borrowed laptop who also knows your
              password cannot remove it or swap in their own phone. After five wrong codes,
              each further code has to wait — a minute, then two, doubling up to a day —
              counted per account, so switching networks buys nothing. Signing in and
              resetting a password keep separate counts, so someone who learns your
              password cannot also lock you out of recovering the account.
            </li>
            <li>
              <strong>A password reset does not bypass your second factor.</strong> This is
              the decision that makes 2FA meaningful here rather than decorative: email is
              already the reset channel, so a reset that skipped the second factor would
              leave anyone who can read your inbox holding a complete path into your
              account. The cost is real and worth knowing before you enrol — lose your phone
              <em>and</em> your recovery codes and the account cannot be recovered, by you
              or by anyone else.
            </li>
            <li>
              <strong>A password reset revokes every session and every other pending reset
              token.</strong> Recovering an account is only recovery if it also evicts
              whoever prompted it — a password change that leaves an attacker signed in has
              achieved nothing. Reset tokens are 256 bits from the platform CSPRNG, stored
              as a SHA-256 hash so the table holds nothing usable, single-use, and expire in
              an hour.
            </li>
            <li>
              <strong>Rate limits are counted in the database</strong>, so they hold across a
              distributed runtime. Per 15 minutes: 30 chat requests per account (per
              network for guests); 15 attempts per network shared across signing in,
              signing up, setting a new password, two-factor codes, and deleting an account;
              5 requests for a reset email; and 50 new guest profiles per network. Separately,
              any one email address is sent at most 3 sign-up emails an hour, however many
              networks ask. Two-factor codes are also limited per account, as above.
            </li>
            <li>
              <strong>Request bodies are capped at 100 KB</strong>, rejected on the declared
              length before anything is read.
            </li>
            <li>
              <strong>Share tokens are 122 bits of entropy</strong> from the platform CSPRNG,
              and an unknown token and a revoked one return the same 404 — so the response
              cannot be used to learn whether a link ever existed.
            </li>
            <li>
              <strong>The app ships no third-party JavaScript</strong>, which removes the
              largest supply-chain surface a frontend normally has.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "limitations",
      title: "Known limitations",
      body: (
        <>
          <p>
            The part most trust pages leave out. None of these is a secret, and listing them
            is what makes the section above worth reading.
          </p>
          <ul className="legal-list">
            <li>
              <strong>TOTP secrets are not encrypted at rest.</strong> Anyone who could read
              the database could generate second-factor codes. Encrypting them was
              considered and rejected: the key would live in the same Cloudflare account as
              the database, so it defends only a leaked backup — and it adds a failure mode
              where losing or rotating that key locks every enrolled person out of their own
              account at once, with nobody here to override it.
            </li>
            <li>
              <strong>Two-factor is opt-in, and off by default.</strong> Most accounts are
              still protected by a password alone.
            </li>
            <li>
              <strong>Share links are bearer tokens.</strong> Anyone holding the URL can read
              the plan, by design — but that means a forwarded link, a screenshot, or a link
              pasted into a group chat is a disclosure that revoking cannot undo after the
              fact.
            </li>
            <li>
              <strong>Chat content goes to a third-party model provider</strong> and is
              subject to their handling, not Compass&apos;s. See{" "}
              <Link to="/privacy#ai">the Privacy Policy</Link>.
            </li>
            <li>
              <strong>No independent security audit and no penetration test.</strong> What
              exists is a test suite, a typed codebase, and code review — which is not the
              same thing and should not be described as if it were.
            </li>
            <li>
              <strong>There is no error-reporting or intrusion-detection service.</strong>{" "}
              Detection is request logs read by a person, so a quiet compromise could go
              unnoticed longer than it would elsewhere.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "if-breached",
      title: "If something goes wrong",
      body: (
        <p>
          If a breach affects your data, you will be told: what happened, what was reached,
          when, and what to do — without waiting for a complete investigation, because a
          slow accurate notice is worse than a fast partial one when the useful response is
          &ldquo;change your password now&rdquo;. Notice goes to the email on your account
          where there is one, and onto this page where there is not. Any legally required
          regulator notification will be made as well.
        </p>
      ),
    },
    {
      id: "open-source",
      title: "You can read all of this yourself",
      body: (
        <>
          <p>
            Compass is open source. Every claim on this page is a file you can open, and
            every one of them was checked before it was written here.
          </p>
          <p className="legal-cta-row">
            <a
              className="btn btn-ghost"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
            >
              Read the source on GitHub
            </a>
          </p>
          <p>
            Machine-readable contact details are at{" "}
            <a href="/.well-known/security.txt">/.well-known/security.txt</a>, per RFC 9116.
          </p>
        </>
      ),
    },
  ];

  return (
    <LegalPage
      eyebrow="Security"
      title="Security &amp; disclosure"
      lead="How to report a vulnerability, what protects your data, and — the part that makes the rest believable — what Compass does not do yet."
      sections={sections}
      summary={
        <ul className="legal-tldr">
          <li>
            <strong>Found a bug? Report it privately on GitHub.</strong> Good-faith research
            inside the scope below is authorised — you will not be pursued for it.
          </li>
          <li>
            Expect an acknowledgement within 3 business days and a triage within 7, from a
            person rather than a queue.
          </li>
          <li>
            Sessions are revocable server-side rows; passwords are PBKDF2 with 25,000
            iterations; logs are built so they cannot hold a student identifier.
          </li>
          <li>
            <strong>Known gaps, stated plainly:</strong> no independent audit, TOTP secrets
            unencrypted at rest, and share links are bearer tokens.
          </li>
          <li>Everything here is checkable — the source is public.</li>
        </ul>
      }
    />
  );
}
