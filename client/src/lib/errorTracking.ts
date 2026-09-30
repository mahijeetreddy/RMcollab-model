/**
 * Error tracking in the browser. Off unless VITE_SENTRY_DSN is set at build
 * time (a browser DSN is public by design: it can only send reports).
 *
 * Errors only - no tracing, no session replay - and never what anyone typed:
 * the SDK is told to collect nothing, click breadcrumbs (whose selectors carry
 * labels like "Remove Bob") are dropped, and scrubEvent removes the rest.
 */
import * as Sentry from "@sentry/react";
import { scrubEvent } from "@rmcollab/shared";

const dsn = import.meta.env.VITE_SENTRY_DSN?.trim();

export function startErrorTracking(): void {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    // No tracesSampleRate, not even 0: any number counts as "tracing on".
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      queues: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
    },
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => (crumb.category?.startsWith("ui.") || crumb.category === "console" ? null : crumb),
  });
}
