import { QUEUES, type MediaType, type StrategyDescriptor } from "@rmcollab/shared";

/**
 * Capability routing. Workers advertise each strategy they can run together with
 * the queue that reaches them (workers/common/advertise.py), and jobs are sent to
 * that queue - not simply to the queue named after the media type. That is what
 * lets video comprehension run in the audio pool, next to the Whisper model it
 * needs, while video upscaling stays in the video pool.
 */

/**
 * One strategy as a worker advertised it, in the worker's snake_case. Mirrors
 * StrategyAdvert in workers/common/contracts.py; `npm run check:contracts`
 * fails if they drift.
 */
export interface StrategyAdvert {
  name: string;
  label: string;
  description: string;
  media_type: MediaType;
  is_default: boolean;
  available: boolean;
  explicit_default: boolean;
  queue: string;
}

export interface Catalogue {
  strategies: StrategyDescriptor[];
  /** `${mediaType}:${name}` -> queue that reaches a worker able to run it. */
  queues: Map<string, string>;
}

const routeKey = (mediaType: string, name: string) => `${mediaType}:${name}`;

/**
 * Each pool only knows its own registry, so each can claim a default for the
 * same media type: the audio pool declares comprehension as video's default,
 * while the video pool, alone, falls back to classical. One default per media
 * type is chosen here, preferring in order: declared and available, available,
 * declared, anything - so an outage degrades to what can still run.
 */
export function buildCatalogue(adverts: StrategyAdvert[]): Catalogue {
  const queues = new Map<string, string>();
  const byMedia = new Map<MediaType, StrategyAdvert[]>();
  for (const advert of adverts) {
    // `??` because a worker from before capability routing, still running
    // during a rolling deploy, sends no queue: it serves its media type's own.
    queues.set(routeKey(advert.media_type, advert.name), advert.queue ?? QUEUES[advert.media_type]);
    byMedia.set(advert.media_type, [...(byMedia.get(advert.media_type) ?? []), advert]);
  }

  const defaults = new Map<MediaType, string>();
  for (const [mediaType, group] of byMedia) {
    const pick =
      group.find((a) => a.explicit_default && a.available) ??
      group.find((a) => a.is_default && a.available) ??
      group.find((a) => a.available) ??
      group.find((a) => a.explicit_default) ??
      group[0];
    if (pick) defaults.set(mediaType, pick.name);
  }

  const strategies: StrategyDescriptor[] = adverts.map((a) => ({
    mediaType: a.media_type,
    name: a.name,
    label: a.label,
    description: a.description,
    isDefault: defaults.get(a.media_type) === a.name,
    available: a.available,
  }));
  strategies.sort((a, b) =>
    a.mediaType === b.mediaType
      ? Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name)
      : a.mediaType.localeCompare(b.mediaType),
  );
  return { strategies, queues };
}

/**
 * The queue for a job. "auto" goes wherever the merged default runs; a named
 * strategy to the pool that advertised it. Anything unknown - no adverts yet, a
 * pool that just went down - goes to the media type's own queue, whose worker
 * resolves a fallback and reports why, rather than the job being refused here.
 */
export function queueFor(catalogue: Catalogue, mediaType: MediaType, strategy: string, auto: string): string {
  const name =
    strategy === auto
      ? catalogue.strategies.find((s) => s.mediaType === mediaType && s.isDefault)?.name
      : strategy;
  return (name && catalogue.queues.get(routeKey(mediaType, name))) || QUEUES[mediaType];
}
