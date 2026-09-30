import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { AskFallback, AskSource } from "@rmcollab/shared";
import { parseMarkdown, type Inline } from "../../lib/markdown";
import { formatDuration } from "../../lib/transcript";
import { docIcons, icons } from "../notes/icons";
import type { AskState, AskTurn } from "./useAsk";

interface Props {
  ask: AskState;
  online: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSource: (source: AskSource) => void;
  onAddToNotes: (turn: AskTurn) => void;
}

const EXAMPLES = ["What did we decide?", "What are the action items, and who owns them?", "What's still an open question?", "Summarise the latest recording"];

/** How the shortcut reads on this machine. */
const SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";

const KIND_ICON: Record<AskSource["kind"], ReactNode> = {
  transcript: docIcons.audio,
  summary: docIcons.text,
  document: docIcons.text,
  notes: docIcons.doc,
};

const FALLBACK_TEXT: Record<AskFallback, string> = {
  no_model: "No answer model is set up for this room, so here is what its material says on this.",
  quota: "The answer model has used its free quota for now. Here is what the room's material says on this.",
  failed: "The answer could not be written this time. Here is what the room's material says on this.",
  timeout: "The answer took too long. Here is what the room's material says on this.",
  rate_limited: "That is a lot of questions in a minute. Wait a moment and ask again.",
};

/** Where a source points, in words: "at 6:12", "Summary", "Notes". */
function where(source: AskSource): string {
  if (source.kind === "transcript") return source.atSeconds === null ? "Transcript" : `at ${formatDuration(source.atSeconds)}`;
  if (source.kind === "summary") return "Summary";
  if (source.kind === "notes") return "Room notes";
  return "Document";
}

/** Text with its [n] citations as buttons; a number with no source is dropped. */
function Cited({ text, sources, onOpen }: { text: string; sources: AskSource[]; onOpen: (s: AskSource) => void }) {
  const parts = text.split(/(\[\d{1,2}\])/g);
  return (
    <>
      {parts.map((part, index) => {
        const match = /^\[(\d{1,2})\]$/.exec(part);
        if (!match) return part;
        const source = sources.find((s) => s.n === Number(match[1]));
        if (!source) return null;
        return (
          <button
            key={index}
            type="button"
            className="ask-cite"
            onClick={() => onOpen(source)}
            title={`${source.title} · ${where(source)}\n${source.excerpt}`}
            aria-label={`Source ${source.n}: ${source.title}, ${where(source)}`}
          >
            {source.n}
          </button>
        );
      })}
    </>
  );
}

function InlineCited({ content, sources, onOpen }: { content: Inline[]; sources: AskSource[]; onOpen: (s: AskSource) => void }) {
  return (
    <>
      {content.map((part, index) =>
        part.kind === "strong" ? (
          <strong key={index}>
            <Cited text={part.text} sources={sources} onOpen={onOpen} />
          </strong>
        ) : part.kind === "em" ? (
          <em key={index}>
            <Cited text={part.text} sources={sources} onOpen={onOpen} />
          </em>
        ) : part.kind === "code" ? (
          <code key={index}>{part.text}</code>
        ) : (
          <Cited key={index} text={part.text} sources={sources} onOpen={onOpen} />
        ),
      )}
    </>
  );
}

/** The answer as elements, never HTML: it is model-written, so untrusted. */
function AnswerBody({ turn, onOpen }: { turn: AskTurn; onOpen: (s: AskSource) => void }) {
  const blocks = useMemo(() => parseMarkdown(turn.text), [turn.text]);
  return (
    <div className="ask-answer" aria-live={turn.status === "done" ? undefined : "polite"}>
      {blocks.map((block, index) => {
        if (block.kind === "list") {
          const Tag = block.ordered ? "ol" : "ul";
          return (
            <Tag key={index}>
              {block.items.map((item, i) => (
                <li key={i}>
                  <InlineCited content={item} sources={turn.sources} onOpen={onOpen} />
                </li>
              ))}
            </Tag>
          );
        }
        return (
          <p key={index} className={block.kind === "heading" ? "ask-answer-heading" : undefined}>
            <InlineCited content={block.content} sources={turn.sources} onOpen={onOpen} />
          </p>
        );
      })}
      {turn.status === "answering" && <span className="ask-caret" aria-hidden="true" />}
    </div>
  );
}

