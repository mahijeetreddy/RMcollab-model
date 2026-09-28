import type { MediaType, StrategyDescriptor } from "@rmcollab/shared";
import { formatDuration, type Detected } from "./detect";

/**
 * From "what is this" to "what should we do with it": the proposals shown when
 * something is added to a room, ranked, in plain language.
 *
 * Proposals are built from the strategies the workers advertise right now, so
 * a pool that is down, or a model that is not configured, shows as unavailable
 * with the reason instead of vanishing - and a new strategy appears with its
 * own label without a change here.
 */

export interface Proposal {
  strategy: string;
  title: string;
  /** One line on what it does, or why it is recommended for this item. */
  detail: string;
  recommended: boolean;
  available: boolean;
}

interface Intent {
  title: string;
  detail: string;
}

/** Plain-language names for the strategies people choose between. */
const INTENTS: Record<MediaType, Record<string, Intent>> = {
  text: {
    summarise: { title: "Summarise", detail: "Key points, decisions and action items" },
    rewrite: { title: "Polish the writing", detail: "Clearer and more readable, same meaning" },
    rulebased: { title: "Fix typos only", detail: "Spelling and spacing, offline and instant" },
  },
  image: {
    notes: { title: "Read into notes", detail: "Types up what is written, describes diagrams" },
    realesrgan: { title: "Sharpen & upscale", detail: "Four times the resolution, with AI" },
    classical: { title: "Quick brightness fix", detail: "Evens out light and contrast, in a second" },
  },
  audio: {
    comprehend: { title: "Transcribe & summarise", detail: "A timestamped transcript and a summary" },
    transcribe: { title: "Transcript only", detail: "Every word, timestamped" },
    spectral: { title: "Reduce background noise", detail: "Cleaner sound to listen to" },
    deepfilternet: { title: "Reduce noise (stronger)", detail: "A learned denoiser, for very noisy audio" },
  },
  video: {
    comprehend: { title: "Transcribe & summarise", detail: "From the soundtrack, with timestamps that jump the video" },
    realesrgan: { title: "Upscale video", detail: "Sharper frames with AI; slow on long clips" },
    classical: { title: "Quick colour fix", detail: "Evens out light and colour across frames" },
  },
};

/** Long enough that a summary beats polishing every sentence. */
export const SUMMARY_WORDS = 400;
/** Images this small benefit visibly from upscaling. */
const SMALL_IMAGE_EDGE = 900;

function reason(detected: Detected, strategy: string): string | null {
  // A reason only where it argues for the option: "11 words is a lot to
  // polish" beside Summarise was nonsense on a short note.
  if (detected.kind === "text" && strategy === "summarise" && detected.words && detected.words >= SUMMARY_WORDS) {
    return `${detected.words.toLocaleString()} words is a lot to polish line by line`;
  }
  if (detected.kind === "text" && strategy === "rewrite" && detected.words !== undefined && detected.words < SUMMARY_WORDS) {
    return "Short enough to polish sentence by sentence";
  }
  if (detected.kind === "image" && strategy === "realesrgan" && detected.width && detected.height) {
    if (Math.max(detected.width, detected.height) < SMALL_IMAGE_EDGE) {
      return `Only ${detected.width}×${detected.height}: upscaling will show`;
    }
  }
  if ((detected.kind === "audio" || detected.kind === "video") && strategy === "comprehend" && detected.durationS) {
    // Measured: about a tenth of real time to transcribe, plus the summary.
    const estimate = Math.max(30, detected.durationS * 0.12 + 20);
    return `About ${formatDuration(estimate)} for ${formatDuration(detected.durationS)}`;
  }
  return null;
}

/** The strategy to preselect, before any availability fallback. */
function preferred(detected: Detected, forKind: StrategyDescriptor[]): string | undefined {
  const has = (name: string) => forKind.some((s) => s.name === name && s.available);
  if (detected.kind === "text" && detected.words !== undefined) {
    // Length decides: a long document wants a summary, a short one polish.
    if (detected.words >= SUMMARY_WORDS && has("summarise")) return "summarise";
    if (detected.words < SUMMARY_WORDS && has("rewrite")) return "rewrite";
  }
  return (forKind.find((s) => s.isDefault && s.available) ?? forKind.find((s) => s.available))?.name;
}

/**
 * Ranked proposals for one item: the recommended one first, then the other
 * named intents that can run, then those that cannot (with why). Strategies
 * without a plain-language intent are left to "More options".
 */
export function recommend(detected: Detected, strategies: StrategyDescriptor[]): Proposal[] {
  const forKind = strategies.filter((s) => s.mediaType === detected.kind);
  const intents = INTENTS[detected.kind];
  const pick = preferred(detected, forKind);

  const proposals: Proposal[] = forKind
    .filter((s) => intents[s.name])
    .map((s) => {
      const intent = intents[s.name]!;
      return {
        strategy: s.name,
        title: intent.title,
        detail: s.available ? (reason(detected, s.name) ?? intent.detail) : `Unavailable right now: ${unavailableWhy(s)}`,
        recommended: s.name === pick,
        available: s.available,
      };
    });

  const order = Object.keys(intents);
  return proposals.sort(
    (a, b) =>
      Number(b.recommended) - Number(a.recommended) ||
      Number(b.available) - Number(a.available) ||
      order.indexOf(a.strategy) - order.indexOf(b.strategy),
  );
}

function unavailableWhy(s: StrategyDescriptor): string {
  if (s.mediaType === "image" && s.name === "notes") return "no image-reading model is configured";
  if (s.name === "summarise" || s.name === "rewrite") return "no language model is configured";
  return "the worker for it is not running";
}

/** Every advertised strategy for the kind, for the "More options" escape hatch. */
export function allOptions(kind: MediaType, strategies: StrategyDescriptor[]): StrategyDescriptor[] {
  return strategies.filter((s) => s.mediaType === kind);
}
