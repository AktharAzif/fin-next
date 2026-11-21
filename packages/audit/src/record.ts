// recordAudit (spec 08 §3.3): the only caller of audit.record() in application code. It runs inside the
// action's transaction (a UnitTx, so a call outside one is a type error), and before any SQL:
//   - makes the `aud_` ID from the unit's clock, and takes the request ID and release from its context;
//   - checks the actor's kind against the event's `actors`;
//   - parses the metadata with the event's strict schema;
//   - refuses an email, IP, token or key shape, URL with a query, or nine digits in any string, and any
//     string Postgres cannot store as JSON (a lone UTF-16 surrogate or a U+0000) (AuditMetadataError);
//   - keeps at most 400 characters of the client's user agent, cut between characters, never inside
//     one, with lone surrogates and U+0000 replaced, so a header the client chooses can never make the
//     row unstorable.
// It then writes the event and the journal entry the event declares, in the same transaction. On any
// FA error from the database it writes `audit.write_failed` (`auditEvent`, `sqlstate`) and throws
// AuditWriteError; the unit rolls back and the action answers 500 with the request ID only.
import { sqlState, type UnitTx } from "@fin/db";
import type { z } from "zod";
import type { ActorKind, ActorVia, EventSpec } from "./define.ts";
import { AUDIT_EVENTS, type AuditEventName, type AuditEvents } from "./events/_index.gen.ts";
import { AuditMetadataError, assertNoPersonalShapes, assertStorableText } from "./shapes.ts";

/** The longest user agent kept, in characters (code points), as audit.event_context allows. */
export const USER_AGENT_MAX = 400;

/**
 * A client's user agent as the context row keeps it: lone surrogates and U+0000 (which no Postgres
 * text holds) replaced with U+FFFD, then cut to at most 400 characters by code point, so the cut never
 * splits a character in two.
 */
export function storedUserAgent(userAgent: string): string {
  return Array.from(userAgent.toWellFormed().replaceAll("\u0000", "�"))
    .slice(0, USER_AGENT_MAX)
    .join("");
}

declare const auditEventIdBrand: unique symbol;
export type AuditEventId = string & { readonly [auditEventIdBrand]: true };

export interface AuditActor {
  kind: ActorKind;
  id: string | null;
  via: ActorVia;
  keyId?: string;
  linkSessionId?: string;
  stepUp?: { kind: "window" | "intent"; method: "passkey" | "totp" | "backup_code"; ref: string };
}

export interface RecordInput<E extends AuditEventName> {
  event: E;
  actor: AuditActor;
  target: string;
  refs?: readonly string[];
  organizationId?: string;
  subjectUserId?: string;
  mode?: "sandbox" | "live";
  metadata: z.input<AuditEvents[E]["metadata"]>;
  context?: { clientIp: string | null; userAgent: string | null };
}

export class AuditEventError extends Error {
  override readonly name = "AuditEventError";
}

/** The database refused the event (an FA SQLSTATE); the transaction cannot commit. */
export class AuditWriteError extends Error {
  override readonly name = "AuditWriteError";
  readonly event: string;
  readonly sqlstate: string;
  constructor(event: string, sqlstate: string) {
    super(`audit event ${event} was refused (${sqlstate})`);
    this.event = event;
    this.sqlstate = sqlstate;
  }
}

export function eventSpec(name: string): EventSpec {
  const spec = (AUDIT_EVENTS as Record<string, EventSpec>)[name];
  if (spec === undefined || spec.retired === true) {
    throw new AuditEventError(`${name} is not a registered event`);
  }
  return spec;
}

const THREE_LETTER_PREFIX = /^[a-z]{3}$/;

function checkTarget(spec: EventSpec, name: string, target: string): void {
  if (target === "" || target.length > 200)
    throw new AuditEventError(`${name}: target is required`);
  if (THREE_LETTER_PREFIX.test(spec.target) && !target.startsWith(`${spec.target}_`)) {
    throw new AuditEventError(`${name}: target must be a ${spec.target}_ ID`);
  }
}

