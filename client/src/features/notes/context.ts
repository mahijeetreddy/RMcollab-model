import { createContext, useContext } from "react";
import type { MediaItemWithJob } from "@rmcollab/shared";

/**
 * Live room state for things rendered inside the editor. An upload's section
 * shows its job's progress from here rather than from the document: progress
 * ticks several times a second, and writing each into the CRDT would be an
 * update and a stored row per tick for something nobody needs to keep.
 */
export interface NotesRoomContext {
  media: MediaItemWithJob[];
  openInFeed: (mediaItemId: string) => void;
}

export const NotesRoom = createContext<NotesRoomContext>({ media: [], openInFeed: () => undefined });

export const useNotesRoom = () => useContext(NotesRoom);
