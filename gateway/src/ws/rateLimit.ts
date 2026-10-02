/**
 * Per-connection limits on what a socket may send. Uploads and questions have
 * their own limits (limits.ts, ask/service.ts), because they cost model or GPU
 * time; these stop the cheap things - chat, typing, notes frames - from being
 * used to flood a room. Kept in memory, per socket: exact across replicas is not
 * the point, keeping one connection from drowning everyone else in it is.
 *
 * Token buckets: a burst up to `capacity`, then `perSecond` sustained. Honest
 * use never comes near them - the client already coalesces typing. Notes are
 * the generous one: every keystroke is an edit frame plus a cursor frame, and a
 * test typing 570 characters at machine speed was cut off by the first, tighter
 * numbers (300 at once, 60 a second).
 */

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  /** Takes `cost` tokens if there are enough; false (and takes none) if not. */
  take(cost = 1, now = Date.now()): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

export interface SocketLimits {
  chat: TokenBucket;
  typing: TokenBucket;
  joins: TokenBucket;
  /** Notes frames, counted. */
  docFrames: TokenBucket;
  /** Notes frames, by size: a full sync of a large document is one big frame. */
  docBytes: TokenBucket;
}

export function socketLimits(now = Date.now()): SocketLimits {
  return {
    chat: new TokenBucket(10, 1, now),
    typing: new TokenBucket(20, 4, now),
    joins: new TokenBucket(10, 0.5, now),
    docFrames: new TokenBucket(3000, 300, now),
    docBytes: new TokenBucket(16 * 1024 * 1024, 2 * 1024 * 1024, now),
  };
}
