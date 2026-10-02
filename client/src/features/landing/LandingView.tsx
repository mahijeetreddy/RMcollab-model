import { useEffect, useRef, useState, type FormEvent } from "react";
import { clearInvite, readInvite, type Invite } from "../../lib/invite";
import { formatSessionCode, normalizeSessionCode, type Session } from "@rmcollab/shared";
import { api, ApiError } from "../../api/client";
import { ThemeToggle } from "../../theme/ThemeToggle";
import type { ThemeApi } from "../../theme/useTheme";
import type { Credentials } from "../../ws/useRealtime";
import { forgetSession, loadRecent, visitedAgo, type RecentSession } from "../../lib/recent";
import { errorTracking } from "../../lib/errorTracking";
import { docIcons, icons } from "../notes/icons";

interface Props {
  onEnter: (credentials: Credentials) => void;
  theme: ThemeApi;
  /** Something to tell someone arriving here, e.g. that they were removed from a session. */
  notice?: string | null;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}

const FEATURES: ReadonlyArray<{ title: string; body: string }> = [
  { title: "Shared live notes", body: "One page the whole room edits at once, with everyone's cursor." },
  { title: "Media that writes itself up", body: "Lectures, whiteboards and notes become transcripts, summaries and to-dos." },
  { title: "Private breakout rooms", body: "Split a session into focused rooms, locked with a code if you like." },
];

