import * as Y from "yjs";
import { appendRoomDocUpdate, compactRoomDoc, loadRoomDocParts } from "../db/roomDocs.js";
import { pubsub } from "../ws/pubsub.js";
import { RoomDocHub } from "./roomDocs.js";

/** The process-wide hub: Postgres for storage, Redis for cross-replica fan-out. */
export const docHub = new RoomDocHub({
  store: {
    load: loadRoomDocParts,
    append: appendRoomDocUpdate,
    compact: (roomId) => compactRoomDoc(roomId, (parts) => Y.mergeUpdates(parts)),
  },
  publish: (roomId, data, from) => pubsub.publishToRoom(roomId, { type: "doc", roomId, data, from }),
});
