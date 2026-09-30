import { useEffect, useRef, useState } from "react";
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

export function JobList({ media, focus = null, manage = null }: Props) {
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
            />
          ))}
        </div>
      )}
    </>
  );
}
