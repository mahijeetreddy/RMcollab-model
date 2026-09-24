import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const generateSecret = (): string => `whsec_${randomBytes(32).toString("base64url")}`;

/**
 * Stripe-style `t=<unix_seconds>,v1=<hex>` over `${t}.${rawBody}`. The timestamp
 * is inside the signed string so a receiver can reject a replayed-but-valid body
 * by age; signing the body alone would make captured requests valid forever.
 */
export function signPayload(
  rawBody: string,
  secret: string,
  timestampSeconds: number,
): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest("hex");
  return `t=${timestampSeconds},v1=${digest}`;
}

export function verifySignature(
  rawBody: string,
  secret: string,
  header: string,
  toleranceSeconds = 300,
): boolean {
  const parts = new Map(
    header.split(",").map((part) => {
      const index = part.indexOf("=");
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1");
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;

  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"),
  );
  const actual = Buffer.from(v1);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
