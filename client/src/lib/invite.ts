import { formatSessionCode, normalizeSessionCode } from "@rmcollab/shared";

/**
 * Links into a session. Two kinds:
 *
 *   /join/ABCDE-23456            an invitation: opens the join screen with the
 *                                code filled in.
 *   /join/ABCDE-23456#as=<id>    this same person, on another device: joining
 *                                with it continues as them - their uploads,
 *                                and ownership if they started the session.
 *
 * The second is how ownership survives a cleared browser without accounts: a
 * participant id is the identity, so carrying it is carrying the identity. It
 * sits after the #, which browsers never send to a server, so it stays out of
 * request logs and Referer headers. Anyone holding it is that person, which the
 * page that hands it out says plainly.
 */

const JOIN_PATH = /^\/join\/([A-Za-z0-9-]{4,24})\/?$/;
const AS = /(?:^|&)as=([A-Za-z0-9_-]{4,64})(?:&|$)/;

export interface Invite {
  code: string;
  /** Present on a "use on another device" link. */
  participantId: string | null;
}

export function inviteUrl(code: string, origin = window.location.origin): string {
  return `${origin}/join/${formatSessionCode(code)}`;
}

export function deviceUrl(code: string, participantId: string, origin = window.location.origin): string {
  return `${inviteUrl(code, origin)}#as=${encodeURIComponent(participantId)}`;
}

export function readInvite(location: Pick<Location, "pathname" | "hash"> = window.location): Invite | null {
  const path = JOIN_PATH.exec(location.pathname);
  if (!path) return null;
  const code = normalizeSessionCode(path[1]!);
  if (!code) return null;
  const as = AS.exec(location.hash.replace(/^#/, ""));
  return { code, participantId: as ? decodeURIComponent(as[1]!) : null };
}

/** Back to the plain address once used, so a reload or a shared screenshot does not carry it on. */
export function clearInvite(): void {
  if (JOIN_PATH.test(window.location.pathname)) window.history.replaceState(null, "", "/");
}
