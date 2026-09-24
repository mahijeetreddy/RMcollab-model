import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { MediaType, StrategyDescriptor } from "@rmcollab/shared";
import { api, ApiError } from "../../api/client";
import { FILE_ACCEPT, MEDIA_TYPES, MEDIA_TYPE_LABELS } from "../../lib/format";

interface Props {
  roomId: string | null;
  participantId: string | null;
  disabled: boolean;
}

function pickDefault(strategies: StrategyDescriptor[]): string {
  const usable = strategies.filter((s) => s.available);
  const preferred = usable.find((s) => s.isDefault) ?? usable[0] ?? strategies[0];
  return preferred?.name ?? "";
}

export function UploadPanel({ roomId, participantId, disabled }: Props) {
  const [mediaType, setMediaType] = useState<MediaType>("text");
  const [strategies, setStrategies] = useState<StrategyDescriptor[]>([]);
  const [strategiesError, setStrategiesError] = useState<string | null>(null);
  const [strategy, setStrategy] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId();

  const tabId = (type: MediaType) => `${baseId}-tab-${type}`;
  const panelId = (type: MediaType) => `${baseId}-panel-${type}`;

  useEffect(() => {
    let cancelled = false;
    api
      .listStrategies()
      .then((list) => {
        if (!cancelled) {
          setStrategies(list);
          setStrategiesError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setStrategiesError(
            cause instanceof ApiError ? cause.message : "Could not load strategies",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const forType = useMemo(
    () => strategies.filter((entry) => entry.mediaType === mediaType),
    [strategies, mediaType],
  );

  useEffect(() => {
    setStrategy((current) =>
      forType.some((entry) => entry.name === current && entry.available)
        ? current
        : pickDefault(forType),
    );
  }, [forType]);

  const selected = forType.find((entry) => entry.name === strategy) ?? null;
  const hasPayload = mediaType === "text" ? text.trim().length > 0 : file !== null;
  const canSubmit =
    !disabled &&
    !busy &&
    Boolean(roomId) &&
    Boolean(participantId) &&
    Boolean(strategy) &&
    hasPayload;

  /** ARIA tabs keyboard pattern: arrows wrap, Home/End jump, focus follows. */
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = MEDIA_TYPES.length;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % count;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + count) % count;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    if (next === null) return;

    event.preventDefault();
    const type = MEDIA_TYPES[next];
    if (!type) return;
    setMediaType(type);
    setError(null);
    tabRefs.current[next]?.focus();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!roomId || !participantId || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (mediaType === "text") {
        await api.uploadText(roomId, participantId, text, strategy);
        setText("");
      } else if (file) {
        await api.uploadFile(roomId, participantId, file, strategy);
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
      // The resulting item arrives over the socket as media_uploaded.
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="upload" onSubmit={submit} aria-label="Upload media for enhancement">
      <div className="type-tabs" role="tablist" aria-label="Media type">
        {MEDIA_TYPES.map((type, index) => (
          <button
            key={type}
            type="button"
            role="tab"
            id={tabId(type)}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            aria-selected={type === mediaType}
            aria-controls={panelId(type)}
            tabIndex={type === mediaType ? 0 : -1}
            className={type === mediaType ? "active" : undefined}
            onKeyDown={(event) => onTabKeyDown(event, index)}
            onClick={() => {
              setMediaType(type);
              setError(null);
            }}
          >
            {MEDIA_TYPE_LABELS[type]}
          </button>
        ))}
      </div>

      <div
        className="tab-panel"
        role="tabpanel"
        id={panelId(mediaType)}
        aria-labelledby={tabId(mediaType)}
      >
        {mediaType === "text" ? (
          <div className="field">
            <label htmlFor="upload-text">Text to enhance</label>
            <textarea
              id="upload-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Paste or write the text this room should enhance…"
              disabled={disabled}
            />
          </div>
        ) : (
          <div className="file-row field">
            <label htmlFor="upload-file">{MEDIA_TYPE_LABELS[mediaType]} file</label>
            <input
              id="upload-file"
              ref={fileInputRef}
              type="file"
              accept={FILE_ACCEPT[mediaType]}
              disabled={disabled}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>
        )}
      </div>

      <div className="strategy-row">
        <div>
          <label htmlFor="upload-strategy">Enhancement strategy</label>
          <select
            id="upload-strategy"
            value={strategy}
            onChange={(event) => setStrategy(event.target.value)}
            disabled={disabled || forType.length === 0}
            aria-describedby="strategy-desc"
          >
            {forType.length === 0 && <option value="">No strategies registered</option>}
            {forType.map((entry) => (
              <option key={entry.name} value={entry.name} disabled={!entry.available}>
                {entry.label}
                {entry.isDefault ? " (default)" : ""}
                {entry.available ? "" : " — unavailable"}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="primary" disabled={!canSubmit}>
          {busy ? "Uploading…" : "Upload & enhance"}
        </button>
      </div>

      <p className="strategy-desc" id="strategy-desc">
        {strategiesError ?? selected?.description ?? "Pick how this media should be enhanced."}
      </p>

      {error && (
        <p className="error-text" role="alert">
          <span aria-hidden="true">✕</span>
          {error}
        </p>
      )}
    </form>
  );
}
