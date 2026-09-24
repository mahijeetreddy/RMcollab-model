import type { RoomBroadcast, ServerEvent } from "@rmcollab/shared";
import { roomChannel, sessionChannel } from "@rmcollab/shared";
import { Redis } from "ioredis";
import { config } from "../config.js";

const ROOM_PREFIX = roomChannel("");
const SESSION_PREFIX = sessionChannel("");

export interface PubSubHandlers {
  onRoomEvent(roomId: string, event: ServerEvent): void;
  onSessionEvent(sessionId: string, event: ServerEvent): void;
}

// Delivery rule: publish-then-deliver-only-on-receive. A replica never writes a
// broadcast straight to its local sockets; every socket (including the
// publisher's own) gets the event from the Redis subscriber, so each is
// delivered exactly once and `originReplicaId` is diagnostic only.
class PubSub {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private handlers: PubSubHandlers | null = null;

  constructor() {
    this.publisher = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    this.subscriber = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    this.publisher.on("error", (err) => console.error("[pubsub] publisher", err.message));
    this.subscriber.on("error", (err) => console.error("[pubsub] subscriber", err.message));

    this.subscriber.on("message", (channel: string, payload: string) => {
      let broadcast: RoomBroadcast;
      try {
        broadcast = JSON.parse(payload) as RoomBroadcast;
      } catch {
        return;
      }
      if (!broadcast?.event) return;
      if (channel.startsWith(ROOM_PREFIX)) {
        this.handlers?.onRoomEvent(channel.slice(ROOM_PREFIX.length), broadcast.event);
      } else if (channel.startsWith(SESSION_PREFIX)) {
        this.handlers?.onSessionEvent(channel.slice(SESSION_PREFIX.length), broadcast.event);
      }
    });
  }

  setHandlers(handlers: PubSubHandlers): void {
    this.handlers = handlers;
  }

  async publishToRoom(roomId: string, event: ServerEvent): Promise<void> {
    const broadcast: RoomBroadcast = { originReplicaId: config.replicaId, event };
    await this.publisher.publish(roomChannel(roomId), JSON.stringify(broadcast));
  }

  async publishToSession(sessionId: string, event: ServerEvent): Promise<void> {
    const broadcast: RoomBroadcast = { originReplicaId: config.replicaId, event };
    await this.publisher.publish(sessionChannel(sessionId), JSON.stringify(broadcast));
  }

  subscribeRoom(roomId: string): Promise<unknown> {
    return this.subscriber.subscribe(roomChannel(roomId));
  }

  unsubscribeRoom(roomId: string): Promise<unknown> {
    return this.subscriber.unsubscribe(roomChannel(roomId));
  }

  subscribeSession(sessionId: string): Promise<unknown> {
    return this.subscriber.subscribe(sessionChannel(sessionId));
  }

  unsubscribeSession(sessionId: string): Promise<unknown> {
    return this.subscriber.unsubscribe(sessionChannel(sessionId));
  }

  ping(): Promise<string> {
    return this.publisher.ping();
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }
}

export const pubsub = new PubSub();
export type { PubSub };
