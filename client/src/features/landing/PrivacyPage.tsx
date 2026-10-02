import { errorTracking } from "../../lib/errorTracking";

/**
 * What happens to what people put in, in plain words. Served at /privacy and
 * linked from the landing page. Keep it true: when a provider, a retention
 * period or a stored item changes, this page changes with it.
 */
export function PrivacyPage() {
  const contact = import.meta.env.VITE_CONTACT_EMAIL?.trim();
  return (
    <div className="privacy">
      <main className="privacy-main" id="main-content">
        <p>
          <a href="/" className="privacy-back">
            ← RMcollab
          </a>
        </p>
        <h1>Privacy</h1>
        <p className="privacy-lead">
          RMcollab is for study groups to work together for a few days. It keeps as little as it can, for as short a
          time as it can, and this page says exactly what that is.
        </p>

        <h2>No accounts</h2>
        <p>
          There is no sign-up and no email address. In a session you are known only by the name you type. Anyone with a
          session's code can join it while that code is current, so share a code the way you would share a key. The
          person who started a session can turn on a waiting room, so that nobody gets in without being let in.
        </p>

        <h2>What is kept, and for how long</h2>
        <p>
          Your name, chat messages, the shared notes, and anything you add (recordings, photos, text) with the
          transcripts and summaries made from them are stored on the server that runs this site, for as long as the
          session is in use.
        </p>
        <ul>
          <li>
            A session nobody has used for <strong>3 days</strong> is deleted, with everything in it - or for{" "}
            <strong>30 days</strong>, if the person who started it chose to keep it longer. Everyone in a session can see
            which applies.
          </li>
          <li>
            The person who started a session can <strong>end it at any time</strong>, which deletes everything at once.
          </li>
          <li>You can delete anything you added, and any chat message you wrote, whenever you like.</li>
        </ul>

        <h2>Who else sees it</h2>
        <p>Some of the work is done by AI services run by other companies:</p>
        <ul>
          <li>
            <strong>Groq</strong> writes summaries and answers questions you ask the room, from the text of what was
            added. Groq does not use what it is sent to train its models.
          </li>
          <li>
            <strong>Google Gemini</strong> reads photos (a whiteboard, a slide). Google may use content sent through its
            free service to improve its products, and people at Google may read it.
          </li>
        </ul>
        <p>
          Recordings are transcribed, and the room is searched, on this site's own server; neither leaves it. Because of
          the services above, <strong>don't add anything confidential or personal</strong>, such as other people's
          private information.
        </p>
        {errorTracking && (
          <p>
            If something breaks, a technical error report goes to <strong>Sentry</strong>: where in the code it broke,
            and the browser or server it happened on. Reports never include what anyone wrote, uploaded or is called;
            those are removed before anything is sent.
          </p>
        )}

        <h2>In your browser</h2>
        <p>This site sets no cookies and has no advertising or tracking. It keeps a few things in your browser&apos;s own storage:</p>
        <ul>
          <li>the session you are in, so a reload brings you back to it;</li>
          <li>the sessions you joined recently, so you can rejoin them in one click;</li>
          <li>your light or dark theme, and which view you last had open.</li>
        </ul>
        <p>
          Clearing this site&apos;s data in your browser removes them. Your identity in a session lives there too: if you
          started a session, use <em>Copy my private link</em> (under the session code) to keep a way back in, and keep
          that link to yourself, because whoever has it is you in that session.
        </p>

        <h2>Questions</h2>
        <p>
          {contact ? (
            <>
              Write to <a href={`mailto:${contact}`}>{contact}</a>.
            </>
          ) : (
            "Ask whoever shared this site with you; they run it."
          )}
        </p>
      </main>
    </div>
  );
}
