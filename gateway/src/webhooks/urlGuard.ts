import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";

export interface UrlCheck {
  ok: boolean;
  reason?: string;
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(address: string): boolean {
  const lower = address.toLowerCase().split("%")[0]!;
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") ||
      lower.startsWith("feb")) {
    return true;
  }
  if (lower.startsWith("ff")) return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return false;
}

export const isPrivateAddress = (address: string): boolean =>
  net.isIPv4(address) ? isPrivateIPv4(address) : isPrivateIPv6(address);

/**
 * The hostname is resolved rather than pattern-matched: `internal.example.com`
 * or a decimal-encoded literal both look public as strings and still land on
 * 127.0.0.1. (A determined attacker can still rebind DNS between this check and
 * the request; blocking egress at the network is the real fix in production.)
 */
export async function validateWebhookUrl(raw: string): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "url must be a valid absolute URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "url must use http or https" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "url must not contain credentials" };
  }
  if (config.webhooks.allowPrivateUrls) return { ok: true };

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    return isPrivateAddress(host)
      ? { ok: false, reason: "url resolves to a private or loopback address" }
      : { ok: true };
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    return { ok: false, reason: "url hostname could not be resolved" };
  }
  if (addresses.length === 0) return { ok: false, reason: "url hostname could not be resolved" };
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    return { ok: false, reason: "url resolves to a private or loopback address" };
  }
  return { ok: true };
}
