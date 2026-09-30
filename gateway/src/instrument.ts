/**
 * Error tracking. Imported first by each entry point, before anything else
 * loads, which is what the SDK asks for. With SENTRY_DSN unset (local runs, the
 * tests) it does nothing at all and nothing leaves the machine.
 *
 * Errors only: no performance tracing, no profiling. Every console.error in the
 * gateway becomes a report, so the background loops (job events, embeddings,
 * webhooks) that log and carry on are covered without a call at each site.
 * scrubEvent strips what a report may not carry: see shared/src/scrub.ts.
 */
import * as Sentry from "@sentry/node";
import { scrubEvent } from "@rmcollab/shared";

const dsn = process.env.SENTRY_DSN?.trim();

/** The SDK collects bodies, headers, local variables and query data by default. */
export const NOTHING: NonNullable<Sentry.NodeOptions["dataCollection"]> = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  queues: false,
  genAI: { inputs: false, outputs: false },
  stackFrameVariables: false,
};

export const errorTracking = Boolean(dsn);

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? "development",
    release: process.env.SENTRY_RELEASE,
    // Collect none of it; scrubEvent then removes whatever still gets through.
    dataCollection: NOTHING,
    // No tracesSampleRate, not even 0: the SDK treats any number as "tracing on"
    // and loads its performance instrumentation, which puts a listener on every
    // response for each Express layer it passes (MaxListenersExceededWarning).
    integrations: [Sentry.captureConsoleIntegration({ levels: ["error"] })],
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => (crumb.category === "console" ? null : crumb),
  });
}

/** Sends what is still queued before the process exits. */
export async function flushErrors(): Promise<void> {
  if (dsn) await Sentry.flush(2000).catch(() => undefined);
}