export function LandingView({ onEnter, theme, notice = null }: Props) {
  const [created, setCreated] = useState<Session | null>(null);
  const [sessionName, setSessionName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Opened from an invite link (/join/CODE), or a "use on another device"
  // link that also carries who to continue as. Read once, on arrival.
  const [invite] = useState<Invite | null>(() => readInvite());
  const [joinCode, setJoinCode] = useState(invite?.code ?? "");
  const [displayName, setDisplayName] = useState("");
  const nameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (invite) nameRef.current?.focus();
  }, [invite]);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const session = await api.createSession(sessionName.trim() || undefined);
      setCreated(session);
      setJoinCode(session.code);
      setJoinError(null);
    } catch (error) {
      setCreateError(errorMessage(error));
    } finally {
      setCreating(false);
    }
  };

  const [trying, setTrying] = useState(false);
  const [tryError, setTryError] = useState<string | null>(null);
  const tryDemo = async () => {
    setTrying(true);
    setTryError(null);
    try {
      const session = await api.createDemo();
      onEnter({ sessionCode: session.code, displayName: displayName.trim() || "Guest" });
    } catch (error) {
      setTryError(errorMessage(error));
      setTrying(false);
    }
  };

  const handleJoin = async (event: FormEvent) => {
    event.preventDefault();
    const code = normalizeSessionCode(joinCode);
    const name = displayName.trim();
    if (!code || !name) return;

    setJoining(true);
    setJoinError(null);
    // Continuing as someone (a private device link) only for the session it was made for.
    const as = invite?.participantId && invite.code === code ? invite.participantId : undefined;
    try {
      const session = await api.getSession(code, as);
      clearInvite();
      onEnter({ sessionCode: session.code, displayName: name, ...(as ? { participantId: as } : {}) });
    } catch (error) {
      setJoinError(
        error instanceof ApiError && error.status === 404
          ? `No session with code ${code}`
          : errorMessage(error),
      );
    } finally {
      setJoining(false);
    }
  };

  const copyCode = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(formatSessionCode(created.code));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="landing">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <header className="landing-top">
        <p className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false">
              <rect x="1.6" y="4.2" width="10.4" height="10.4" rx="3.1" />
              <rect x="7.6" y="5.6" width="10.8" height="10.8" rx="3.2" className="brand-mark-b" />
            </svg>
          </span>
          <span className="brand-word">
            RM<em>collab</em>
          </span>
        </p>
        <span className="header-spacer" />
        <ThemeToggle theme={theme} />
      </header>

      <main className="landing-main" id="main-content">
        {notice && (
          <p className="landing-notice" role="status">
            {notice}
          </p>
        )}
        {invite && !notice && (
          <p className="landing-notice landing-invite" role="status">
            {invite.participantId
              ? "This link continues as someone already in a session, on this device. Enter your name below to go in."
              : "You've been invited to a session. Enter your name below to join."}
          </p>
        )}
        <div className="landing-hero">
        <div className="landing-head">
          <p className="eyebrow">
            <span className="conn-dot" aria-hidden="true" />
            Real-time · no account needed
          </p>
          <h1>
            Study together in rooms that <em>take the notes for you</em>
          </h1>
          <p>
            Start a session, share the code, and work together in breakout rooms. Drop in a lecture
            recording, a whiteboard photo or rough notes, and its transcript, summary and action items
            land in a shared document everyone edits live.
          </p>
          <div className="landing-try">
            <button type="button" className="primary landing-try-button" onClick={() => void tryDemo()} disabled={trying}>
              {trying ? "Opening…" : "Try a sample room"}
            </button>
            <span className="landing-try-note">A lecture, a whiteboard and notes, already analysed. No upload needed.</span>
          </div>
          {tryError && (
            <p className="error-text" role="alert">
              {tryError}
            </p>
          )}
        </div>
        <HeroPreview />
        </div>

        <RecentSessions onEnter={onEnter} />

        <div className="landing-grid">
          <form className="card" onSubmit={handleCreate} aria-labelledby="create-heading">
            <h2 id="create-heading">Start a session</h2>
            <p className="hint">Creates a session and its main room.</p>

            <div className="field">
              <label htmlFor="session-name">Session name (optional)</label>
              <input
                id="session-name"
                value={sessionName}
                onChange={(event) => setSessionName(event.target.value)}
                placeholder="Design review"
                maxLength={80}
                aria-describedby="session-name-hint"
              />
              <p className="hint" id="session-name-hint">
                Shown to everyone who joins. Leave blank for an untitled session.
              </p>
            </div>

            <div className="card-actions">
              <button type="submit" className="primary" disabled={creating}>
                {creating ? "Creating…" : "Create session"}
              </button>
            </div>

            {createError && (
              <p className="error-text" role="alert">
                <span aria-hidden="true">✕</span>
                {createError}
              </p>
            )}

            <div aria-live="polite">
              {created && (
                <div className="session-code">
                  <small>Share this join code</small>
                  <strong>
                    <span className="visually-hidden">
                      Session code {normalizeSessionCode(created.code).split("").join(" ")}
                    </span>
                    <span aria-hidden="true">{formatSessionCode(created.code)}</span>
                  </strong>
                  <button type="button" onClick={copyCode}>
                    {copied ? "Copied ✓" : "Copy code"}
                  </button>
                </div>
              )}
            </div>
          </form>

          <form className="card" onSubmit={handleJoin} aria-labelledby="join-heading">
            <h2 id="join-heading">Join a session</h2>
            <p className="hint">Enter a code and the name others will see.</p>

            <div className="field">
              <label htmlFor="join-code">Session code</label>
              <input
                id="join-code"
                value={formatSessionCode(joinCode)}
                onChange={(event) => setJoinCode(normalizeSessionCode(event.target.value).slice(0, 12))}
                placeholder="ABCDE-23456"
                autoComplete="off"
                spellCheck={false}
                style={{ fontFamily: "var(--mono)", letterSpacing: "0.16em" }}
                aria-describedby="join-code-hint"
                required
              />
              <p className="hint" id="join-code-hint">
                Ten characters, from whoever started the session. The dash is optional.
              </p>
            </div>

            <div className="field">
              <label htmlFor="display-name">Display name</label>
              <input
                id="display-name"
                ref={nameRef}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Ada"
                maxLength={40}
                autoComplete="nickname"
                required
              />
            </div>

            <div className="card-actions">
              <button
                type="submit"
                className="primary"
                disabled={joining || !joinCode.trim() || !displayName.trim()}
              >
                {joining ? "Joining…" : "Join session"}
              </button>
            </div>

            {joinError && (
              <p className="error-text" role="alert">
                <span aria-hidden="true">✕</span>
                {joinError}
              </p>
            )}
          </form>
        </div>

        <ul className="landing-features">
          {FEATURES.map((feature) => (
            <li key={feature.title}>
              <span className="feature-mark" aria-hidden="true">
                ◆
              </span>
              <span>
                <strong>{feature.title}</strong>
                {feature.body}
              </span>
            </li>
          ))}
        </ul>

        <p className="landing-fineprint">
          Sessions, with everything in them, are deleted after 3 days without activity, or 30 if whoever started
          one chooses to keep it. Uploads are analysed by
          third-party AI models (Groq and Google Gemini), so don't add anything confidential. There are no accounts:
          you are known only by the name you type, and this browser remembers the sessions you joined.
          {errorTracking &&
            " If something breaks, an error report goes to Sentry - where it broke, never what anyone wrote or their names."}{" "}
          <a href="/privacy">How your data is handled</a>
        </p>
      </main>
    </div>
  );
}

