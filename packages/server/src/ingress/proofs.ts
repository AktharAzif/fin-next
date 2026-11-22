// The ingress proof (ARCHITECTURE §5.5 check 2; spec 01 §7.6; [FD-12]). A Cloudflare transform
// rule sets `Fin-Ingress-Proof` per host; the service holds the current and previous values and
// compares in constant time. Each value is hashed first, so the comparison never depends on length.
import { createHash, timingSafeEqual } from "node:crypto";
import type { HostRole } from "../config/index.ts";

export const PROOF_HEADER = "fin-ingress-proof";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export class IngressProofs {
  private readonly byRole: Map<HostRole, Buffer[]>;

  constructor(proofs: Partial<Record<HostRole, readonly string[]>>) {
    this.byRole = new Map();
    for (const [role, values] of Object.entries(proofs) as [HostRole, readonly string[]][]) {
      this.byRole.set(role, values.map(digest));
    }
  }

  /** Whether `presented` equals one of the role's accepted proofs, compared in constant time. */
  matches(role: HostRole, presented: string | undefined | null): boolean {
    const accepted = this.byRole.get(role);
    if (accepted === undefined || presented === undefined || presented === null) return false;
    const candidate = digest(presented);
    let found = false;
    for (const value of accepted) found = timingSafeEqual(value, candidate) || found;
    return found;
  }

  /** Whether `presented` is any role's proof (a reason to re-resolve the peers once). */
  matchesAny(presented: string | undefined | null): boolean {
    let found = false;
    for (const role of this.byRole.keys()) found = this.matches(role, presented) || found;
    return found;
  }
}
