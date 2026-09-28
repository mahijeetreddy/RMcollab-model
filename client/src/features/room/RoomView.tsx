import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { LibraryEntry } from "@rmcollab/shared";
import { ChatPanel } from "../chat/ChatPanel";
import type { DocumentFocus } from "../jobs/focus";
import { JobList } from "../jobs/JobList";
import { LibraryPanel } from "../library/LibraryPanel";

// The editor (TipTap + ProseMirror + the CRDT bindings) is the heaviest part of
// the client, and not everyone opens the notes; load it on first use.
const NotesView = lazy(() => import("../notes/NotesView"));

type RoomViewName = "feed" | "notes" | "library";
const VIEW_KEY = "rmcollab:room-view";

/**
 * The notes are where a room's work comes together, so they are where a room
 * opens - unless this person last chose another view, which is remembered per
 * browser as a convenience.
 */
function readSavedView(): RoomViewName {
  try {
    const saved = window.localStorage.getItem(VIEW_KEY);
    if (saved === "feed" || saved === "notes" || saved === "library") return saved;
  } catch {
    // Unavailable storage: fall through to the default.
  }
  return "notes";
}
import { AddMedia } from "../upload/AddMedia";
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

  // The feed is what is happening now; the library is everything the room has
  // produced, searchable. Opening a library entry switches back to the feed with
  // that document in view.
  const [view, setViewState] = useState<RoomViewName>(readSavedView);
  const setView = useCallback((next: RoomViewName) => {
    setViewState(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Storage can be blocked (private windows); the view just is not remembered.
    }
  }, []);
  const [focus, setFocus] = useState<DocumentFocus | null>(null);
  const openEntry = useCallback((entry: LibraryEntry) => {
    setView("feed");
    setFocus({
      mediaItemId: entry.mediaItemId,
      artifactId: entry.artifact.id,
      atSeconds: entry.atSeconds,
      nonce: Date.now(),
    });
  }, []);

  // An upload's section in the notes opens its card in the feed.
  const openInFeed = useCallback((mediaItemId: string) => {
    setView("feed");
    setFocus({ mediaItemId, artifactId: "", atSeconds: null, nonce: Date.now() });
  }, []);

  // Changes when a job lands a document, which is when the library is stale.
  const libraryKey = useMemo(
    () =>
      `${state.activeRoomId}:${state.media.reduce(
        (sum, entry) => sum + (entry.job?.artifacts.length ?? 0),
        0,
      )}`,
    [state.activeRoomId, state.media],
  );

  const activeCount = state.media.filter(
    (entry) =>
      entry.job !== null && (entry.job.status === "queued" || entry.job.status === "processing"),
  ).length;

  // On a narrow screen the sidebar is a drawer. It closes once a room switch has
  // actually landed - not on the click, because a locked room asks for its code
  // inside the drawer and closing it would hide the prompt.
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    if (state.synced) setNavOpen(false);
  }, [state.activeRoomId, state.synced]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  return (
    <main className={`room${navOpen ? " nav-open" : ""}`} id="main-content" tabIndex={-1}>
      <aside className="sidebar" id="room-nav" aria-label="Session navigation">
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
      {navOpen && (
        <button
          type="button"
          className="nav-backdrop"
          aria-label="Close rooms and people"
          onClick={() => setNavOpen(false)}
        />
      )}

      <section className="panel" aria-labelledby="room-heading">
        <div className="panel-head">
          <button
            type="button"
            className="nav-toggle"
            aria-controls="room-nav"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((open) => !open)}
          >
            <span aria-hidden="true">☰</span> Rooms
          </button>
          <h2 id="room-heading">{activeRoom ? activeRoom.name : "Room"}</h2>
          <div className="view-switch" role="group" aria-label="View">
            <button
              type="button"
              aria-pressed={view === "feed"}
              onClick={() => {
                setFocus(null);
                setView("feed");
              }}
            >
              Feed
            </button>
            <button
              type="button"
              aria-pressed={view === "notes"}
              onClick={() => {
                setFocus(null);
                setView("notes");
              }}
            >
              Notes
            </button>
            <button
              type="button"
              aria-pressed={view === "library"}
              onClick={() => {
                setFocus(null);
                setView("library");
              }}
            >
              Library
            </button>
          </div>
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

        {view === "feed" && (
          <AddMedia
            roomId={state.activeRoomId}
            participantId={state.me?.id ?? null}
            disabled={!live}
          />
        )}

        <div className="panel-body">
          {!state.synced ? (
            <p className="empty">Waiting for the room snapshot…</p>
          ) : view === "notes" && state.activeRoomId && state.me ? (
            <Suspense fallback={<p className="empty">Opening the notes…</p>}>
              <NotesView
                realtime={realtime}
                roomId={state.activeRoomId}
                roomName={activeRoom?.name ?? "this room"}
                sessionCode={sessionCode}
                me={{ id: state.me.id, displayName: state.me.displayName }}
                media={state.media}
                onOpenInFeed={openInFeed}
                uploader={
                  <AddMedia roomId={state.activeRoomId} participantId={state.me.id} disabled={!live} />
                }
              />
            </Suspense>
          ) : view === "library" && state.activeRoomId && state.me ? (
            <LibraryPanel
              roomId={state.activeRoomId}
              participantId={state.me.id}
              refreshKey={libraryKey}
              onOpen={openEntry}
            />
          ) : (
            <JobList media={state.media} focus={focus} />
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