/** A still of the product for the empty half of the hero: decoration only. */
function HeroPreview() {
  return (
    <div className="hero-preview" aria-hidden="true">
      <div className="hero-doc">
        <div className="hero-doc-head">
          <span className="hero-doc-mark" />
          <span className="hero-doc-title">Distributed systems · week 6</span>
          <span className="hero-avatars">
            <span style={{ background: "#e8710a" }}>P</span>
            <span style={{ background: "#7c4dff" }}>M</span>
            <span style={{ background: "var(--accent)" }}>A</span>
          </span>
        </div>
        <div className="hero-section">
          <div className="hero-section-head">
            <span className="hero-section-icon">{docIcons.audio}</span>
            <span>
              <strong>lecture-6.mp3</strong>
              <small>Transcribed &amp; summarised · 42 min</small>
            </span>
            <span className="hero-status">Added to notes</span>
          </div>
          <p className="hero-h">Key points</p>
          <ul className="hero-points">
            <li>
              Redis Streams over Kafka: no ZooKeeper to run
              <span className="hero-cursor" style={{ ["--c" as string]: "#e8710a" }}>
                <span>Raven</span>
              </span>
            </li>
            <li>Consumer groups give each worker its own slice</li>
            <li>Exactly-once delivery is still an open question</li>
          </ul>
          <p className="hero-h">Action items</p>
          <ul className="hero-tasks">
            <li className="is-done">Raven drafts the consumer groups section</li>
            <li>
              Rori reruns the benchmark with three workers
              <span className="hero-cursor" style={{ ["--c" as string]: "#7c4dff" }}>
                <span>Rori</span>
              </span>
            </li>
          </ul>
        </div>
      </div>
      <div className="hero-chip hero-chip-a">
        <span className="hero-chip-spark">{icons.sparkle}</span>
        whiteboard.jpg → notes
      </div>
    </div>
  );
}

/** One click back into a session this browser has been in, as the same person. */
function RecentSessions({ onEnter }: { onEnter: (credentials: Credentials) => void }) {
  const [recent, setRecent] = useState<RecentSession[]>(loadRecent);
  const [busy, setBusy] = useState<string | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  if (recent.length === 0) return null;

  const rejoin = async (entry: RecentSession) => {
    setBusy(entry.code);
    setGone(null);
    try {
      // Their participant id comes too: it still opens a session whose code has since changed.
      const session = await api.getSession(entry.code, entry.participantId ?? undefined);
      onEnter({
        sessionCode: session.code,
        displayName: entry.displayName,
        ...(entry.participantId ? { participantId: entry.participantId } : {}),
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // Sessions end after a few idle days; this one has.
        forgetSession(entry.code);
        setRecent(loadRecent());
        setGone(entry.name ?? entry.code);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="recent" aria-labelledby="recent-heading">
      <h2 id="recent-heading" className="recent-title">
        Recent sessions
      </h2>
      <ul className="recent-list">
        {recent.map((entry) => (
          <li key={entry.code} className="recent-item">
            <button type="button" className="recent-open" onClick={() => void rejoin(entry)} disabled={busy !== null}>
              <span className="recent-name">{entry.name || "Untitled session"}</span>
              <span className="recent-meta">
                <span className="recent-code">{formatSessionCode(entry.code)}</span> · as {entry.displayName} · {visitedAgo(entry.lastVisited)}
              </span>
              <span className="recent-go" aria-hidden="true">
                {busy === entry.code ? "…" : "Rejoin →"}
              </span>
            </button>
            <button
              type="button"
              className="ghost recent-forget"
              aria-label={`Forget ${entry.name || entry.code}`}
              onClick={() => {
                forgetSession(entry.code);
                setRecent(loadRecent());
              }}
            >
              {icons.close}
            </button>
          </li>
        ))}
      </ul>
      {gone && (
        <p className="recent-gone" role="status">
          {gone} has ended - sessions are deleted after a while without activity.
        </p>
      )}
    </section>
  );
}
