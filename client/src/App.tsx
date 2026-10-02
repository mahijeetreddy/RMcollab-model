import { useCallback, useEffect, useMemo, useState } from "react";
import { LandingView } from "./features/landing/LandingView";
import { ClusterPanel } from "./features/cluster/ClusterPanel";
import { RoomView } from "./features/room/RoomView";
import { ConnectionIndicator } from "./features/room/ConnectionIndicator";
import { ThemeToggle } from "./theme/ThemeToggle";
import { useTheme } from "./theme/useTheme";
import { forgetSession, rememberSession } from "./lib/recent";
import { WaitingScreen } from "./features/room/Admission";
import { InviteMenu } from "./features/room/InviteMenu";
import { PrivacyPage } from "./features/landing/PrivacyPage";
import { useRealtime, type Credentials } from "./ws/useRealtime";

const STORAGE_KEY = "rmcollab.credentials";

function loadCredentials(): Credentials | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Credentials).sessionCode === "string" &&
      typeof (parsed as Credentials).displayName === "string"
    ) {
      const participantId = (parsed as Credentials).participantId;
      return {
        sessionCode: (parsed as Credentials).sessionCode,
        displayName: (parsed as Credentials).displayName,
        ...(typeof participantId === "string" ? { participantId } : {}),
      };
    }
  } catch {
    // Unreadable storage is not worth failing a page load over.
  }
  return null;
}

export default function App() {
  // The privacy page stands alone: readable without joining anything.
  if (window.location.pathname === "/privacy") return <PrivacyPage />;
  return <SessionApp />;
}

function SessionApp() {
  const [credentials, setCredentials] = useState<Credentials | null>(loadCredentials);
  const theme = useTheme();

  useEffect(() => {
    try {
      if (credentials) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
      else window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage may be unavailable (private mode); session continues in memory.
    }
  }, [credentials]);

  // Only the code and name start a connection; the participant id is read when
  // one starts, so learning it (below) does not reconnect.
  const stable = useMemo<Credentials | null>(
    () =>
      credentials
        ? {
            sessionCode: credentials.sessionCode,
            displayName: credentials.displayName,
            ...(credentials.participantId ? { participantId: credentials.participantId } : {}),
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [credentials?.sessionCode, credentials?.displayName],
  );

  const realtime = useRealtime(stable);

  // Removed from the session by its owner: back to the start, told why, and
  // the session dropped from Recent sessions - rejoining it as this person is
  // no longer possible.
  const [landingNotice, setLandingNotice] = useState<string | null>(null);
  const removedFromSession = realtime.state.removed?.scope === "session" ? realtime.state.removed : null;
  const turnedAway = realtime.state.admission?.status === "denied" ? realtime.state.admission : null;
  const ended = realtime.state.ended;
  useEffect(() => {
    if (!ended || !stable) return;
    forgetSession(stable.sessionCode, realtime.state.me?.id);
    setLandingNotice(`${ended.byName} ended the session. Everything in it has been deleted.`);
    setCredentials(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended?.at]);
  useEffect(() => {
    if (!turnedAway || !stable) return;
    forgetSession(stable.sessionCode, realtime.state.me?.id);
    setLandingNotice(`${turnedAway.byName} didn't let you into the session.`);
    setCredentials(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnedAway]);
  useEffect(() => {
    if (!removedFromSession || !stable) return;
    forgetSession(stable.sessionCode, realtime.state.me?.id);
    setLandingNotice(`${removedFromSession.byName} removed you from the session.`);
    setCredentials(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removedFromSession?.at]);

  // Once joined: remember who we are here, so a reload or Recent sessions
  // comes back as the same person rather than a stranger with the same name.
  const joinedCode = realtime.state.session?.code;
  const joinedName = realtime.state.session?.name ?? null;
  const me = realtime.state.me;
  useEffect(() => {
    if (!joinedCode || !me) return;
    rememberSession({ code: joinedCode, name: joinedName, displayName: me.displayName, participantId: me.id });
    setCredentials((current) =>
      current && current.participantId !== me.id ? { ...current, participantId: me.id } : current,
    );
  }, [joinedCode, joinedName, me]);
  const leave = useCallback(() => setCredentials(null), []);

  if (!stable) {
    return (
      <LandingView
        onEnter={(next) => {
          setLandingNotice(null);
          setCredentials(next);
        }}
        theme={theme}
        notice={landingNotice}
      />
    );
  }

  const { state, status, attempt, reconnectNow, clearError } = realtime;

  if (state.admission?.status === "waiting") {
    return (
      <WaitingScreen
        sessionName={state.admission.sessionName}
        ownerName={state.admission.ownerName}
        ownerOnline={state.admission.ownerOnline}
        onCancel={leave}
      />
    );
  }

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <header className="app-header">
        <h1 className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false">
              <rect x="1.6" y="4.2" width="10.4" height="10.4" rx="3.1" />
              <rect x="7.6" y="5.6" width="10.8" height="10.8" rx="3.2" className="brand-mark-b" />
            </svg>
          </span>
          <span className="brand-word">
            RM<em>collab</em>
          </span>
        </h1>

        <div className="header-meta">
          <span id="session-code-label">Session</span>
          <InviteMenu code={state.session?.code ?? stable.sessionCode} participantId={state.me?.id ?? null} />
        </div>

        <span className="header-spacer" />

        {/* A view of the cluster's queues for developing and demonstrating the
            scale-out; production builds leave it out (and the gateway refuses
            /api/metrics there without a token). */}
        {import.meta.env.DEV && <ClusterPanel />}
        <span className="header-divider" aria-hidden="true" />

        <ThemeToggle theme={theme} />
        <span className="header-divider" aria-hidden="true" />

        <p className="header-you">
          <span className="visually-hidden">Signed in as</span>
          {stable.displayName}
        </p>

        <ConnectionIndicator
          status={status}
          attempt={attempt}
          synced={state.synced}
          onReconnect={reconnectNow}
        />
        <button type="button" className="ghost" onClick={leave}>
          Leave
        </button>
      </header>

      {state.lastError && (
        <div className="banner" role="alert">
          <strong>{state.lastError.code}</strong>
          <span>{state.lastError.message}</span>
          <span className="header-spacer" />
          <button type="button" className="ghost" onClick={clearError}>
            Dismiss
          </button>
        </div>
      )}

      {/* The session's current code, not the one joined with: a removal changes it,
          and sharing or making rooms with the old one would fail. */}
      <RoomView realtime={realtime} sessionCode={state.session?.code ?? stable.sessionCode} />
    </div>
  );
}
