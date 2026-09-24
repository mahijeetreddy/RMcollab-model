import { useMemo } from "react";
import { ChatPanel } from "../chat/ChatPanel";
import { JobList } from "../jobs/JobList";
import { UploadPanel } from "../upload/UploadPanel";
import { ParticipantList } from "./ParticipantList";
import { RoomSwitcher } from "./RoomSwitcher";
import type { Realtime } from "../../ws/useRealtime";

interface Props {
  realtime: Realtime;
  sessionCode: string;
}

export function RoomView({ realtime, sessionCode }: Props) {
  const { state, status, joinRoom, sendChat, sendTyping } = realtime;
  const live = status === "online" && state.synced;

  const activeRoom = useMemo(
    () => state.rooms.find((room) => room.id === state.activeRoomId) ?? null,
    [state.rooms, state.activeRoomId],
  );

  // A refused entry leaves activeRoomId pointing at the locked room with
  // synced=false, so the prompt knows which room it is asking a code for.
  const lockFailure =
    state.lastError &&
    (state.lastError.code === "room_locked" || state.lastError.code === "room_code_invalid")
      ? state.lastError
      : null;

  const activeCount = state.media.filter(
    (entry) =>
      entry.job !== null && (entry.job.status === "queued" || entry.job.status === "processing"),
  ).length;

  return (
    <main className="room" id="main-content" tabIndex={-1}>
      <aside className="sidebar" aria-label="Session navigation">
        <RoomSwitcher
          rooms={state.rooms}
          activeRoomId={state.activeRoomId}
          sessionCode={sessionCode}
          onSelect={joinRoom}
          lockedRoomId={lockFailure ? state.activeRoomId : null}
          lockError={lockFailure?.code === "room_code_invalid" ? lockFailure.message : null}
          meId={state.me?.id ?? null}
          activeRoom={activeRoom}
        />
        <ParticipantList
          participants={state.participants}
          meId={state.me?.id ?? null}
          ownerId={activeRoom?.ownerId ?? null}
        />
      </aside>

      <section className="panel" aria-labelledby="room-heading">
        <div className="panel-head">
          <h2 id="room-heading">{activeRoom ? activeRoom.name : "Room"}</h2>
          <span className="header-spacer" />
          {activeCount > 0 && (
            <span className="badge badge-status-processing">
              <span className="badge-glyph" aria-hidden="true">
                ◍
              </span>
              {activeCount} running
            </span>
          )}
          <span className="count-pill">
            {state.media.length} item{state.media.length === 1 ? "" : "s"}
          </span>
        </div>

        <UploadPanel
          roomId={state.activeRoomId}
          participantId={state.me?.id ?? null}
          disabled={!live}
        />

        <div className="panel-body">
          {state.synced ? (
            <JobList media={state.media} />
          ) : (
            <p className="empty">Waiting for the room snapshot…</p>
          )}
        </div>
      </section>

      <ChatPanel
        messages={state.chat}
        meId={state.me?.id ?? null}
        canSend={live}
        onSend={sendChat}
        typing={state.typing}
        onTyping={sendTyping}
      />
    </main>
  );
}
