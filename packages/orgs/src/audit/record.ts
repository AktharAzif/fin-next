// recordOrgAudit (spec 08 §3.3, spec 02 §16.1): this area's adapter in front of `audit.record(p
// jsonb)`, run in the action's own unit of work so the event commits or rolls back with it. Before
// any SQL it checks the event is this fragment's, the actor kind, the target's prefix and the
// metadata's strict schema, and refuses a personal or secret shape in any string. It then writes the
// journal entry the event declares (§16.6) in the same transaction. On any refusal the unit is
// poisoned, so the action that needed the event rolls back, and `audit.write_failed` names the
// event as `auditEvent`: a field named `event` collides with the line's own and is dropped.
import {
  AuditMetadataError,
  assertNoPersonalShapes,
  type LineSink,
  type UnitTx,
} from "@fin/identity";
import { type DateClock, newId } from "../ids.ts";
import {
  type ActorKind,
  type ActorVia,
  type EventSpec,
  ORGS_EVENTS,
  type OrgsEventMetadata,
  type OrgsEventName,
} from "./events.ts";

export type ProofMethod = "passkey" | "totp" | "backup_code";

export interface OrgAuditActor {
  kind: ActorKind;
  id: string | null;
  via: ActorVia;
  stepUp?: { kind: "window" | "intent"; method: ProofMethod; ref: string };
}

export interface RequestFacts {
  clientIp: string | null;
  userAgent: string | null;
}

export interface OrgAuditInput<E extends OrgsEventName> {
  event: E;
  actor: OrgAuditActor;
  target: string;
  refs?: readonly string[];
  organizationId: string;
  metadata: OrgsEventMetadata<E>;
  context?: RequestFacts;
}

export type RecordOrgAudit = <E extends OrgsEventName>(
  tx: UnitTx,
  input: OrgAuditInput<E>,
) => Promise<string>;

export class OrgAuditInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgAuditInputError";
  }
}

const IP = /^[0-9a-fA-F:.]{2,45}$/;
const ID = /^[a-z]{3}_[0-9a-hjkmnp-tv-z]{26}$/;

/** Builds the `audit.record()` argument, refusing what the event's spec does not allow. */
export function orgAuditPayload<E extends OrgsEventName>(
  input: OrgAuditInput<E>,
  id: string,
  requestId: string | null,
  release: string,
): Record<string, unknown> {
  const spec = (ORGS_EVENTS as Record<string, EventSpec>)[input.event];
  if (spec === undefined)
    throw new OrgAuditInputError(`unknown audit event ${String(input.event)}`);
  if (!spec.actors.includes(input.actor.kind)) {
    throw new OrgAuditInputError(
      `${input.event} cannot be recorded by a ${input.actor.kind} actor`,
    );
  }
  if (!input.target.startsWith(`${spec.target}_`) || !ID.test(input.target)) {
    throw new OrgAuditInputError(`${input.event} targets a ${spec.target}_ ID`);
  }
  if (!input.organizationId.startsWith("org_") || !ID.test(input.organizationId)) {
    throw new OrgAuditInputError(`${input.event} is organisation scope and needs the organisation`);
  }
  const parsed = spec.metadata.safeParse(input.metadata);
  if (!parsed.success) {
    throw new AuditMetadataError(String(parsed.error.issues[0]?.path[0] ?? "metadata"), "schema");
  }
  const metadata = parsed.data as Record<string, unknown>;
  assertNoPersonalShapes(metadata);
  const refs = [...new Set(input.refs ?? [])].filter((r) => r !== input.target);
  if (refs.length > 32) throw new OrgAuditInputError("an audit event carries at most 32 refs");
  for (const ref of refs) {
    if (!ID.test(ref)) throw new OrgAuditInputError(`${input.event} refs only IDs`);
  }
  const context =
    input.context === undefined
      ? undefined
      : {
          client_ip:
            input.context.clientIp !== null && IP.test(input.context.clientIp)
              ? input.context.clientIp
              : null,
          user_agent:
            input.context.userAgent === null
              ? null
              : Array.from(input.context.userAgent.toWellFormed()).slice(0, 400).join(""),
        };
  return {
    id,
    event: input.event,
    actor_kind: input.actor.kind,
    actor_id: input.actor.id,
    actor_via: input.actor.via,
    ...(input.actor.stepUp === undefined
      ? {}
      : {
          step_up_kind: input.actor.stepUp.kind,
          step_up_method: input.actor.stepUp.method,
          step_up_ref: input.actor.stepUp.ref,
        }),
    target_id: input.target,
    ref_ids: refs,
    organization_id: input.organizationId,
    metadata,
    request_id: requestId,
    release,
    ...(context === undefined ? {} : { context }),
  };
}

function sqlStateOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return "unknown";
}

export function createRecordOrgAudit(deps: { clock: DateClock; lines: LineSink }): RecordOrgAudit {
  return async (tx, input) => {
    let payload: Record<string, unknown>;
    try {
      payload = orgAuditPayload(input, newId("aud", deps.clock), tx.requestId, tx.release);
    } catch (error) {
      tx.poison("audit_input");
      deps.lines.write("audit.write_failed", "error", {
        auditEvent: input.event,
        sqlstate: "input",
      });
      throw error;
    }
    const id = payload.id as string;
    try {
      await tx.query("SELECT audit.record($1::jsonb) AS id", [JSON.stringify(payload)]);
    } catch (error) {
      tx.poison("audit_write");
      deps.lines.write("audit.write_failed", "error", {
        auditEvent: input.event,
        sqlstate: sqlStateOf(error),
      });
      throw error;
    }
    const spec = (ORGS_EVENTS as Record<string, EventSpec>)[input.event] as EventSpec;
    const journal = spec.journal;
    const metadata = payload.metadata as Record<string, unknown>;
    if (journal !== undefined && (journal.when === undefined || journal.when(metadata))) {
      try {
        await tx.query("SELECT audit.record_journal($1::jsonb)", [
          JSON.stringify({ id: newId("jrn", deps.clock), audit_event_id: id }),
        ]);
      } catch (error) {
        tx.poison("audit_journal");
        deps.lines.write("audit.write_failed", "error", {
          auditEvent: input.event,
          sqlstate: sqlStateOf(error),
        });
        throw error;
      }
    }
    return id;
  };
}
