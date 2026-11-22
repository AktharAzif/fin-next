// recordKeyAudit (spec 08 §3.3; spec 05 §4.10): this area's adapter in front of `audit.record(p
// jsonb)`, run in the action's own unit of work so the event commits or rolls back with the key
// change it describes. Before any SQL it checks the event is this area's, the actor kind, the
// metadata against the fragment's strict schema (packages/audit/src/events/api-keys.ts, the one
// source of the schemas), and refuses a personal or secret shape in any string with P0-E's own
// check. It then writes the journal entry the event declares (`key_revoked`, `key_rolled`) in the
// same transaction. On any refusal the unit is poisoned, so the action that needed the event rolls
// back.
//
// The fragment and the shape check are read by their paths in packages/audit: each imports only zod
// or nothing, and @fin/audit's entry point would bring packages/db's `pg` declaration into the
// console's program, which already holds packages/identity's.
import { newId as coreNewId, type IdPrefix } from "@fin/core";
import type { z } from "zod";
import { events } from "../../audit/src/events/api-keys.ts";
import { assertNoPersonalShapes, assertStorableText } from "../../audit/src/shapes.ts";
import type { DateClock, KeysLines, KeysTx } from "./tx.ts";
import { sqlStateOf } from "./tx.ts";

export const KEY_EVENTS = events;
export type KeyEventName = keyof typeof events;
export type KeyEventMetadata<E extends KeyEventName> = z.input<(typeof events)[E]["metadata"]>;

export interface KeyAuditActor {
  kind: "user" | "system";
  id: string | null;
  via: "console" | "api" | "job";
  stepUp?: { kind: "window" | "intent"; method: "passkey" | "totp" | "backup_code"; ref: string };
}

export interface KeyAuditInput<E extends KeyEventName> {
  event: E;
  actor: KeyAuditActor;
  /** The key's ID. */
  target: string;
  refs?: readonly string[];
  organizationId: string;
  mode: "test" | "live";
  metadata: KeyEventMetadata<E>;
  context?: { clientIp: string | null; userAgent: string | null };
}

export class KeyAuditInputError extends Error {
  override readonly name = "KeyAuditInputError";
}

const KEY_ID = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const ORG_ID = /^org_[0-9a-hjkmnp-tv-z]{26}$/;
const IP = /^[0-9a-fA-F:.]{2,45}$/;

function newId(prefix: "aud" | "jrn", clock: DateClock): string {
  return coreNewId(prefix as IdPrefix, { now: () => clock.now().getTime() });
}

/** Builds the `audit.record()` argument, refusing what the event's spec does not allow. */
export function keyAuditPayload<E extends KeyEventName>(
  input: KeyAuditInput<E>,
  id: string,
  requestId: string | null,
  release: string,
): Record<string, unknown> {
  const spec = events[input.event];
  if (spec === undefined)
    throw new KeyAuditInputError(`unknown audit event ${String(input.event)}`);
  if (!(spec.actors as readonly string[]).includes(input.actor.kind)) {
    throw new KeyAuditInputError(
      `${input.event} cannot be recorded by a ${input.actor.kind} actor`,
    );
  }
  if (!KEY_ID.test(input.target)) throw new KeyAuditInputError(`${input.event} targets a key ID`);
  if (!ORG_ID.test(input.organizationId)) {
    throw new KeyAuditInputError(`${input.event} is organisation scope and needs the organisation`);
  }
  const refs = [...new Set(input.refs ?? [])].filter((r) => r !== input.target);
  if (refs.some((r) => !KEY_ID.test(r))) throw new KeyAuditInputError("refs are key IDs");
  const parsed = (spec.metadata as z.ZodType).safeParse(input.metadata);
  if (!parsed.success) {
    throw new KeyAuditInputError(
      `${input.event}: metadata.${String(parsed.error.issues[0]?.path.join(".") ?? "")} refused`,
    );
  }
  const metadata = parsed.data as Record<string, unknown>;
  assertNoPersonalShapes(metadata);
  assertNoPersonalShapes(input.target, "target");
  const payload: Record<string, unknown> = {
    id,
    event: input.event,
    actor_kind: input.actor.kind,
    actor_id: input.actor.id,
    actor_via: input.actor.via,
    target_id: input.target,
    ref_ids: refs,
    organization_id: input.organizationId,
    mode: input.mode === "live" ? "live" : "sandbox",
    metadata,
    request_id: requestId,
    release,
  };
  if (input.actor.stepUp !== undefined) {
    payload.step_up_kind = input.actor.stepUp.kind;
    payload.step_up_method = input.actor.stepUp.method;
    payload.step_up_ref = input.actor.stepUp.ref;
  }
  if (input.context !== undefined) {
    payload.context = {
      client_ip:
        input.context.clientIp !== null && IP.test(input.context.clientIp)
          ? input.context.clientIp
          : null,
      user_agent:
        input.context.userAgent === null
          ? null
          : Array.from(input.context.userAgent.toWellFormed().replaceAll("\u0000", "\ufffd"))
              .slice(0, 400)
              .join(""),
    };
  }
  assertStorableText(payload, "event");
  return payload;
}

export type RecordKeyAudit = <E extends KeyEventName>(
  tx: KeysTx,
  input: KeyAuditInput<E>,
) => Promise<string>;

export function createRecordKeyAudit(deps: { clock: DateClock; lines: KeysLines }): RecordKeyAudit {
  return async (tx, input) => {
    let payload: Record<string, unknown>;
    try {
      payload = keyAuditPayload(input, newId("aud", deps.clock), tx.requestId, tx.release);
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
        sqlstate: sqlStateOf(error) ?? "unknown",
      });
      throw error;
    }
    if ("journal" in events[input.event]) {
      try {
        await tx.query("SELECT audit.record_journal($1::jsonb)", [
          JSON.stringify({ id: newId("jrn", deps.clock), audit_event_id: id }),
        ]);
      } catch (error) {
        tx.poison("audit_journal");
        deps.lines.write("audit.write_failed", "error", {
          auditEvent: input.event,
          sqlstate: sqlStateOf(error) ?? "unknown",
        });
        throw error;
      }
    }
    return id;
  };
}

/** The rows `audit.event_type` holds for this area (the registry sync's, and the test template's). */
export function keyEventTypeRows(): {
  name: string;
  area: string;
  category: string;
  scope: string;
  roles: string[];
  journal_kind: string | null;
  retired: boolean;
}[] {
  return Object.entries(events).map(([name, spec]) => ({
    name,
    area: "api-keys",
    category: spec.category,
    scope: spec.scope,
    roles: [...spec.roles].sort(),
    journal_kind: "journal" in spec ? spec.journal.kind : null,
    retired: false,
  }));
}
