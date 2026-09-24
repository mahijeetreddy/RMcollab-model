import { useCallback, useEffect, useMemo, useState } from "react";
import { LandingView } from "./features/landing/LandingView";
import { ClusterPanel } from "./features/cluster/ClusterPanel";
import { RoomView } from "./features/room/RoomView";
import { ConnectionIndicator } from "./features/room/ConnectionIndicator";
import { ThemeToggle } from "./theme/ThemeToggle";
import { useTheme } from "./theme/useTheme";
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
      return parsed as Credentials;
    }
  } catch {
    // Unreadable storage is not worth failing a page load over.
  }
  return null;
}

export default function App() {
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

  const stable = useMemo<Credentials | null>(
    () =>
      credentials
        ? { sessionCode: credentials.sessionCode, displayName: credentials.displayName }
        : null,
    [credentials?.sessionCode, credentials?.displayName],
  );

  const realtime = useRealtime(stable);
  const leave = useCallback(() => setCredentials(null), []);

  if (!stable) {
    return <LandingView onEnter={setCredentials} theme={theme} />;
  }

  const { state, status, attempt, reconnectNow, clearError } = realtime;

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
          <span className="code-chip" aria-labelledby="session-code-label">
            {state.session?.code ?? stable.sessionCode}
          </span>
        </div>

        <span className="header-spacer" />

        <ClusterPanel />
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

      <RoomView realtime={realtime} sessionCode={stable.sessionCode} />
    </div>
  );
}
