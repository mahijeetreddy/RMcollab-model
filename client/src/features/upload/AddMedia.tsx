import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import type { MediaType, StrategyDescriptor } from "@rmcollab/shared";
import { api, ApiError } from "../../api/client";
import { detectFile, detectText, formatSize, MAX_UPLOAD_BYTES, type Detected } from "../../lib/detect";
import { allOptions, recommend, type Proposal } from "../../lib/recommend";
import { docIcons, icons } from "../notes/icons";

interface Props {
  roomId: string | null;
  participantId: string | null;
  disabled: boolean;
}

type Status = "ready" | "uploading" | "added" | "failed";

interface Item {
  id: string;
  file: File | null;
  /** For a written item; a file's text is read by detection instead. */
  text: string;
  detected: Detected | null;
  /** The chosen strategy; null until detection has proposed one. */
  choice: string | null;
  /** Set once the person picks something themselves, so later refreshes keep it. */
  chosen: boolean;
  status: Status;
  error: string | null;
}

const ACCEPT = "image/*,audio/*,video/*,text/plain,text/markdown,.md,.txt,.m4a,.mkv";
// Two at a time: enough to overlap a slow upload with a fast one without
// buffering several large files in the gateway at once.
const CONCURRENCY = 2;
// How long an added item stays to confirm before it leaves the queue; by then
// it has appeared in the room over the socket.
const CONFIRM_MS = 1600;
const KIND_LABEL: Record<MediaType, string> = { text: "Text", image: "Image", audio: "Recording", video: "Video" };
const KINDS: { kind: MediaType; label: string }[] = [
  { kind: "audio", label: "Recordings" },
  { kind: "video", label: "Videos" },
  { kind: "image", label: "Images" },
  { kind: "text", label: "Text" },
];

let nextId = 0;
const newId = () => `item-${(nextId += 1)}`;

function recommended(detected: Detected | null, strategies: StrategyDescriptor[]): string | null {
  if (!detected || detected.problem) return null;
  return recommend(detected, strategies).find((p) => p.recommended)?.strategy ?? null;
}

/**
 * Adding media to a room: drop, paste or browse any number of files (or write
 * text), and each is identified and given a recommended action in plain
 * language. Nothing is uploaded until the person clicks - an accidental drop
 * must not spend GPU time or a rate-limited model's quota.
 */
