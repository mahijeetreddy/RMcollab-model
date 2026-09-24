import { useEffect, useRef, useState } from "react";
import type { JobStatus, MediaItemWithJob } from "@rmcollab/shared";
import { MediaJobCard } from "./MediaJobCard";

interface Props {
  media: MediaItemWithJob[];
}

const TRANSITION_WORDS: Record<JobStatus, string> = {
  queued: "queued",
  processing: "started processing",
  done: "finished",
  failed: "failed",
};

function describe(entry: MediaItemWithJob, status: JobStatus): string {
  const name = entry.mediaItem.originalFilename ?? `${entry.mediaItem.mediaType} item`;
  return `${name} ${TRANSITION_WORDS[status]}`;
}

export function JobList({ media }: Props) {
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
        <p className="empty">Nothing uploaded to this room yet.</p>
      ) : (
        <div className="job-list">
          {media.map((entry) => (
            <MediaJobCard key={entry.mediaItem.id} mediaItem={entry.mediaItem} job={entry.job} />
          ))}
        </div>
      )}
    </>
  );
}
