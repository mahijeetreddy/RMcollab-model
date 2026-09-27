/** One timed line of a Whisper transcript, as written by workers/strategies/audio/transcribe.py. */
export interface Segment {
  /** Seconds from the start of the recording. */
  start: number;
  /** The stamp as written, e.g. "00:01:05". */
  stamp: string;
  text: string;
}

const STAMP = /^\[(\d{2,}):(\d{2}):(\d{2})\]\s?(.*)$/;

/**
 * Splits a transcript into timed segments. A line without a stamp continues the
 * segment before it, so hand-edited or wrapped text is kept rather than dropped;
 * text before the first stamp becomes a segment at zero.
 */
export function parseTranscript(text: string): Segment[] {
  const segments: Segment[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = STAMP.exec(line);
    if (match) {
      const [, h, m, s, body] = match;
      segments.push({
        start: Number(h) * 3600 + Number(m) * 60 + Number(s),
        stamp: `${h}:${m}:${s}`,
        text: (body ?? "").trim(),
      });
      continue;
    }
    const last = segments[segments.length - 1];
    if (last) last.text = last.text ? `${last.text} ${line}` : line;
    else segments.push({ start: 0, stamp: "00:00:00", text: line });
  }
  return segments;
}

/** Case-insensitive match positions of `query` in `text`, for highlighting. */
export function findMatches(text: string, query: string): Array<[number, number]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const haystack = text.toLowerCase();
  const out: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return out;
    out.push([at, at + needle.length]);
    from = at + needle.length;
  }
}

/** "1:05" or "1:02:05": the shortest readable form of a duration in seconds. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
