import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
} from "@rmcollab/shared";
import { config } from "../config.js";
import { getPendingWebhookDelivery, recordWebhookAttempt } from "../db/repositories.js";
import { scheduleDelivery } from "./queue.js";
import { signPayload } from "./signature.js";
import { validateWebhookUrl } from "./urlGuard.js";

interface AttemptOutcome {
  statusCode: number | null;
  error: string | null;
  latencyMs: number;
  delivered: boolean;
  retryable: boolean;
}

/** Full jitter on the second half of the window: a receiver that fails a burst
 * of deliveries at once doesn't get them all back in lockstep. */
export function backoffMs(attempt: number): number {
  const { backoffBaseMs, backoffCapMs } = config.webhooks;
  const window = Math.min(backoffCapMs, backoffBaseMs * 2 ** (attempt - 1));
  return Math.round(window / 2 + Math.random() * (window / 2));
}

async function send(url: string, secret: string, body: string, headers: {
  eventType: string;
  deliveryId: string;
}): Promise<AttemptOutcome> {
  const startedAt = Date.now();
  const timestamp = Math.floor(startedAt / 1000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "RMcollab-Webhooks/1.0",
        [WEBHOOK_SIGNATURE_HEADER]: signPayload(body, secret, timestamp),
        [WEBHOOK_EVENT_HEADER]: headers.eventType,
        [WEBHOOK_DELIVERY_HEADER]: headers.deliveryId,
      },
      body,
      // A hanging receiver must not tie up a delivery slot indefinitely.
      signal: AbortSignal.timeout(config.webhooks.timeoutMs),
    });

    const text = await response.text().catch(() => "");
    const latencyMs = Date.now() - startedAt;
    if (response.ok) {
      return { statusCode: response.status, error: null, latencyMs, delivered: true, retryable: false };
    }
    // 429 and 5xx are the receiver being busy or broken; any other 4xx is the
    // receiver rejecting this request on its merits, and replaying it unchanged
    // will be rejected the same way forever.
    const retryable = response.status === 429 || response.status >= 500;
    return {
      statusCode: response.status,
      error: `HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      latencyMs,
      delivered: false,
      retryable,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const name = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message : String(err);
    return {
      statusCode: null,
      error: name === "TimeoutError" || name === "AbortError" ? `timeout after ${latencyMs}ms` : message,
      latencyMs,
      delivered: false,
      retryable: true,
    };
  }
}

export async function attemptDelivery(deliveryId: string): Promise<void> {
  const delivery = await getPendingWebhookDelivery(deliveryId);
  if (!delivery || delivery.terminal || delivery.delivered) return;

  const attempt = delivery.attempt + 1;

  const fail = (error: string): Promise<unknown> =>
    recordWebhookAttempt({
      id: delivery.id,
      attempt,
      statusCode: null,
      error,
      latencyMs: null,
      delivered: false,
      terminal: true,
      nextAttemptAt: null,
    });

  if (!delivery.endpointActive) {
    await fail("endpoint is deactivated");
    return;
  }

  // Re-checked per attempt, not just at registration: DNS behind the hostname
  // can change after the endpoint was accepted.
  const check = await validateWebhookUrl(delivery.url);
  if (!check.ok) {
    await fail(check.reason ?? "url rejected");
    return;
  }

  const body = JSON.stringify(delivery.payload);
  const outcome = await send(delivery.url, delivery.secret, body, {
    eventType: delivery.eventType,
    deliveryId: delivery.id,
  });

  const exhausted = attempt >= config.webhooks.maxAttempts;
  const willRetry = !outcome.delivered && outcome.retryable && !exhausted;
  const nextAttemptAt = willRetry ? Date.now() + backoffMs(attempt) : null;

  let error: string | null = null;
  if (!outcome.delivered) {
    error = outcome.error ?? "delivery failed";
    if (outcome.retryable && exhausted) error += " (retries exhausted)";
  }

  await recordWebhookAttempt({
    id: delivery.id,
    attempt,
    statusCode: outcome.statusCode,
    error,
    latencyMs: outcome.latencyMs,
    delivered: outcome.delivered,
    terminal: !willRetry,
    nextAttemptAt,
  });

  if (willRetry && nextAttemptAt) {
    await scheduleDelivery(delivery.id, nextAttemptAt);
    console.log(
      `[webhooks] ${delivery.id} attempt ${attempt} failed (${outcome.statusCode ?? "net"}), retrying in ${nextAttemptAt - Date.now()}ms`,
    );
    return;
  }

  console.log(
    `[webhooks] ${delivery.id} attempt ${attempt} ${outcome.delivered ? "delivered" : "failed terminally"} ` +
      `status=${outcome.statusCode ?? "-"} latency=${outcome.latencyMs}ms`,
  );
}
