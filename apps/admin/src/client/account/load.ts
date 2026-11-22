// "Your sign-in"'s data (AdminAccount; spec 02 §14.3 `GET /api/account`): the member's own factors
// and sessions. A failure is the page's `failed` state, not the route's error page.
import type { StaffViewer } from "@fin/app-contracts";
import { type FinRuntime, isApiError } from "@fin/frame";
import { type AccountAnswer, getAccount } from "../api/contracts.ts";

export type AccountData =
  | { readonly kind: "ready"; readonly account: AccountAnswer }
  | { readonly kind: "failed"; readonly requestId: string | null; readonly offline: boolean };

export async function loadAccount(fin: Pick<FinRuntime<StaffViewer>, "api">): Promise<AccountData> {
  try {
    return { kind: "ready", account: await fin.api(getAccount, {}) };
  } catch (error) {
    return {
      kind: "failed",
      requestId: isApiError(error) ? error.requestId : null,
      offline: isApiError(error) && error.kind === "network",
    };
  }
}

export interface FactorRow {
  readonly id: string;
  readonly kind: "passkey" | "authenticator";
  readonly name: string;
  readonly addedAt: string | null;
  readonly lastUsedAt: string | null;
}

/** The factors table's rows: each passkey, then the authenticator when it is on. */
export function factorRows(account: AccountAnswer): FactorRow[] {
  const rows: FactorRow[] = account.passkeys.map((passkey) => ({
    id: passkey.id,
    kind: "passkey",
    name: passkey.name === "" ? "Passkey" : passkey.name,
    addedAt: passkey.createdAt,
    lastUsedAt: passkey.lastUsedAt,
  }));
  if (account.authenticator.enabled) {
    rows.push({
      id: "authenticator",
      kind: "authenticator",
      name: "Authenticator app",
      addedAt: account.authenticator.enabledAt,
      lastUsedAt: null,
    });
  }
  return rows;
}

export const LAST_FACTOR = "Keep another way to sign in first.";

/** Why a factor cannot be removed (spec 02 §6.7: never the last one), or null. */
export function removeFactorReason(rows: readonly FactorRow[]): string | null {
  return rows.length <= 1 ? LAST_FACTOR : null;
}
