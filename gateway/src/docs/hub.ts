import { parseDocKey } from "@rmcollab/shared/notes";
import * as Y from "yjs";
import {
  appendRoomDocUpdate,
  compactRoomDoc,
  latestRoomDocVersionAt,
  loadRoomDocParts,
  saveRoomDocVersion,
} from "../db/roomDocs.js";
import { pubsub } from "../ws/pubsub.js";
import { RoomDocHub } from "./roomDocs.js";

/** The process-wide hub: Postgres for storage, Redis for cross-replica fan-out. */
export const docHub = new RoomDocHub({
  store: {
    load: loadRoomDocParts,
    append: appendRoomDocUpdate,
    compact: (roomId) => compactRoomDoc(roomId, (parts) => Y.mergeUpdates(parts)),
  },
  history: { save: saveRoomDocVersion, latestAt: latestRoomDocVersionAt },
  // The hub knows documents by key; the room channel carries which one.
  publish: (key, data, from) => {
    const { roomId, docId } = parseDocKey(key);
    return pubsub.publishToRoom(roomId, { type: "doc", roomId, docId, data, from });
  },
});