/**
 * Writes `audit.write_failed` and rethrows an FA error as AuditWriteError; other errors pass through.
 * The audit event's name is the field `auditEvent`: the line's own `event` is `audit.write_failed`,
 * and a line writer never lets a field overwrite its envelope.
 */
export function rethrowAuditFailure(tx: UnitTx, event: string, error: unknown): never {
  const state = sqlState(error);
  if (state?.startsWith("FA")) {
    tx.context.log.write({
      event: "audit.write_failed",
      level: "error",
      fields: { auditEvent: event, sqlstate: state },
    });
    throw new AuditWriteError(event, state);
  }
  throw error;
}

/**
 * Writes the journal entry an event declares, in the caller's transaction (§3.10). Whether to write
 * it is the fragment's (`journal.when`); what it says is the database's: audit.record_journal() takes
 * the kind from the event's type and the organisation and subjects from the event's row.
 */
export async function writeJournalEntry(
  tx: UnitTx,
  spec: EventSpec,
  input: { event: string; eventId: string; metadata: unknown },
): Promise<string | undefined> {
  if (spec.journal === undefined) return undefined;
  if (spec.journal.when !== undefined && !spec.journal.when(input.metadata as never))
    return undefined;
  const id = tx.ids.newId("jrn");
  try {
    await tx.query("SELECT audit.record_journal($1::jsonb)", [
      JSON.stringify({ id, audit_event_id: input.eventId }),
    ]);
  } catch (error) {
    rethrowAuditFailure(tx, input.event, error);
  }
  return id;
}

export async function recordAudit<E extends AuditEventName>(
  tx: UnitTx,
  input: RecordInput<E>,
): Promise<AuditEventId> {
  const spec = eventSpec(input.event);
  if (!spec.actors.includes(input.actor.kind)) {
    throw new AuditEventError(`${input.event}: actor kind ${input.actor.kind} is not allowed`);
  }
  checkTarget(spec, input.event, input.target);
  const refs = input.refs ?? [];
  if (refs.length > 32) throw new AuditEventError(`${input.event}: at most 32 refs`);

  const parsed = spec.metadata.safeParse(input.metadata);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AuditMetadataError(`metadata.${issue?.path.join(".") ?? ""}`, "schema");
  }
  const metadata = parsed.data as Record<string, unknown>;
  assertNoPersonalShapes(metadata);
  assertNoPersonalShapes(input.target, "target");
  assertNoPersonalShapes(refs, "refs");

  const id = tx.ids.newId("aud");
  const payload: Record<string, unknown> = {
    id,
    event: input.event,
    actor_kind: input.actor.kind,
    actor_id: input.actor.id,
    actor_via: input.actor.via,
    target_id: input.target,
    ref_ids: refs,
    metadata,
    release: tx.context.release,
  };
  if (input.actor.keyId !== undefined) payload.actor_key_id = input.actor.keyId;
  if (input.actor.linkSessionId !== undefined)
    payload.actor_link_session_id = input.actor.linkSessionId;
  if (input.actor.stepUp !== undefined) {
    payload.step_up_kind = input.actor.stepUp.kind;
    payload.step_up_method = input.actor.stepUp.method;
    payload.step_up_ref = input.actor.stepUp.ref;
  }
  if (input.organizationId !== undefined) payload.organization_id = input.organizationId;
  if (input.subjectUserId !== undefined) payload.subject_user_id = input.subjectUserId;
  if (input.mode !== undefined) payload.mode = input.mode;
  if (tx.context.requestId !== undefined) payload.request_id = tx.context.requestId;
  if (input.context !== undefined) {
    payload.context = {
      client_ip: input.context.clientIp,
      user_agent:
        input.context.userAgent === null ? null : storedUserAgent(input.context.userAgent),
    };
  }
  // Every string reaches Postgres as JSON; one it cannot store would fail the action with a code no
  // audit alert reads, so it is refused here, naming the field.
  assertStorableText(payload, "event");

  try {
    await tx.query("SELECT audit.record($1::jsonb)", [JSON.stringify(payload)]);
  } catch (error) {
    rethrowAuditFailure(tx, input.event, error);
  }
  await writeJournalEntry(tx, spec, { event: input.event, eventId: id, metadata });
  return id as AuditEventId;
}
