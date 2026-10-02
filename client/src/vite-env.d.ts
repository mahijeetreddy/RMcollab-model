/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GATEWAY_HTTP?: string;
  readonly VITE_GATEWAY_WS?: string;
  /** Error tracking; off when unset. See lib/errorTracking.ts. */
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_ENVIRONMENT?: string;
  /** Shown on the privacy page as who to write to; nothing is shown when unset. */
  readonly VITE_CONTACT_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
