/**
 * A request, usually from the library, to bring one document into view. The
 * nonce makes opening the same document twice a second request rather than a
 * no-op, so every click scrolls.
 */
export interface DocumentFocus {
  mediaItemId: string;
  artifactId: string;
  atSeconds: number | null;
  nonce: number;
}
