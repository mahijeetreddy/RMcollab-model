import { useState, type FormEvent } from "react";
import type { Room } from "@rmcollab/shared";
import { api, ApiError } from "../../api/client";

interface Props {
  rooms: Room[];
  activeRoomId: string | null;
  sessionCode: string;
  onSelect: (roomId: string, code?: string) => void;
  /** Set when the gateway refused the last entry for a missing/wrong code. */
  lockedRoomId: string | null;
  lockError: string | null;
  meId: string | null;
  activeRoom: Room | null;
}

export function RoomSwitcher({
  rooms,
  activeRoomId,
  sessionCode,
  onSelect,
  lockedRoomId,
  lockError,
  meId,
  activeRoom,
}: Props) {
  const [name, setName] = useState("");
  const [newRoomCode, setNewRoomCode] = useState("");
  const [entryCode, setEntryCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createRoom = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const room = await api.createRoom(
        sessionCode,
        trimmed,
        meId,
        newRoomCode.trim() || undefined,
      );
      setName("");
      setNewRoomCode("");
      // The gateway also broadcasts rooms_updated; switching here is local intent.
      onSelect(room.id);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not create room");
    } finally {
      setBusy(false);
    }
  };

  return (
    <nav aria-labelledby="rooms-heading">
      <h2 className="section-title" id="rooms-heading">
        <span>Rooms</span>
        <span className="count-pill">{rooms.length}</span>
      </h2>

      {rooms.length === 0 ? (
        <p className="empty">No rooms yet</p>
      ) : (
        <ul className="room-list">
          {rooms.map((room) => (
            <li key={room.id}>
              <button
                type="button"
                className={room.id === activeRoomId ? "active" : undefined}
                aria-current={room.id === activeRoomId ? "true" : undefined}
                onClick={() => onSelect(room.id)}
              >
                <span className="room-name">{room.name}</span>
                {room.isMain && <span className="tag">main</span>}
                {room.isLocked && (
                  <span className="tag tag-locked" title="Locked room">
                    <span aria-hidden="true">🔒</span>
                    <span className="visually-hidden">locked, code required</span>
                  </span>
                )}
                {room.id === activeRoomId && (
                  <span className="visually-hidden">(current room)</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {activeRoom && activeRoom.isLocked && activeRoom.ownerId === meId && meId && (
        <RevealCode roomId={activeRoom.id} participantId={meId} />
      )}

      {lockedRoomId && (
        <form
          className="room-code-form"
          onSubmit={(event) => {
            event.preventDefault();
            const code = entryCode.trim();
            if (!code) return;
            onSelect(lockedRoomId, code);
            setEntryCode("");
          }}
        >
          <label htmlFor="room-entry-code">
            Room code for {rooms.find((r) => r.id === lockedRoomId)?.name ?? "this room"}
          </label>
          <div className="row">
            <input
              id="room-entry-code"
              value={entryCode}
              onChange={(event) => setEntryCode(event.target.value)}
              placeholder="Room code"
              maxLength={64}
              autoComplete="off"
            />
            <button type="submit" disabled={!entryCode.trim()}>
              Enter
            </button>
          </div>
          {lockError && (
            <p className="error-text" role="alert">
              <span aria-hidden="true">✕</span>
              {lockError}
            </p>
          )}
        </form>
      )}

      <form className="new-room-form" onSubmit={createRoom}>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New breakout room"
          maxLength={60}
          aria-label="New breakout room name"
        />
        <button type="submit" disabled={busy || !name.trim()}>
          {busy ? "…" : "Add"}
        </button>
        <input
          className="room-lock-input"
          value={newRoomCode}
          onChange={(event) => setNewRoomCode(event.target.value)}
          placeholder="Lock with a code (optional)"
          maxLength={64}
          autoComplete="off"
          aria-label="Optional room code. Leave blank to let anyone in the session join."
        />
      </form>
      {error && (
        <p className="error-text" role="alert">
          <span aria-hidden="true">✕</span>
          {error}
        </p>
      )}
    </nav>
  );
}


/** Owner-only: fetches the room's code on demand rather than holding it in
 *  client state, so it is never sitting in memory for a shoulder-surfer. */
function RevealCode({ roomId, participantId }: { roomId: string; participantId: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (code) {
      setCode(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setCode(await api.roomCode(roomId, participantId));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not fetch the code");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="owner-code">
      <button type="button" onClick={() => void toggle()} disabled={busy} aria-expanded={!!code}>
        <span aria-hidden="true">👑</span>
        {code ? "Hide room code" : busy ? "…" : "Show room code"}
      </button>
      {code && <code className="revealed-code">{code}</code>}
      {error && (
        <p className="error-text" role="alert">
          <span aria-hidden="true">✕</span>
          {error}
        </p>
      )}
    </div>
  );
}
