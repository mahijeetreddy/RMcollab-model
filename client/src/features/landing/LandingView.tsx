import { useState, type FormEvent } from "react";
import type { Session } from "@rmcollab/shared";
import { api, ApiError } from "../../api/client";
import { ThemeToggle } from "../../theme/ThemeToggle";
import type { ThemeApi } from "../../theme/useTheme";
import type { Credentials } from "../../ws/useRealtime";

interface Props {
  onEnter: (credentials: Credentials) => void;
  theme: ThemeApi;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}

const FEATURES: ReadonlyArray<{ title: string; body: string }> = [
  { title: "Breakout rooms", body: "Split a session into focused rooms with their own chat." },
  { title: "Live presence", body: "See who is in the room and who dropped, as it happens." },
  { title: "GPU enhancement", body: "Upload text, images, audio or video and watch jobs stream." },
];

export function LandingView({ onEnter, theme }: Props) {
  const [created, setCreated] = useState<Session | null>(null);
  const [sessionName, setSessionName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [joinCode, setJoinCode] = useState("");
  const [displayName, setDisplayName] = useState("");
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

  const handleJoin = async (event: FormEvent) => {
    event.preventDefault();
    const code = joinCode.trim().toUpperCase();
    const name = displayName.trim();
    if (!code || !name) return;

    setJoining(true);
    setJoinError(null);
    try {
      const session = await api.getSession(code);
      onEnter({ sessionCode: session.code, displayName: name });
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
      await navigator.clipboard.writeText(created.code);
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
        <div className="landing-head">
          <p className="eyebrow">
            <span className="conn-dot" aria-hidden="true" />
            Real-time · no account needed
          </p>
          <h1>
            Collaborate in rooms that <em>enhance your media</em>
          </h1>
          <p>
            Start a session, share the code, and work together in breakout rooms. Drop in text,
            images, audio or video and watch GPU workers enhance them with live job progress.
          </p>
        </div>

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
                      Session code {created.code.split("").join(" ")}
                    </span>
                    <span aria-hidden="true">{created.code}</span>
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
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                placeholder="ABC123"
                autoComplete="off"
                spellCheck={false}
                style={{ fontFamily: "var(--mono)", letterSpacing: "0.16em" }}
                aria-describedby="join-code-hint"
                required
              />
              <p className="hint" id="join-code-hint">
                Six characters, from whoever started the session.
              </p>
            </div>

            <div className="field">
              <label htmlFor="display-name">Display name</label>
              <input
                id="display-name"
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
      </main>
    </div>
  );
}
