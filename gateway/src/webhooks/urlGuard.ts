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

/**
 * The IPv4 address carried in the low 32 bits of an IPv4-mapped (::ffff:0:0/96),
 * IPv4-compatible (::/96) or NAT64 (64:ff9b::/96) address, or null.
 *
 * Both spellings must be decoded. Node's URL parser rewrites the dotted form to
 * hex - `[::ffff:169.254.169.254]` arrives here as `::ffff:a9fe:a9fe` - so a check
 * that only understands the dotted form lets the cloud metadata address through.
 */
function embeddedIPv4(lower: string): string | null {
  const match = lower.match(
    /^(?:::ffff:|::|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/,
  );
  if (!match) return null;
  if (match[1]) return match[1];
  const high = parseInt(match[2]!, 16);
  const low = parseInt(match[3]!, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isPrivateIPv6(address: string): boolean {
  const lower = address.toLowerCase().split("%")[0]!;
  if (lower === "::" || lower === "::1") return true;
  const v4 = embeddedIPv4(lower);
  if (v4) return isPrivateIPv4(v4);
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") ||
      lower.startsWith("feb")) {
    return true;
  }
  if (lower.startsWith("ff")) return true;
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