export function AddMedia({ roomId, participantId, disabled }: Props) {
  const [strategies, setStrategies] = useState<StrategyDescriptor[]>([]);
  const [strategiesError, setStrategiesError] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // dragenter/dragleave fire for every child crossed; a depth count is the
  // only reliable way to know the pointer has really left the panel.
  const dragDepth = useRef(0);
  const baseId = useId();

  const loadStrategies = useCallback(() => {
    api
      .listStrategies()
      .then((list) => {
        setStrategies(list);
        setStrategiesError(null);
      })
      .catch((cause: unknown) =>
        setStrategiesError(cause instanceof ApiError ? cause.message : "Could not load what this room can do"),
      );
  }, []);
  useEffect(loadStrategies, [loadStrategies]);

  // Proposals follow the live strategy list: an item waiting on a model that
  // has just come online picks up the better recommendation, unless the person
  // already chose.
  useEffect(() => {
    setItems((current) =>
      current.map((item) =>
        item.chosen || item.status !== "ready" ? item : { ...item, choice: recommended(item.detected, strategies) },
      ),
    );
  }, [strategies]);

  const update = (id: string, patch: Partial<Item>) =>
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    const added = files.map<Item>((file) => ({
      id: newId(),
      file,
      text: "",
      detected: null,
      choice: null,
      chosen: false,
      status: "ready",
      error: null,
    }));
    setItems((current) => [...current, ...added]);
    loadStrategies();
    for (const item of added) {
      void detectFile(item.file!).then((detected) =>
        setItems((current) =>
          current.map((x) => (x.id === item.id ? { ...x, detected, choice: recommended(detected, strategies) } : x)),
        ),
      );
    }
  };

  const addText = (text = "") => {
    const detected = detectText(text);
    setItems((current) => [
      ...current,
      { id: newId(), file: null, text, detected, choice: recommended(detected, strategies), chosen: false, status: "ready", error: null },
    ]);
  };

  const setText = (id: string, text: string) =>
    setItems((current) =>
      current.map((item) => {
        if (item.id !== id) return item;
        const detected = detectText(text);
        // Length can change the recommendation (polish vs summarise).
        return { ...item, text, detected, choice: item.chosen ? item.choice : recommended(detected, strategies) };
      }),
    );

  const onDragEnter = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepth.current += 1;
    if (!disabled) setDragging(true);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (disabled) return;
    addFiles(Array.from(event.dataTransfer.files));
  };

  const onPaste = (event: ClipboardEvent) => {
    if (disabled) return;
    // Pasting into a text item's box is ordinary typing.
    if ((event.target as HTMLElement).closest("textarea, input")) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (text.trim()) {
      event.preventDefault();
      addText(text);
    }
  };

  const pending = items.filter(
    (item) => item.status !== "added" && item.detected && !item.detected.problem && item.choice && (item.file || item.text.trim()),
  );
  const detecting = items.some((item) => item.detected === null);
  const canSubmit = !disabled && !busy && Boolean(roomId) && Boolean(participantId) && pending.length > 0 && !detecting;

  const submit = async () => {
    if (!roomId || !participantId || !canSubmit) return;
    setBusy(true);
    const queue = [...pending];
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        update(item.id, { status: "uploading", error: null });
        try {
          if (item.file) await api.uploadFile(roomId, participantId, item.file, item.choice!);
          else await api.uploadText(roomId, participantId, item.text, item.choice!);
          update(item.id, { status: "added" });
          const id = item.id;
          window.setTimeout(() => setItems((current) => current.filter((x) => x.id !== id)), CONFIRM_MS);
        } catch (cause) {
          update(item.id, { status: "failed", error: cause instanceof ApiError ? cause.message : "Could not be added" });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    setBusy(false);
  };

  const count = pending.length;
  const retrying = count > 0 && pending.every((item) => item.status === "failed");
  const skipped = items.filter((item) => item.detected?.problem).length;
  const compact = items.length > 0;

  let footnote: string;
  if (detecting) footnote = "Looking at your files…";
  else if (busy) footnote = "Sending to the room…";
  else if (count === 0 && skipped > 0) footnote = "Nothing here can be added yet";
  else if (skipped > 0) footnote = `${count} ready · ${skipped} can't be added and will be left out`;
  else footnote = `${count} ready · nothing is sent until you add ${count > 1 ? "them" : "it"}`;

  return (
    <section
      className={`add-media${dragging ? " is-dragging" : ""}`}
      aria-label="Add to this room"
      onPaste={onPaste}
      onDragEnter={onDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className={`dropzone${compact ? " is-compact" : ""}${dragging ? " is-dragging" : ""}${disabled ? " is-disabled" : ""}`}>
        <span className="dropzone-icon" aria-hidden="true">
          {icons.upload}
        </span>
        <div className="dropzone-copy">
          <p className="dropzone-title">
            {dragging ? "Drop to add" : compact ? "Drop more, or paste" : "Drop files here, or paste anything"}
          </p>
          {!compact && (
            <p className="dropzone-sub">
              Each one is recognised and given the action that suits it. Nothing starts until you add it.
            </p>
          )}
        </div>
        <div className="dropzone-actions">
          <button type="button" className="dropzone-button" disabled={disabled} onClick={() => fileInput.current?.click()}>
            {icons.upload}
            Browse files
          </button>
          <button
            type="button"
            className="dropzone-button"
            disabled={disabled}
            onClick={() => addText()}
            aria-label="Write or paste text"
          >
            {icons.pen}
            Write text
          </button>
        </div>
        {!compact && (
          <ul className="dropzone-kinds" aria-label="What can be added">
            {KINDS.map(({ kind, label }) => (
              <li key={kind} className={`kind-${kind}`}>
                {docIcons[kind]}
                {label}
              </li>
            ))}
            <li className="dropzone-limit">up to {formatSize(MAX_UPLOAD_BYTES)} each</li>
          </ul>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPT}
          className="visually-hidden"
          tabIndex={-1}
          aria-label="Choose files"
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
      </div>

      {strategiesError && (
        <p className="error-text" role="alert">
          {strategiesError}
        </p>
      )}

      {items.length > 0 && (
        <div className="add-tray">
          <div className="add-bar">
            <p className="add-footnote" aria-live="polite">
              {(detecting || busy) && <span className="add-spinner" aria-hidden="true" />}
              {footnote}
            </p>
            {!busy && (
              <button
                type="button"
                className="ghost add-clear"
                onClick={() => setItems((current) => current.filter((item) => item.status === "uploading"))}
              >
                Clear
              </button>
            )}
            <button type="button" className="primary add-submit" disabled={!canSubmit} onClick={submit}>
              {busy
                ? "Adding…"
                : retrying
                  ? "Try again"
                  : count > 1
                    ? `Add ${count} items to the room`
                    : "Add to the room"}
            </button>
          </div>
          <ul className="add-queue">
            {items.map((item) => (
              <QueueItem
                key={item.id}
                item={item}
                baseId={`${baseId}-${item.id}`}
                strategies={strategies}
                onText={(text) => setText(item.id, text)}
                onChoose={(choice) => update(item.id, { choice, chosen: true })}
                onRemove={() => setItems((current) => current.filter((x) => x.id !== item.id))}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function QueueItem({
  item,
  baseId,
  strategies,
  onText,
  onChoose,
  onRemove,
}: {
  item: Item;
  baseId: string;
  strategies: StrategyDescriptor[];
  onText: (text: string) => void;
  onChoose: (strategy: string) => void;
  onRemove: () => void;
}) {
  const detected = item.detected;
  const proposals: Proposal[] = useMemo(() => (detected && !detected.problem ? recommend(detected, strategies) : []), [detected, strategies]);
  const options = detected && !detected.problem ? allOptions(detected.kind, strategies) : [];
  const kind = detected?.kind ?? "text";
  const name = item.file ? item.file.name : "Your text";
  const locked = item.status === "uploading" || item.status === "added";
  // Only the chosen action shows until someone asks for the rest: with several
  // files, every option of every file at once was the confusion to remove.
  const [open, setOpen] = useState(false);
  const chosen = proposals.find((p) => p.strategy === item.choice);
  const custom = !chosen && item.choice ? (options.find((o) => o.name === item.choice)?.label ?? item.choice) : null;
  const panelId = `${baseId}-choices`;
  // Arrow keys move through radios and fire change on each step; only a click
  // or Enter should count as "that one" and close the list.
  const keyed = useRef(false);

  const thumb = useThumbnail(item.file, kind === "image" && !detected?.problem);

  const meta = [
    detected ? (detected.unknown ? "Unsupported file" : KIND_LABEL[detected.kind]) : null,
    detected?.problem ? null : detected?.summary,
    item.file ? formatSize(item.file.size) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const choose = (strategy: string) => {
    onChoose(strategy);
    if (!keyed.current) setOpen(false);
  };
  const onChoicesKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    keyed.current = event.key.startsWith("Arrow");
  };

  return (
    <li className={`add-item is-${item.status}${detected?.problem ? " has-problem" : ""}${open ? " is-open" : ""}`}>
      <div className="add-item-row">
        {thumb ? (
          <img className="add-item-thumb" src={thumb} alt="" />
        ) : (
          <span className={`add-item-icon kind-${detected ? kind : "pending"}`} aria-hidden="true">
            {detected?.problem ? icons.alert : docIcons[kind]}
          </span>
        )}
        <div className="add-item-id">
          <span className="add-item-name" title={name}>
            {name}
          </span>
          <span className="add-item-meta">{detected ? meta || KIND_LABEL[kind] : "Looking at it…"}</span>
        </div>

        <div className="add-item-end">
          {item.status === "uploading" && (
            <span className="add-item-state">
              <span className="add-spinner" aria-hidden="true" />
              Adding
            </span>
          )}
          {item.status === "added" && (
            <span className="add-item-state is-ok">
              {icons.check}
              Added
            </span>
          )}
          {!locked && detected === null && <span className="add-action is-loading" aria-hidden="true" />}
          {!locked && (chosen || custom) && (
            <button
              type="button"
              className={`add-action${chosen?.recommended ? " is-recommended" : ""}`}
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((value) => !value)}
            >
              <span className="add-action-icon" aria-hidden="true">
                {chosen?.recommended ? icons.sparkle : icons.check}
              </span>
              <span className="add-action-text">
                <span className="add-action-title">{chosen?.title ?? custom}</span>
                <span className="add-action-detail">
                  {chosen ? (chosen.recommended ? `Recommended · ${chosen.detail}` : chosen.detail) : "Chosen from all options"}
                </span>
              </span>
              <span className="add-action-chevron" aria-hidden="true">
                {icons.chevron}
              </span>
              <span className="visually-hidden">, change what happens to {name}</span>
            </button>
          )}
        </div>
        {!locked && (
          <button type="button" className="ghost add-item-remove" onClick={onRemove} aria-label={`Remove ${name}`}>
            {icons.close}
          </button>
        )}
      </div>

      {!item.file && (
        <textarea
          className="add-item-text"
          aria-label="Text"
          value={item.text}
          disabled={locked}
          autoFocus={!item.text}
          onChange={(event) => onText(event.target.value)}
          placeholder="Write or paste notes, a transcript, an essay…"
        />
      )}

      {detected?.problem && <p className="add-item-problem">{detected.problem}</p>}
      {item.error && (
        <p className="add-item-problem" role="alert">
          {item.error} - try again, or choose another action.
        </p>
      )}

      {open && !locked && (
        <div className="add-choices" id={panelId}>
          <fieldset className="add-proposals" onKeyDown={onChoicesKey} onPointerDown={() => (keyed.current = false)}>
            <legend className="add-choices-legend">What should happen to {name}?</legend>
            {proposals.map((proposal) => (
              <label
                key={proposal.strategy}
                className={`add-proposal${item.choice === proposal.strategy ? " is-chosen" : ""}${proposal.available ? "" : " is-unavailable"}`}
              >
                <input
                  type="radio"
                  className="visually-hidden"
                  name={`${baseId}-choice`}
                  value={proposal.strategy}
                  checked={item.choice === proposal.strategy}
                  disabled={!proposal.available}
                  onChange={() => choose(proposal.strategy)}
                />
                <span className="add-proposal-check" aria-hidden="true">
                  {icons.check}
                </span>
                <span className="add-proposal-title">
                  {proposal.title}
                  {proposal.recommended && <span className="add-proposal-badge">Recommended</span>}
                </span>
                <span className="add-proposal-detail">{proposal.detail}</span>
              </label>
            ))}
          </fieldset>
          {options.length > 0 && (
            <details className="add-more" open={Boolean(custom)}>
              <summary>More options</summary>
              <label>
                <span>Any strategy</span>
                <select value={item.choice ?? ""} onChange={(event) => onChoose(event.target.value)}>
                  {options.map((option) => (
                    <option key={option.name} value={option.name} disabled={!option.available}>
                      {option.label} ({option.name}){option.available ? "" : " - unavailable"}
                    </option>
                  ))}
                </select>
              </label>
            </details>
          )}
        </div>
      )}

      {item.status === "uploading" && <span className="add-item-progress" aria-hidden="true" />}
    </li>
  );
}

/** A preview of an image file, released when the item goes. */
function useThumbnail(file: File | null, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file || !enabled) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [file, enabled]);
  return url;
}