function SourceList({ sources, onOpen }: { sources: AskSource[]; onOpen: (s: AskSource) => void }) {
  return (
    <ol className="ask-sources">
      {sources.map((source) => (
        <li key={source.n}>
          <button type="button" className={`ask-source kind-${source.kind}`} onClick={() => onOpen(source)}>
            <span className="ask-source-n">{source.n}</span>
            <span className="ask-source-icon" aria-hidden="true">
              {KIND_ICON[source.kind]}
            </span>
            <span className="ask-source-text">
              <span className="ask-source-title">
                {source.title}
                <span className="ask-source-where">{where(source)}</span>
              </span>
              <span className="ask-source-excerpt">{source.excerpt}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

const DECLINED = /the room'?s material doesn'?t cover this/i;

function Turn({ turn, onOpen, onAddToNotes }: { turn: AskTurn; onOpen: (s: AskSource) => void; onAddToNotes: (t: AskTurn) => void }) {
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const cited = turn.cited.map((n) => turn.sources.find((s) => s.n === n)).filter((s): s is AskSource => Boolean(s));
  const uncited = turn.sources.filter((s) => !turn.cited.includes(s.n));
  const declined = turn.status === "done" && DECLINED.test(turn.text) && cited.length === 0;
  // Without an answer the passages are the answer, so they all show.
  const sourcesOnly = turn.status === "done" && turn.fallback !== null && turn.fallback !== "rate_limited" && !turn.text;
  const seconds = turn.finishedAt ? ((turn.finishedAt - turn.startedAt) / 1000).toFixed(1) : null;

  let status: string;
  if (turn.status === "searching") status = "Searching the room…";
  else if (turn.status === "answering") status = `Answering from ${turn.sources.length} passage${turn.sources.length === 1 ? "" : "s"}…`;
  else if (turn.noEvidence) status = "Nothing to answer from yet";
  else if (declined) status = "Not in the room's material";
  else if (cited.length > 0) status = `From ${cited.length} source${cited.length === 1 ? "" : "s"} · ${seconds}s`;
  else status = seconds ? `${seconds}s` : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(turn.text.replace(/\[\d{1,2}\]/g, "").replace(/\s+([.,;:])/g, "$1").trim());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard can be blocked; the text is on screen to select.
    }
  };

  return (
    <article className={`ask-turn is-${turn.status}`} aria-busy={turn.status !== "done"}>
      <header className="ask-turn-head">
        <h4 className="ask-question">{turn.question}</h4>
        {turn.standalone && (
          <p className="ask-standalone">
            Searched for: <em>{turn.standalone}</em>
          </p>
        )}
        <p className="ask-status">
          {turn.status !== "done" && <span className="add-spinner" aria-hidden="true" />}
          {status}
        </p>
      </header>

      {turn.status === "searching" && (
        <div className="ask-skeleton" aria-hidden="true">
          <span />
          <span />
          <span className="is-short" />
        </div>
      )}

      {turn.noEvidence && (
        <p className="ask-note">Nothing has been added to this room yet. Add a recording, a document or some notes, then ask again.</p>
      )}
      {turn.fallback && <p className={`ask-note${turn.fallback === "rate_limited" ? "" : " is-warn"}`}>{FALLBACK_TEXT[turn.fallback]}</p>}

      {turn.text && !declined && <AnswerBody turn={turn} onOpen={onOpen} />}
      {declined && <p className="ask-note">The room's material doesn't cover this. The closest passages are below, in case they help.</p>}

      {sourcesOnly || declined ? (
        turn.sources.length > 0 && <SourceList sources={turn.sources} onOpen={onOpen} />
      ) : (
        <>
          {cited.length > 0 && <SourceList sources={cited} onOpen={onOpen} />}
          {turn.status === "done" && uncited.length > 0 && (
            <div className="ask-more">
              <button type="button" className="link-button" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Hide the other passages" : `${uncited.length} more passage${uncited.length === 1 ? "" : "s"} searched`}
              </button>
              {showAll && <SourceList sources={uncited} onOpen={onOpen} />}
            </div>
          )}
        </>
      )}

      {turn.status === "done" && turn.text && !declined && (
        <footer className="ask-actions">
          <button type="button" className="ask-action" onClick={() => onAddToNotes(turn)}>
            {docIcons.doc}
            Add to notes
          </button>
          <button type="button" className="ask-action" onClick={copy} aria-live="polite">
            {icons.check}
            {copied ? "Copied" : "Copy"}
          </button>
        </footer>
      )}
    </article>
  );
}

/**
 * Ask the room as a dock beside the chat: a pill that opens a floating panel,
 * so a question is one click (or Ctrl/⌘+K) away from any view, and the answer
 * stays on screen next to the source a citation opens.
 */
export function AskDock({ ask, online, open, onOpenChange, onOpenSource, onAddToNotes }: Props) {
  const [question, setQuestion] = useState("");
  const [unseen, setUnseen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const busy = ask.turns.some((turn) => turn.status !== "done");

  // An answer that finishes while the panel is closed marks the pill.
  const doneCount = ask.turns.filter((turn) => turn.status === "done").length;
  const lastDone = useRef(doneCount);
  useEffect(() => {
    if (doneCount > lastDone.current && !open) setUnseen(true);
    lastDone.current = doneCount;
  }, [doneCount, open]);
  useEffect(() => {
    if (!open) return;
    setUnseen(false);
    inputRef.current?.focus();
  }, [open]);

  // Follows the answer as it streams, unless the reader has scrolled up to read.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onScroll = () => {
      pinned.current = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    };
    body.addEventListener("scroll", onScroll);
    return () => body.removeEventListener("scroll", onScroll);
  }, []);
  const lastTurn = ask.turns.at(-1);
  useEffect(() => {
    if (open && pinned.current) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [open, ask.turns.length, lastTurn?.text, lastTurn?.status, lastTurn?.sources.length]);

  const submit = (event?: FormEvent, text = question) => {
    event?.preventDefault();
    if (!ask.ask(text)) return;
    setQuestion("");
    pinned.current = true;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      onOpenChange(false);
    }
  };

  return (
    <div className={`dock ask-dock${open ? " is-open" : ""}`}>
      <button
        type="button"
        className={`ask-toggle${unseen ? " has-unseen" : ""}`}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls="ask-popover"
        aria-keyshortcuts="Control+K Meta+K"
        title={`Ask the room (${SHORTCUT})`}
      >
        <span className="ask-toggle-icon" aria-hidden="true">
          {icons.sparkle}
        </span>
        <span>Ask the room</span>
        {busy && !open && <span className="add-spinner" aria-hidden="true" />}
        {unseen && !busy && (
          <span className="ask-unseen">
            <span className="visually-hidden">: a new answer</span>
          </span>
        )}
      </button>

      <section className="panel ask-panel" id="ask-popover" aria-labelledby="ask-heading" hidden={!open}>
        <header className="ask-panel-head">
          <span className="ask-panel-mark" aria-hidden="true">
            {icons.sparkle}
          </span>
          <div className="ask-panel-titles">
            <h2 id="ask-heading">Ask the room</h2>
            <p>Answers from this room's material · private to you</p>
          </div>
          {ask.turns.length > 0 && !busy && (
            <button type="button" className="ghost ask-panel-clear" onClick={ask.clear}>
              Clear
            </button>
          )}
          <button type="button" className="ask-close" onClick={() => onOpenChange(false)} aria-label="Close Ask the room">
            <span aria-hidden="true">✕</span>
          </button>
        </header>

        <div className="ask-panel-body" ref={bodyRef}>
          {ask.turns.length === 0 ? (
            <div className="ask-empty">
              <span className="ask-empty-icon" aria-hidden="true">
                {icons.sparkle}
              </span>
              <p className="ask-empty-title">What do you want to know?</p>
              <p className="ask-empty-body">
                Answers come only from what this room holds - transcripts, summaries, documents and the shared notes - and each
                claim links to where it came from.
              </p>
              <div className="ask-examples">
                {EXAMPLES.map((example) => (
                  <button key={example} type="button" className="ask-example" disabled={!online} onClick={() => submit(undefined, example)}>
                    {example}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="ask-turns" role="log" aria-label="Your questions and answers">
              {ask.turns.map((turn) => (
                <Turn key={turn.requestId} turn={turn} onOpen={onOpenSource} onAddToNotes={onAddToNotes} />
              ))}
            </div>
          )}
        </div>

        <form className="ask-form" onSubmit={submit}>
          <textarea
            ref={inputRef}
            className="ask-input"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={online ? "Ask about the recordings, documents and notes…" : "Reconnecting…"}
            aria-label="Ask the room"
            maxLength={500}
            rows={1}
            disabled={!online}
          />
          <button type="submit" className="primary ask-submit" disabled={!online || question.trim().length < 2} aria-label="Ask">
            {icons.send}
          </button>
        </form>
      </section>
    </div>
  );
}
