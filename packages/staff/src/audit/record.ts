// recordStaffAudit (spec 08 §3.3, spec 02 §16.1): the staff routes' writer in front of
// `audit.record(p jsonb)` and `audit.record_journal(p jsonb)`, in the action's own unit of work, so
// the event (and the revocation-journal entry it declares) commits or rolls back with the action.
// Before any SQL it checks the actor's kind, the target's prefix and the strict metadata schema,
// and refuses a personal or secret shape in the metadata; any refusal poisons the unit and writes
// `audit.write_failed`, so the action cannot commit without its event.
import { assertNoPersonalShapes } from "@fin/identity";
import { newId } from "../ids.ts";
import { type Clock, type LineSink, type RequestFacts, sqlState, type UnitTx } from "../ports.ts";
import { RECORDED_EVENTS, type RecordedEventName } from "./events.ts";

export type ProofMethod = "passkey" | "totp" | "backup_code";

export interface AuditActorInput {
  kind: "staff" | "operator";
  /** `stf_...` for staff; the registered run's ID for the operator. */
  id: string;
  /** The intent that authorised a stepped-up action. */
  stepUp?: { kind: "window" | "intent"; method: ProofMethod; ref: string };
}

export interface StaffAuditInput {
  event: RecordedEventName;
  actor: AuditActorInput;
  target: string;
  refs?: readonly string[];
  metadata: Record<string, unknown>;
  /** The request a Fin Admin actor made: its ID, address and user agent ([BC-03]). */
  request?: RequestFacts;
}

export type RecordStaffAudit = (tx: UnitTx, input: StaffAuditInput) => Promise<string>;

export class StaffAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaffAuditError";
  }
}

const IP = /^[0-9a-fA-F:.]{2,45}$/;

interface SpecShape {
  readonly actors: readonly string[];
  readonly target: string;
  readonly metadata: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  readonly journal?: { readonly kind: string; readonly when?: (metadata: never) => boolean };
}

/** The `audit.record()` argument, refusing anything the event's spec does not allow. */
export function staffAuditPayload(
  input: StaffAuditInput,
  id: string,
  release: string,
  requestId: string | null,
): { payload: Record<string, unknown>; journal: boolean } {
  const spec = RECORDED_EVENTS[input.event] as SpecShape | undefined;
  if (spec === undefined) throw new StaffAuditError(`unknown staff event ${String(input.event)}`);
  if (!spec.actors.includes(input.actor.kind)) {
    throw new StaffAuditError(`${input.event} cannot be recorded by a ${input.actor.kind} actor`);
  }
  if (/^[a-z]{3}$/.test(spec.target) && !input.target.startsWith(`${spec.target}_`)) {
    throw new StaffAuditError(`${input.event} targets a ${spec.target}_ ID`);
  }
  if (input.target === "" || input.target.length > 200) {
    throw new StaffAuditError(`${input.event} needs a target`);
  }
  const parsed = spec.metadata.safeParse(input.metadata);
  if (!parsed.success) throw new StaffAuditError(`${input.event}: metadata refused`);
  const metadata = parsed.data as Record<string, unknown>;
  assertNoPersonalShapes(metadata);
  const refs = [...new Set(input.refs ?? [])].filter((ref) => ref !== input.target);
  if (refs.length > 32) throw new StaffAuditError("an audit event carries at most 32 refs");
  const via = input.actor.kind === "operator" ? "operator" : "admin";
  const request = input.request;
  const payload: Record<string, unknown> = {
    id,
    event: input.event,
    actor_kind: input.actor.kind,
    actor_id: input.actor.id,
    actor_via: via,
    target_id: input.target,
    ref_ids: refs,
    metadata,
    request_id: request?.requestId ?? requestId,
    release,
  };
  if (input.actor.stepUp !== undefined) {
    payload.step_up_kind = input.actor.stepUp.kind;
    payload.step_up_method = input.actor.stepUp.method;
    payload.step_up_ref = input.actor.stepUp.ref;
  }
  if (request !== undefined && via === "admin") {
    payload.context = {
      client_ip: request.clientIp !== null && IP.test(request.clientIp) ? request.clientIp : null,
      user_agent:
        request.userAgent === null ? null : Array.from(request.userAgent).slice(0, 400).join(""),
    };
  }
  const journal =
    spec.journal !== undefined &&
    (spec.journal.when === undefined || spec.journal.when(metadata as never));
  return { payload, journal };
}

export function createRecordStaffAudit(deps: { clock: Clock; lines: LineSink }): RecordStaffAudit {
  return async (tx, input) => {
    let built: { payload: Record<string, unknown>; journal: boolean };
    const id = newId("aud", deps.clock);
    try {
      built = staffAuditPayload(input, id, tx.release, tx.requestId);
    } catch (error) {
      tx.poison("audit_input");
      deps.lines.write("audit.write_failed", "error", {
        auditEvent: input.event,
        sqlstate: "input",
      });
      throw error;
    }
    try {
      await tx.query("SELECT audit.record($1::jsonb)", [JSON.stringify(built.payload)]);
      if (built.journal) {
        await tx.query("SELECT audit.record_journal($1::jsonb)", [
          JSON.stringify({ id: newId("jrn", deps.clock), audit_event_id: id }),
        ]);
      }
    } catch (error) {
      tx.poison("audit_write");
      deps.lines.write("audit.write_failed", "error", {
        auditEvent: input.event,
        sqlstate: sqlState(error) ?? "unknown",
      });
      throw error;
    }
    return id;
  };
}
