// What a realm's hooks share: its settings and the ports, built once per process in main().
import type { AsyncLocalStorage } from "node:async_hooks";
import type { RecordAudit } from "./audit/record.ts";
import type { RealmSettings } from "./config.ts";
import type { KeyedHasher } from "./crypto/keyed.ts";
import type { EmailEnqueue } from "./email/enqueue.ts";
import type { EndpointPolicy } from "./endpoint-policy.ts";
import type { LimitStore } from "./limits.ts";
import type { PasswordHasher } from "./passwords/hasher.ts";
import type { Clock } from "./ports/clock.ts";
import type { FinDatabase, Queryable, UnitTx } from "./ports/db.ts";
import type { LineSink } from "./ports/log.ts";
import type { RequestState } from "./request.ts";
import type { StepUpAction } from "./step-up/types.ts";

/** Reads a kill switch on every request with no cache (spec 01 §6.10); unknown fails closed. */
export type KillSwitchReader = (db: Queryable, name: "signups") => Promise<"on" | "off">;

export const readKillSwitch: KillSwitchReader = async (db, name) => {
  const result = await db.query<{ state: "on" | "off" }>(
    "SELECT state FROM ops.kill_switch WHERE name = $1",
    [name],
  );
  return result.rows[0]?.state ?? "on";
};

export interface RealmRuntime {
  readonly settings: RealmSettings;
  readonly policy: EndpointPolicy;
  readonly db: FinDatabase;
  readonly clock: Clock;
  readonly lines: LineSink;
  readonly audit: RecordAudit;
  readonly email: EmailEnqueue;
  readonly limits: LimitStore;
  readonly hasher: KeyedHasher;
  readonly killSwitch: KillSwitchReader;
  readonly actions: ReadonlyMap<string, StepUpAction>;
  readonly requests: AsyncLocalStorage<RequestState>;
  /** The docs origin problem types are built on (`https://developer.<zone>`). */
  readonly docsOrigin: string;
  /** argon2id with the process's hashing slots (passwords/hasher.ts, §5.7). */
  readonly passwords: PasswordHasher;
}

export class RealmStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealmStateError";
  }
}

/** The bound request state; the library's hooks run only inside a realm request. */
export function requestState(rt: RealmRuntime): RequestState {
  const state = rt.requests.getStore();
  if (state === undefined)
    throw new RealmStateError("identity: a library call ran outside a realm request");
  return state;
}

export function unitOf(rt: RealmRuntime): UnitTx {
  const tx = rt.db.current();
  if (tx === null) throw new RealmStateError("identity: a library call ran outside a unit of work");
  return tx;
}
