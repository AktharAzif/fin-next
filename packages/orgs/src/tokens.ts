// The invitation's bearer values (spec 02 §9.3, S2-15, S2-29). The token is 32 random bytes in
// base64url; only its SHA-256 is stored, it travels only in the link's fragment and in the body of
// `POST /api/invitations/open`, never in a path, and a change or a resend replaces it. Opening a
// live token sets `__Host-fin.invitation`: the invitation's ID and the time it was opened, signed
// with a key derived from the realm's newest secret (every configured secret verifies), alive for a
// day, so the sign-up or sign-in round trip can come back to it without the token.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const INVITATION_ID = /^inv_[0-9a-hjkmnp-tv-z]{26}$/;
export const INVITATION_COOKIE_MAX_AGE_S = 86_400;

export function newInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isInvitationToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

export function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export interface RealmSecret {
  readonly version: number;
  readonly value: string;
}

function keyOf(secret: RealmSecret): Buffer {
  // Domain-separated from every other use of the realm's secrets.
  return createHmac("sha256", secret.value).update("fin.invitation-cookie.v1").digest();
}

function signature(key: Buffer, id: string, issuedS: number): Buffer {
  return createHmac("sha256", key).update(`invitation\u0000${id}\u0000${issuedS}`).digest();
}

export class InvitationCookie {
  readonly #keys: readonly Buffer[];
  constructor(secrets: readonly RealmSecret[]) {
    if (secrets.length === 0) throw new Error("the invitation cookie needs the realm's secrets");
    // Newest first: the newest signs, every one verifies.
    this.#keys = [...secrets].sort((a, b) => b.version - a.version).map(keyOf);
  }

  /** The cookie's value: `<invitation ID>-<seconds>-<signature>`, base64url-safe throughout. */
  sign(invitationId: string, now: Date): string {
    if (!INVITATION_ID.test(invitationId)) throw new Error("not an invitation ID");
    const issued = Math.floor(now.getTime() / 1000);
    const sig = signature(this.#keys[0] as Buffer, invitationId, issued).toString("base64url");
    return `${invitationId}-${issued}-${sig}`;
  }

  /** The invitation ID a live, well-signed cookie names, or null. */
  verify(value: string | null, now: Date): string | null {
    if (value === null || value.length > 120) return null;
    const id = value.slice(0, 30);
    if (!INVITATION_ID.test(id) || value.charAt(30) !== "-") return null;
    const rest = value.slice(31);
    const dash = rest.indexOf("-");
    if (dash <= 0) return null;
    const issuedText = rest.slice(0, dash);
    if (!/^\d{1,12}$/.test(issuedText)) return null;
    const issued = Number(issuedText);
    const age = Math.floor(now.getTime() / 1000) - issued;
    if (age < 0 || age > INVITATION_COOKIE_MAX_AGE_S) return null;
    const given = Buffer.from(rest.slice(dash + 1), "base64url");
    for (const key of this.#keys) {
      const expected = signature(key, id, issued);
      if (given.byteLength === expected.byteLength && timingSafeEqual(given, expected)) return id;
    }
    return null;
  }
}

/** `m•••@example.com`: the invited address as the Invite page shows it (§9.3). */
export function maskAddress(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}
