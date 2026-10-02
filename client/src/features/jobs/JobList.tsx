import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { mediaTitle, type JobStatus, type MediaItemWithJob } from "@rmcollab/shared";
import type { DocumentFocus } from "./focus";
import type { Manage } from "./CardActions";
import { MediaJobCard } from "./MediaJobCard";
import { EmptyState } from "../EmptyState";
import { docIcons } from "../notes/icons";

interface Props {
  media: MediaItemWithJob[];
  focus?: DocumentFocus | null;
  manage?: Manage | null;
}

const TRANSITION_WORDS: Record<JobStatus, string> = {
  queued: "queued",
  processing: "started processing",
  done: "finished",
  failed: "failed",
};

function describe(entry: MediaItemWithJob, status: JobStatus): string {
  const name = mediaTitle(entry.mediaItem);
  return `${name} ${TRANSITION_WORDS[status]}`;
}

/** How often places in line are re-read while something here is waiting. */
const QUEUE_POLL_MS = 5000;

/**
 * Places in line for this room's waiting jobs, read while any are waiting and
 * not otherwise. The worker pools are shared by everyone, so on a busy host a
 * job can sit behind other sessions' work; a number says it is moving.
 */
function useQueuePositions(media: MediaItemWithJob[], manage: Manage | null): Record<string, number> {
  const [positions, setPositions] = useState<Record<string, number>>({});
  const waiting = media.some((entry) => (entry.job?.status ?? "queued") === "queued");
  const roomId = manage?.roomId;
  const meId = manage?.meId;
  useEffect(() => {
    if (!waiting || !roomId || !meId) {
      setPositions({});
      return;
    }
    let stopped = false;
    const read = () =>
      api
        .queuePositions(roomId, meId)
        .then((next) => !stopped && setPositions(next))
        .catch(() => undefined);
    void read();
    const timer = window.setInterval(read, QUEUE_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [waiting, roomId, meId]);
  return positions;
}

export function JobList({ media, focus = null, manage = null }: Props) {
  const positions = useQueuePositions(media, manage);
  // Only status transitions are announced. Progress ticks arrive several times
  // a second and would make the live region useless.
  const seenRef = useRef<Map<string, JobStatus> | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const next = new Map<string, JobStatus>();
    const changes: string[] = [];
    for (const entry of media) {
      const status = entry.job?.status ?? "queued";
      next.set(entry.mediaItem.id, status);
      const previous = seenRef.current?.get(entry.mediaItem.id);
      if (seenRef.current && previous !== status) changes.push(describe(entry, status));
    }
    seenRef.current = next;
    if (changes.length > 0) setAnnouncement(changes.join(". "));
  }, [media]);

  return (
    <>
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      {media.length === 0 ? (
        <EmptyState icon={docIcons.cloud} title="Nothing uploaded to this room yet">
          Add a recording, a whiteboard photo or some notes above. Everyone in the room sees each one here as it is
          processed.
        </EmptyState>
      ) : (
        <div className="job-list">
          {media.map((entry) => (
            <MediaJobCard
              key={entry.mediaItem.id}
              mediaItem={entry.mediaItem}
              job={entry.job}
              focus={focus?.mediaItemId === entry.mediaItem.id ? focus : null}
              manage={manage}
              ahead={entry.job ? positions[entry.job.id] : undefined}
            />
          ))}
        </div>
      )}
    </>
  );
}
