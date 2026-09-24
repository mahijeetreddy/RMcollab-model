import type { WebSocket } from "ws";

/** Local sockets only — one of these exists per gateway replica. */
class SocketRegistry {
  private readonly groups = new Map<string, Set<WebSocket>>();

  /** True when this socket is the first local member of the key. */
  add(key: string, socket: WebSocket): boolean {
    let group = this.groups.get(key);
    if (!group) {
      group = new Set();
      this.groups.set(key, group);
    }
    const wasEmpty = group.size === 0;
    group.add(socket);
    return wasEmpty;
  }

  /** True when this socket was the last local member of the key. */
  remove(key: string, socket: WebSocket): boolean {
    const group = this.groups.get(key);
    if (!group) return false;
    group.delete(socket);
    if (group.size > 0) return false;
    this.groups.delete(key);
    return true;
  }

  members(key: string): Iterable<WebSocket> {
    return this.groups.get(key) ?? [];
  }

  keys(): Iterable<string> {
    return this.groups.keys();
  }

  size(key: string): number {
    return this.groups.get(key)?.size ?? 0;
  }
}

export const roomRegistry = new SocketRegistry();
export const sessionRegistry = new SocketRegistry();
