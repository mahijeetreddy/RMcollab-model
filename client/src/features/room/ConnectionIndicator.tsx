import type { ConnectionStatus } from "../../ws/useRealtime";

const LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting",
  online: "Live",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

/** Status is carried by a glyph and a word as well as by colour. */
const GLYPHS: Record<ConnectionStatus, string> = {
  connecting: "◌",
  online: "✓",
  reconnecting: "↻",
  offline: "✕",
};

interface Props {
  status: ConnectionStatus;
  attempt: number;
  synced: boolean;
  onReconnect: () => void;
}

export function ConnectionIndicator({ status, attempt, synced, onReconnect }: Props) {
  const stale = status === "online" && !synced;
  const label = stale ? "Syncing" : LABELS[status];
  const suffix = status === "reconnecting" && attempt > 0 ? ` · attempt ${attempt}` : "";

  return (
    <p className={`conn conn-${status}`} role="status">
      <span className="visually-hidden">Connection:</span>
      <span className="conn-glyph" aria-hidden="true">
        {stale ? "◌" : GLYPHS[status]}
      </span>
      <span className="conn-dot" aria-hidden="true" />
      <span className={stale ? "conn-stale" : undefined}>
        {label}
        {suffix}
      </span>
      {status === "offline" && (
        <button type="button" className="ghost" onClick={onReconnect}>
          Retry
          <span className="visually-hidden"> connecting now</span>
        </button>
      )}
    </p>
  );
}
