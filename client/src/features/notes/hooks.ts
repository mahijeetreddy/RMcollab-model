import { useEffect, useState } from "react";
import * as Y from "yjs";
import { safeColor } from "../../lib/colors";
import type { Realtime } from "../../ws/useRealtime";
import { RoomDocProvider, type CollaboratorUser, type SyncStatus } from "./provider";

export interface DocSession {
  doc: Y.Doc;
  provider: RoomDocProvider;
}

/**
 * One room's document and its connection. Created and destroyed by the same
 * effect, never in render or useMemo: StrictMode mounts, unmounts and remounts
 * in development, and a document built outside the effect would be destroyed by
 * the first cleanup while the editor was still bound to it.
 */
export function useRoomDoc(realtime: Realtime, roomId: string, user: CollaboratorUser) {
  const { sendDoc, subscribeDoc } = realtime;
  const [session, setSession] = useState<DocSession | null>(null);
  const [status, setStatus] = useState<SyncStatus>("connecting");

  useEffect(() => {
    const doc = new Y.Doc();
    const provider = new RoomDocProvider(doc, (data) => sendDoc(roomId, data), user);
    const unsubscribe = subscribeDoc((forRoom, data) => {
      if (forRoom === roomId) provider.receive(data);
    });
    const stopStatus = provider.onStatus(setStatus);
    setSession({ doc, provider });
    return () => {
      stopStatus();
      unsubscribe();
      provider.destroy();
      doc.destroy();
      setSession(null);
    };
    // The user's identity is fixed while the view is mounted, so it is not a
    // dependency: a rename should not rebuild the document.
  }, [roomId, sendDoc, subscribeDoc]);

  // Every time the gateway confirms the room (first join, reconnect, switching
  // back), restart the sync handshake: it exchanges exactly the difference.
  const live =
    realtime.status === "online" && realtime.state.synced && realtime.state.activeRoomId === roomId;
  useEffect(() => {
    if (!session) return;
    if (live) session.provider.connect();
    else session.provider.disconnected();
  }, [live, session]);

  return { session, status };
}

/** Everyone else with the notes open, one entry per person. */
export function useCollaborators(provider: RoomDocProvider | null, meId: string): CollaboratorUser[] {
  const [users, setUsers] = useState<CollaboratorUser[]>([]);
  useEffect(() => {
    if (!provider) return;
    const read = () => {
      const seen = new Map<string, CollaboratorUser>();
      provider.awareness.getStates().forEach((state, clientId) => {
        const user = (state as { user?: Partial<CollaboratorUser> }).user;
        if (clientId === provider.doc.clientID || !user || typeof user.id !== "string" || user.id === meId) return;
        // Another browser wrote this: keep only a plain name and a hex colour.
        seen.set(user.id, {
          id: user.id,
          name: typeof user.name === "string" && user.name.trim() ? user.name.slice(0, 64) : "Someone",
          color: safeColor(user.color, user.id),
        });
      });
      setUsers([...seen.values()].sort((a, b) => a.name.localeCompare(b.name)));
    };
    read();
    provider.awareness.on("change", read);
    return () => provider.awareness.off("change", read);
  }, [provider, meId]);
  return users;
}
