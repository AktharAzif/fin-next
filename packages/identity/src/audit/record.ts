// recordAudit (spec 08 §3.3), the adapter in front of `audit.record(p jsonb)` until
// packages/audit's own lands (P0-E). It runs in the caller's unit of work, so the event commits
// or rolls back with the action; on any refusal the unit is poisoned and the action fails.
import type { Clock } from "../ports/clock.ts";
import { sqlState, type UnitTx } from "../ports/db.ts";
import { newId } from "../ports/ids.ts";
import type { LineSink } from "../ports/log.ts";
import { type ActorKind, type ActorVia, REALM_EVENTS, type RealmEventName } from "./events.ts";
import { AuditMetadataError, assertNoPersonalShapes } from "./shapes.ts";

export type ProofMethod = "passkey" | "totp" | "backup_code";

export interface AuditActor {
  kind: ActorKind;
  id: string | null;
  via: ActorVia;
  stepUp?: { kind: "window" | "intent"; method: ProofMethod; ref: string };
}

export interface AuditContext {
  clientIp: string | null;
  userAgent: string | null;
}

export interface AuditInput {
  event: RealmEventName;
  actor: AuditActor;
  target: string;
  refs?: readonly string[];
  organizationId?: string;
  subjectUserId?: string;
  metadata: Record<string, unknown>;
  context?: AuditContext;
}

export type RecordAudit = (tx: UnitTx, input: AuditInput) => Promise<string>;

export class AuditInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditInputError";
  }
}

const IP = /^[0-9a-fA-F:.]{2,45}$/;

/** Builds the `audit.record()` argument, refusing what the event's spec does not allow. */
export function auditPayload(
  input: AuditInput,
  id: string,
  requestId: string | null,
  release: string,
): Record<string, unknown> {
  const spec = REALM_EVENTS[input.event];
  if (spec === undefined) throw new AuditInputError(`unknown audit event ${String(input.event)}`);
  if (!(spec.actors as readonly ActorKind[]).includes(input.actor.kind)) {
    throw new AuditInputError(`${input.event} cannot be recorded by a ${input.actor.kind} actor`);
  }
  if (spec.target !== "" && !input.target.startsWith(`${spec.target}_`)) {
    throw new AuditInputError(`${input.event} targets a ${spec.target}_ ID`);
  }
  if (spec.scope === "person" && input.subjectUserId === undefined) {
    throw new AuditInputError(`${input.event} is person scope and needs the subject`);
  }
  const parsed = spec.metadata.safeParse(input.metadata);
  if (!parsed.success) {
    const key = String(parsed.error.issues[0]?.path[0] ?? "metadata");
    throw new AuditMetadataError(key, "schema");
  }
  const metadata = parsed.data as Record<string, unknown>;
  assertNoPersonalShapes(metadata);
  const refs = [...new Set(input.refs ?? [])].filter((r) => r !== input.target);
  if (refs.length > 32) throw new AuditInputError("an audit event carries at most 32 refs");
  const context =
    input.context === undefined
      ? undefined
      : {
          client_ip:
            input.context.clientIp !== null && IP.test(input.context.clientIp)
              ? input.context.clientIp
              : null,
          user_agent: input.context.userAgent?.slice(0, 400) ?? null,
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
    ...(input.organizationId === undefined ? {} : { organization_id: input.organizationId }),
    ...(input.subjectUserId === undefined ? {} : { subject_user_id: input.subjectUserId }),
    metadata,
    request_id: requestId,
    release,
    ...(context === undefined ? {} : { context }),
  };
}

/**
 * The failed event's name goes in the field `auditEvent`, as packages/audit names it: the line's
 * own `event` is `audit.write_failed`, and the process telemetry drops any field that shares a name
 * with the envelope, so a field called `event` would never reach Better Stack.
 */
function writeFailed(lines: LineSink, input: AuditInput, sqlstate: string): void {
  lines.write("audit.write_failed", "error", { auditEvent: input.event, sqlstate });
}

export function createRecordAudit(deps: { clock: Clock; lines: LineSink }): RecordAudit {
  return async (tx, input) => {
    let payload: Record<string, unknown>;
    try {
      payload = auditPayload(input, newId("aud", deps.clock), tx.requestId, tx.release);
    } catch (error) {
      tx.poison("audit_input");
      writeFailed(deps.lines, input, "input");
      throw error;
    }
    try {
      const result = await tx.query<{ id: string }>("SELECT audit.record($1::jsonb) AS id", [
        JSON.stringify(payload),
      ]);
      const recorded = result.rows[0]?.id;
      if (recorded === undefined) throw new AuditInputError("audit.record returned no ID");
      return recorded;
    } catch (error) {
      tx.poison("audit_write");
      writeFailed(deps.lines, input, sqlState(error) ?? "unknown");
      throw error;
    }
  };
}
