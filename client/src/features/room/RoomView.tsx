import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import type { LibraryEntry } from "@rmcollab/shared";
import type { SourceTarget } from "../ask/sourceLinks";
import { AskDock } from "../ask/AskDock";
import { answerToNotes } from "../ask/toNotes";
import { useAsk, type AskTurn } from "../ask/useAsk";
import { ChatPanel } from "../chat/ChatPanel";
import type { DocumentFocus } from "../jobs/focus";
import { JobList } from "../jobs/JobList";
import { LibraryPanel } from "../library/LibraryPanel";
import { NotesHome } from "../notes/NotesHome";
import { MAIN_DOC_ID } from "@rmcollab/shared/notes";
import type { NotesInsert, NotesTarget } from "../notes/NotesView";

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
import { icons } from "../notes/icons";
import { AddMedia } from "../upload/AddMedia";
import { AdmissionRequests, EndSession, SessionRetention, WaitingRoomToggle } from "./Admission";
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
  // The feed's add panel starts open in an empty room - adding is then the only
  // thing to do - and closed in a room that has things in it. Once shown open,
  // it stays open when the first upload lands (it is in use); after that it is
  // the person's to open and close. A different room starts over.
  const [feedAdding, setFeedAdding] = useState<boolean | null>(null);
  const empty = state.media.length === 0;
  const addingOpen = feedAdding ?? empty;
  useEffect(() => setFeedAdding(null), [state.activeRoomId]);
  useEffect(() => {
    if (feedAdding === null && state.synced && empty) setFeedAdding(true);
  }, [feedAdding, state.synced, empty]);
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

  // Ask the room. Held here, above the views, so an answer keeps arriving while
  // its asker follows a citation into the feed or the notes.
  const ask = useAsk(realtime, state.activeRoomId);
  // The two docks share a corner, so one opens at a time.
  const [dock, setDock] = useState<"chat" | "ask" | null>(null);
  const setDockOpen = useCallback(
    (which: "chat" | "ask") => (open: boolean) => setDock((current) => (open ? which : current === which ? null : current)),
    [],
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setDock((current) => (current === "ask" ? null : "ask"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // On a phone the panel covers the page, so following a citation closes it;
  // on a wider screen it stays beside the source.
  const narrow = () => window.matchMedia("(max-width: 600px)").matches;
  const [notesTarget, setNotesTarget] = useState<NotesTarget | null>(null);
  // Which document the notes view shows; null is the room's list of them.
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  useEffect(() => setOpenDoc(null), [state.activeRoomId]);
  const [notesInsert, setNotesInsert] = useState<NotesInsert | null>(null);
  const openSource = useCallback(
    (source: SourceTarget) => {
      if (narrow()) setDock(null);
      if (source.kind === "notes" && source.notesKey) {
        setView("notes");
        setOpenDoc(source.docId ?? MAIN_DOC_ID);
        setNotesTarget({ key: source.notesKey, nonce: Date.now() });
      } else if (source.mediaItemId) {
        // A recording opens at the moment the passage is spoken.
        setView("feed");
        setFocus({
          mediaItemId: source.mediaItemId,
          artifactId: source.artifactId ?? "",
          atSeconds: source.atSeconds,
          nonce: Date.now(),
        });
      }
    },
    [setView],
  );
  const addAnswerToNotes = useCallback(
    (turn: AskTurn) => {
      // Closed at every width: the point is to see the answer where it landed.
      setDock(null);
      setView("notes");
      // Into the document that is open, else the room's notes.
      setOpenDoc((current) => current ?? MAIN_DOC_ID);
      setNotesInsert({ content: answerToNotes(turn), nonce: Date.now() });
    },
    [setView],
  );

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

  // A room deleted while someone is in it: they move to the main room, the
  // way a closed breakout sends people back in a video call.
  // The session's owner: whoever owns its main room.
  const mainOwner = Boolean(state.me && state.rooms.find((room) => room.isMain)?.ownerId === state.me.id);

  // Removed from a breakout room by its owner: back to the main room, told why.
  const [removedNotice, setRemovedNotice] = useState<string | null>(null);
  const removed = state.removed;
  useEffect(() => {
    if (!removed || removed.scope !== "room") return;
    const gone = state.rooms.find((room) => room.id === removed.roomId);
    setRemovedNotice(`${removed.byName} removed you from ${gone ? `"${gone.name}"` : "that room"}.`);
    const main = state.rooms.find((room) => room.isMain);
    if (main) joinRoom(main.id);
    // Only when a new removal arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removed?.at]);

  // The document open here was deleted by someone else: back to the list, told
  // why, rather than typing into something that is gone. "Gone" means listed
  // before and missing now - a document just created opens before the room's
  // updated list arrives, and must not bounce its maker straight back.
  const listedDocs = useRef(new Set<string>());
  useEffect(() => {
    if (!state.documents) return;
    const ids = new Set(state.documents.map((d) => d.id));
    if (openDoc && openDoc !== MAIN_DOC_ID && listedDocs.current.has(openDoc) && !ids.has(openDoc)) {
      setOpenDoc(null);
      setRemovedNotice("That document was deleted.");
    }
    listedDocs.current = ids;
  }, [state.documents, openDoc]);

  // A chat message deleted by its author or an owner; the room hears it as an event.
  const deleteMessage = useCallback(
    async (messageId: string) => {
      if (!state.activeRoomId || !state.me) return;
      await api.deleteMessage(state.activeRoomId, messageId, state.me.id);
    },
    [state.activeRoomId, state.me],
  );

  // The session changed hands: say so, and say it to the new owner in particular.
  const ownerChange = state.ownerChange;
  useEffect(() => {
    if (!ownerChange) return;
    setRemovedNotice(
      ownerChange.ownerId === state.me?.id
        ? `${ownerChange.byName} made you the owner of this session.`
        : `${ownerChange.ownerName} is now the owner of this session.`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerChange?.at]);

  // Refused re-entry to a room they were removed from: back to the main room,
  // rather than left looking at a room they are not in.
  useEffect(() => {
    if (state.lastError?.code !== "room_banned") return;
    setRemovedNotice(state.lastError.message);
    const main = state.rooms.find((room) => room.isMain);
    if (main) joinRoom(main.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.lastError?.at]);

  // Only a room that was listed and then vanished: a room just created is
  // entered before the updated list arrives, and must not bounce its creator.
  const listedRooms = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(state.rooms.map((room) => room.id));
    const active = state.activeRoomId;
    if (active && listedRooms.current.has(active) && !now.has(active)) {
      const main = state.rooms.find((room) => room.isMain);
      if (main) joinRoom(main.id);
    }
    listedRooms.current = now;
  }, [state.rooms, state.activeRoomId, joinRoom]);

  // On a narrow screen the sidebar is a drawer. It closes once a room switch has
  // actually landed - not on the click, because a locked room asks for its code
  // inside the drawer and closing it would hide the prompt.
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    if (state.loadedRoomId) setNavOpen(false);
  }, [state.loadedRoomId]);
  // Up from the first snapshot of a room until another room is chosen - through
  // reconnects too (see loadedRoomId), so a blip never takes the notes down.
  const roomShown = state.activeRoomId !== null && state.loadedRoomId === state.activeRoomId;
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
      {mainOwner && state.me && state.session && (
        <AdmissionRequests
          sessionCode={state.session.code}
          ownerId={state.me.id}
          live={state.waitingList}
          decided={state.admissionDecided}
        />
      )}
      {removedNotice && (
        <div className="removed-notice" role="status">
          <span>{removedNotice}</span>
          <button type="button" className="ghost" onClick={() => setRemovedNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
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
        {mainOwner && state.me && state.session && (
          <WaitingRoomToggle
            sessionCode={state.session.code}
            ownerId={state.me.id}
            on={Boolean(state.session.waitingRoom)}
          />
        )}
        {state.session && (
          <SessionRetention
            sessionCode={state.session.code}
            ownerId={mainOwner && state.me ? state.me.id : null}
            kept={Boolean(state.session.kept)}
            days={state.session.retentionDays ?? 3}
          />
        )}
        {mainOwner && state.me && state.session && <EndSession sessionCode={state.session.code} ownerId={state.me.id} />}
        <ParticipantList
          participants={state.participants}
          meId={state.me?.id ?? null}
          ownerId={activeRoom?.ownerId ?? null}
          room={activeRoom}
          sessionCode={state.session?.code ?? null}
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
                // Notes opens on the room's documents, like a folder.
                setOpenDoc(null);
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
          {view === "feed" && (
            <button
              type="button"
              className="gdoc-add feed-add"
              aria-expanded={addingOpen}
              aria-controls="feed-add-media"
              onClick={() => setFeedAdding(!addingOpen)}
            >
              <span aria-hidden="true">{icons.upload}</span>
              <span className="feed-add-label">Add media</span>
            </button>
          )}
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

        <div className="panel-body">
          {!roomShown ? (
            <p className="empty">Waiting for the room snapshot…</p>
          ) : view === "notes" && state.activeRoomId && state.me && openDoc === null ? (
            <NotesHome
              roomId={state.activeRoomId}
              roomName={activeRoom?.name ?? "This room"}
              meId={state.me.id}
              ownerId={activeRoom?.ownerId ?? null}
              live={state.documents}
              onOpen={setOpenDoc}
            />
          ) : view === "notes" && state.activeRoomId && state.me && openDoc !== null ? (
            <Suspense fallback={<p className="empty">Opening the notes…</p>}>
              <NotesView
                key={openDoc}
                docId={openDoc}
                document={state.documents?.find((d) => d.id === openDoc) ?? null}
                onBack={() => setOpenDoc(null)}
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
                target={notesTarget}
                insert={notesInsert}
                onOpenSource={openSource}
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
            <>
              {/* In the feed's scroll, not pinned above it: it takes the
                  screen only while someone is adding. Hidden rather than
                  unmounted, so files already queued survive closing it. */}
              <div id="feed-add-media" className="gdoc-uploader feed-uploader" hidden={!addingOpen}>
                <AddMedia roomId={state.activeRoomId} participantId={state.me?.id ?? null} disabled={!live} />
              </div>
              <JobList
                media={state.media}
                focus={focus}
                manage={
                  state.activeRoomId && state.me
                    ? { roomId: state.activeRoomId, meId: state.me.id, ownerId: activeRoom?.ownerId ?? null }
                    : null
                }
              />
            </>
          )}
        </div>
      </section>

      <div className={`docks${dock ? " has-open" : ""}`}>
        <AskDock
          ask={ask}
          online={live}
          open={dock === "ask"}
          onOpenChange={setDockOpen("ask")}
          onOpenSource={openSource}
          onAddToNotes={addAnswerToNotes}
        />
        <ChatPanel
          messages={state.chat}
          meId={state.me?.id ?? null}
          canSend={live}
          onSend={sendChat}
          typing={state.typing}
          onTyping={sendTyping}
          open={dock === "chat"}
          onOpenChange={setDockOpen("chat")}
          canModerate={mainOwner || Boolean(state.me && activeRoom?.ownerId === state.me.id)}
          onDelete={deleteMessage}
        />
      </div>
    </main>
  );
}
