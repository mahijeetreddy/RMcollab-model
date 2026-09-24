import type { JobStatus } from "./domain.js";
import type { JobEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Webhooks — outbound HTTP delivery of job lifecycle events.
// The dispatcher reads JOB_EVENT_STREAM under its own consumer group and posts
// a WebhookEventPayload to every active endpoint of the event's session.
// ---------------------------------------------------------------------------

/** Sorted set of delivery ids scored by due-at epoch ms. */
export const WEBHOOK_RETRY_ZSET = "rmcollab:webhook-retries";

export const WEBHOOK_SIGNATURE_HEADER = "X-RMcollab-Signature";
export const WEBHOOK_EVENT_HEADER = "X-RMcollab-Event";
export const WEBHOOK_DELIVERY_HEADER = "X-RMcollab-Delivery";

export type WebhookEventType = `job.${JobStatus}`;

export interface WebhookEventPayload {
  id: string;
  type: WebhookEventType;
  createdAt: number;
  data: JobEvent;
}

export interface WebhookEndpoint {
  id: string;
  sessionId: string;
  url: string;
  active: boolean;
  createdAt: number;
  /** Returned once, at creation time only. */
  secret?: string;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventType: string;
  attempt: number;
  statusCode: number | null;
  error: string | null;
  latencyMs: number | null;
  delivered: boolean;
  /** No further attempts will be made: succeeded, rejected, or retries exhausted. */
  terminal: boolean;
  createdAt: number;
  lastAttemptAt: number | null;
  nextAttemptAt: number | null;
}
