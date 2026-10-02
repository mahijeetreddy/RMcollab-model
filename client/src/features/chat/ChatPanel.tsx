import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ChatMessage } from "@rmcollab/shared";
import { formatTime, linkParts } from "../../lib/format";
import { EmptyState } from "../EmptyState";

interface Props {
  messages: ChatMessage[];
  meId: string | null;
  canSend: boolean;
  onSend: (body: string) => boolean;
  typing: Record<string, { displayName: string; at: number }>;
  onTyping: (isTyping: boolean) => void;
  /** Controlled by the room, which keeps one dock (chat or Ask) open at a time. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An owner of this room or of the session: may delete anyone's message. */
  canModerate?: boolean;
  /** Deletes a message; resolves once the gateway has, rejects with why not. */
  onDelete?: (messageId: string) => Promise<void>;
  /**
   * The room whose messages these are, once its snapshot has arrived; null in
   * between. Each room's history is its own starting point for "unread".
   */
  roomKey?: string | null;
}

function typingLabel(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return `${names[0]} and ${names.length - 1} others are typing`;
}

export function ChatPanel({
  messages,
  meId,
  canSend,
  onSend,
  typing,
  onTyping,
  open,
  onOpenChange,
  canModerate = false,
  onDelete,
  roomKey = null,
}: Props) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const confirmDelete = async (messageId: string) => {
    if (!onDelete) return;
    setDeleteError(null);
    try {
      await onDelete(messageId);
      setDeleting(null);
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : "Could not delete that message.");
    }
  };
  const [draft, setDraft] = useState("");
  const [unread, setUnread] = useState(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  // Only messages from other people are announced, and only the newest one,
  // so the live region stays readable instead of replaying the transcript.
  const seenIdsRef = useRef<Set<string> | null>(null);
  const openRef = useRef(false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onScroll = () => {
      pinnedRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    };
    list.addEventListener("scroll", onScroll);
    return () => list.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (pinnedRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  // Diffing against the ids we have already seen, rather than looking only at
  // the newest message: keying off `open` would recount the same message every
  // time the panel toggles, and a "first message equals the snapshot" guard
  // silently swallows the very first message a room ever receives.
  // Per room: switching rooms used to treat the new room's whole history as
  // new messages - the unread badge jumped by its length, and the last one was
  // read aloud. Each room's snapshot is now where its "seen" starts, and
  // nothing is counted while one is on its way.
  const roomRef = useRef<string | null>(null);
  useEffect(() => {
    if (!roomKey) return;
    if (roomRef.current !== roomKey) {
      roomRef.current = roomKey;
      seenIdsRef.current = new Set(messages.map((m) => m.id));
      setUnread(0);
      return;
    }
    const seen = seenIdsRef.current;
    if (seen === null) {
      // First delivery for this room is the history snapshot, not new traffic.
      seenIdsRef.current = new Set(messages.map((m) => m.id));
      return;
    }
    const fresh = messages.filter((m) => !seen.has(m.id));
    for (const m of messages) seen.add(m.id);
    const fromOthers = fresh.filter((m) => m.participantId !== meId);
    if (fromOthers.length === 0) return;

    const latest = fromOthers[fromOthers.length - 1]!;
    setAnnouncement(`${latest.displayName} says: ${latest.body}`);
    if (!openRef.current) setUnread((n) => n + fromOthers.length);
  }, [messages, meId, roomKey]);

  // Opening the panel is what marks the conversation read.
  useEffect(() => {
    openRef.current = open;
    if (open) setUnread(0);
  }, [open]);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [open]);

  const typingNames = Object.entries(typing)
    .filter(([id]) => id !== meId)
    .map(([, v]) => v.displayName);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    if (onSend(draft)) {
      setDraft("");
      onTyping(false);
    }
  };

  const onDraftChange = (value: string) => {
    setDraft(value);
    onTyping(value.trim().length > 0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (draft.trim() && onSend(draft)) {
        setDraft("");
        onTyping(false);
      }
    }
  };

  return (
    <div className={open ? "dock chat-dock is-open" : "dock chat-dock"}>
      <button
        type="button"
        className={unread > 0 && !open ? "chat-toggle has-unread" : "chat-toggle"}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls="chat-popover"
      >
        <span aria-hidden="true">💬</span>
        <span>Chat</span>
        {unread > 0 && !open && (
          <span className="chat-unread">
            {unread}
            <span className="visually-hidden"> unread messages</span>
          </span>
        )}
        {typingNames.length > 0 && !open && (
          <span className="chat-typing-dot" aria-hidden="true" />
        )}
      </button>

    <section
      className="panel chat-panel"
      id="chat-popover"
      aria-labelledby="chat-heading"
      hidden={!open}
    >
      <div className="panel-head">
        <h2 id="chat-heading">Chat</h2>
        <span className="header-spacer" />
        <span className="count-pill">
          {messages.length} message{messages.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          className="chat-close"
          onClick={() => onOpenChange(false)}
          aria-label="Close chat"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      <p className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      <div className="panel-body" ref={listRef}>
        {messages.length === 0 ? (
          <EmptyState icon={<ChatGlyph />} title="No messages yet">
            Messages go to everyone in this room. Press Enter to send, Shift+Enter for a new line.
          </EmptyState>
        ) : (
          <div className="chat-list" role="log" aria-label="Room messages">
            {messages.map((message) => (
              <article
                key={message.id}
                className={message.participantId === meId ? "chat-msg mine" : "chat-msg"}
              >
                <div className="chat-meta">
                  <span className="chat-author">
                    {message.displayName}
                    {message.participantId === meId && (
                      <span className="visually-hidden"> (you)</span>
                    )}
                  </span>
                  <time className="chat-time" dateTime={new Date(message.createdAt).toISOString()}>
                    {formatTime(message.createdAt)}
                  </time>
                  {onDelete && (message.participantId === meId || canModerate) && deleting !== message.id && (
                    <button
                      type="button"
                      className="chat-delete"
                      aria-label={`Delete message from ${message.displayName}`}
                      onClick={() => setDeleting(message.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
                <p className="chat-body">
                  {linkParts(message.body).map((part, i) =>
                    part.href ? (
                      <a key={i} href={part.href} target="_blank" rel="noopener noreferrer nofollow">
                        {part.text}
                      </a>
                    ) : (
                      <span key={i}>{part.text}</span>
                    ),
                  )}
                </p>
                {deleting === message.id && (
                  <div
                    className="chat-delete-confirm"
                    role="alertdialog"
                    aria-label="Delete this message?"
                    onKeyDown={(event) => event.key === "Escape" && setDeleting(null)}
                  >
                    <span>Delete for everyone?</span>
                    <button type="button" className="ghost" autoFocus onClick={() => setDeleting(null)}>
                      Cancel
                    </button>
                    <button type="button" className="danger" onClick={() => void confirmDelete(message.id)}>
                      Delete
                    </button>
                  </div>
                )}
                {deleting === message.id && deleteError && (
                  <p className="error-text" role="alert">
                    {deleteError}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <p className="chat-typing" aria-live="polite">
        {typingNames.length > 0 && (
          <>
            <span className="typing-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {typingLabel(typingNames)}
          </>
        )}
      </p>

      <form className="composer" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onBlur={() => onTyping(false)}
          onKeyDown={onKeyDown}
          placeholder={canSend ? "Message the room — Enter to send" : "Reconnecting…"}
          disabled={!canSend}
          rows={1}
          aria-label="Message the room"
          aria-describedby="composer-hint"
        />
        <span className="visually-hidden" id="composer-hint">
          Press Enter to send, Shift plus Enter for a new line.
        </span>
        <button type="submit" className="primary" disabled={!canSend || !draft.trim()}>
          Send
        </button>
      </form>
    </section>
    </div>
  );
}

function ChatGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 12a7.5 7.5 0 0 1-11 6.6L4 20l1.4-4.4A7.5 7.5 0 1 1 20 12Z" />
      <path d="M8.5 12h.01M12 12h.01M15.5 12h.01" strokeWidth="2.6" />
    </svg>
  );
}
