/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GATEWAY_HTTP?: string;
  readonly VITE_GATEWAY_WS?: string;
  /** Error tracking; off when unset. See lib/errorTracking.ts. */
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_ENVIRONMENT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
