import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ChatMessage } from "@rmcollab/shared";
import { formatTime } from "../../lib/format";

interface Props {
  messages: ChatMessage[];
  meId: string | null;
  canSend: boolean;
  onSend: (body: string) => boolean;
  typing: Record<string, { displayName: string; at: number }>;
  onTyping: (isTyping: boolean) => void;
}

function typingLabel(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return `${names[0]} and ${names.length - 1} others are typing`;
}

export function ChatPanel({ messages, meId, canSend, onSend, typing, onTyping }: Props) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
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
  useEffect(() => {
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
  }, [messages, meId]);

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
    <div className={open ? "chat-dock is-open" : "chat-dock"}>
      <button
        type="button"
        className={unread > 0 && !open ? "chat-toggle has-unread" : "chat-toggle"}
        onClick={() => setOpen((v) => !v)}
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
          onClick={() => setOpen(false)}
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
          <p className="empty">No messages yet</p>
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
                </div>
                <p className="chat-body">{message.body}</p>
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
