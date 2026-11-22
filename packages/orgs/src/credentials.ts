// Credentials made or seen by someone who leaves ([SA-33], spec 02 §9.4, IF-07). Each kind of
// credential registers a source; a removal or a demotion lists what the member made or was shown and,
// by default, rolls it in the same transaction. A credential is rolled at once only when the actor
// holds the permission that rolls it; otherwise with a 1-hour overlap, flagged for the Super admins
// (S2-42), so a role that may only invite and remove people cannot cut Production traffic off in one
// act. API keys register here with stretch 1 (spec 02 §12), webhook signing secrets on Sunday; on
// Saturday the registry is empty and every list is empty.
import type { DashboardPermission } from "@fin/access";
import type { UnitTx } from "@fin/identity";
import type { OrgAuditActor } from "./audit/record.ts";

export interface CredentialItem {
  id: string;
  /** What the list shows ("Production key fin_live_sk_ABCD…"): never the secret. */
  label: string;
  made: boolean;
  seen: boolean;
}

export interface CredentialSource {
  readonly kind: "api_key" | "webhook_secret";
  list(tx: UnitTx, orgId: string, userId: string): Promise<CredentialItem[]>;
  /** The permission that rolls this item: `apiKey.live`, `apiKey.sandbox` or `webhooks.roll_secret`. */
  rollPermission(item: { id: string }): DashboardPermission;
  roll(
    tx: UnitTx,
    orgId: string,
    ids: string[],
    overlap: "now" | "1h",
    actor: OrgAuditActor,
  ): Promise<void>;
}

export interface ListedCredential extends CredentialItem {
  kind: CredentialSource["kind"];
  rollPermission: DashboardPermission;
}

export interface RollOutcome {
  listed: number;
  rolledNow: number;
  rollingWithinHour: number;
}

export class CredentialRegistry {
  readonly #sources: CredentialSource[] = [];

  register(source: CredentialSource): void {
    if (this.#sources.some((s) => s.kind === source.kind)) {
      throw new Error(`credential source ${source.kind} is registered twice`);
    }
    this.#sources.push(source);
  }

  get sources(): readonly CredentialSource[] {
    return this.#sources;
  }

  /** Every credential the member made or was shown, across the sources. */
  async list(tx: UnitTx, orgId: string, userId: string): Promise<ListedCredential[]> {
    const out: ListedCredential[] = [];
    for (const source of this.#sources) {
      for (const item of await source.list(tx, orgId, userId)) {
        out.push({ ...item, kind: source.kind, rollPermission: source.rollPermission(item) });
      }
    }
    return out;
  }

  /**
   * Rolls every listed credential, in the caller's transaction: at once where the actor holds the
   * rolling permission, with a 1-hour overlap otherwise.
   */
  async rollAll(
    tx: UnitTx,
    orgId: string,
    userId: string,
    actorPermissions: ReadonlySet<DashboardPermission>,
    actor: OrgAuditActor,
  ): Promise<RollOutcome> {
    const outcome: RollOutcome = { listed: 0, rolledNow: 0, rollingWithinHour: 0 };
    for (const source of this.#sources) {
      const items = await source.list(tx, orgId, userId);
      outcome.listed += items.length;
      const now = items.filter((item) => actorPermissions.has(source.rollPermission(item)));
      const later = items.filter((item) => !actorPermissions.has(source.rollPermission(item)));
      if (now.length > 0) {
        await source.roll(
          tx,
          orgId,
          now.map((i) => i.id),
          "now",
          actor,
        );
      }
      if (later.length > 0) {
        await source.roll(
          tx,
          orgId,
          later.map((i) => i.id),
          "1h",
          actor,
        );
      }
      outcome.rolledNow += now.length;
      outcome.rollingWithinHour += later.length;
    }
    return outcome;
  }

  /** Counts what the member made or saw, without rolling (rollCredentials: false). */
  async countOnly(tx: UnitTx, orgId: string, userId: string): Promise<RollOutcome> {
    const listed = (await this.list(tx, orgId, userId)).length;
    return { listed, rolledNow: 0, rollingWithinHour: 0 };
  }
}
