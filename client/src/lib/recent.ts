/**
 * Sessions this browser has joined, for one-click rejoining from the landing
 * page. Kept in localStorage, never sent anywhere: there are no accounts, so
 * this is what "my rooms" is. The participant id comes back with you, which is
 * what lets you still rename or delete your own uploads after closing the tab.
 */

export interface RecentSession {
  code: string;
  name: string | null;
  displayName: string;
  participantId: string | null;
  lastVisited: number;
}

const KEY = "rmcollab:recent-sessions";
/** Enough to find last week's group; a long list stops being quick. */
const MAX = 6;

function valid(value: unknown): value is RecentSession {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["code"] === "string" &&
    /^[A-Z0-9]{4,12}$/.test(v["code"]) &&
    (v["name"] === null || typeof v["name"] === "string") &&
    typeof v["displayName"] === "string" &&
    (v["participantId"] === null || typeof v["participantId"] === "string") &&
    typeof v["lastVisited"] === "number"
  );
}

export function loadRecent(): RecentSession[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(valid).sort((a, b) => b.lastVisited - a.lastVisited).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

function save(list: RecentSession[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // Private windows can refuse storage; rejoining by code still works.
  }
}

export function rememberSession(entry: Omit<RecentSession, "lastVisited">): void {
  // By code, and by participant too: a session whose code changed is the same session.
  const rest = loadRecent().filter(
    (s) => s.code !== entry.code && !(entry.participantId && s.participantId === entry.participantId),
  );
  save([{ ...entry, lastVisited: Date.now() }, ...rest]);
}

/** By code, and by participant: after the session's code changed, its entry is under the new one. */
export function forgetSession(code: string, participantId?: string | null): void {
  save(loadRecent().filter((s) => s.code !== code && !(participantId && s.participantId === participantId)));
}

/** "just now", "5 min ago", "yesterday", "3 days ago". */
export function visitedAgo(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
