/**
 * What an error report may carry off to the error tracker (Sentry), for the
 * gateway and the browser alike. The rule: a report says where it broke and
 * how, never what anyone wrote or who they are. So request bodies, headers,
 * cookies and query strings go; so does any user; and session codes - the one
 * thing that lets a stranger into a room - are blanked wherever they appear.
 *
 * Deliberately untyped against the SDK so this package needs no dependency on
 * it: an event is treated as the plain JSON it becomes on the wire.
 */

/** A session code, with or without its dash (see SESSION_CODE_ALPHABET in domain.ts). */
const CODE = /\b[A-HJ-NP-Z2-9]{5}-?[A-HJ-NP-Z2-9]{5}\b/g;

export const redactCodes = (text: string): string => text.replace(CODE, "[code]");

type Loose = Record<string, unknown>;
const isRecord = (v: unknown): v is Loose => typeof v === "object" && v !== null && !Array.isArray(v);

/** Breadcrumbs worth keeping: navigation and requests, with their URLs cleaned. */
const KEPT_BREADCRUMBS = new Set(["navigation", "fetch", "xhr", "http"]);

function cleanUrl(url: unknown): unknown {
  if (typeof url !== "string") return url;
  // Query strings carry participant ids and the like; the path is enough to find the route.
  return redactCodes(url.split("?")[0]!);
}

export function scrubEvent<T extends object>(event: T): T {
  const e = event as Loose;
  delete e["user"];
  delete e["server_name"];

  if (isRecord(e["request"])) {
    const request = e["request"];
    for (const key of ["data", "cookies", "headers", "query_string", "env"]) delete request[key];
    request["url"] = cleanUrl(request["url"]);
  }

  if (typeof e["message"] === "string") e["message"] = redactCodes(e["message"]);
  if (typeof e["transaction"] === "string") e["transaction"] = redactCodes(e["transaction"]);

  const exception = e["exception"];
  if (isRecord(exception) && Array.isArray(exception["values"])) {
    for (const value of exception["values"]) {
      if (!isRecord(value)) continue;
      if (typeof value["value"] === "string") value["value"] = redactCodes(value["value"]);
      // A frame's local variables can hold anything: a note, a transcript, a name.
      const frames = isRecord(value["stacktrace"]) ? value["stacktrace"]["frames"] : undefined;
      if (Array.isArray(frames)) for (const frame of frames) if (isRecord(frame)) delete frame["vars"];
    }
  }
  delete e["extra"];

  if (Array.isArray(e["breadcrumbs"])) {
    e["breadcrumbs"] = e["breadcrumbs"]
      .filter((b): b is Loose => isRecord(b) && KEPT_BREADCRUMBS.has(String(b["category"] ?? b["type"])))
      .map((b) => {
        const data = isRecord(b["data"]) ? { ...b["data"] } : undefined;
        if (data) for (const key of ["url", "from", "to"]) if (key in data) data[key] = cleanUrl(data[key]);
        return { ...b, message: typeof b["message"] === "string" ? redactCodes(b["message"]) : b["message"], data };
      });
  }
  return event;
}
