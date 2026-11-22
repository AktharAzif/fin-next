// The audit event registry's fragments (spec 08 §3.2). Each area declares its events in
// packages/audit/src/events/<area>.ts with `defineEvents`, owned by the area's lane:
//
//   export const events = defineEvents("platform", { "switch.tripped": { ... } });
//
// `defineEvents` refuses, when the fragment is loaded (so the generator, every test and every boot
// refuse it too): a bad or duplicate name, an unknown category, scope, role or actor kind, empty
// roles or actors, and a metadata schema that is not a strict object of flat fields (T08-01).
import { z } from "zod";

export type AuditScope = "organisation" | "person" | "staff";
export type AuditCategory =
  | "sign_in"
  | "security"
  | "team"
  | "api_keys"
  | "organisation"
  | "customers"
  | "going_live"
  | "webhooks"
  | "money"
  | "staff"
  | "operations"
  | "system";
export type ActorKind =
  | "user"
  | "api_key"
  | "staff"
  | "customer_link"
  | "person_link"
  | "system"
  | "provider"
  | "operator";
export type ActorVia =
  | "console"
  | "api"
  | "hosted_pages"
  | "admin"
  | "job"
  | "webhook"
  | "reconciliation"
  | "operator";
export type AuditRole =
  | "fin_edge"
  | "fin_api"
  | "fin_worker"
  | "fin_payments"
  | "fin_console"
  | "fin_admin"
  | "fin_owner";
export type JournalKind =
  | "key_revoked"
  | "key_rolled"
  | "sessions_ended"
  | "member_removed"
  | "invitation_cancelled"
  | "role_lowered"
  | "organisation_deleted"
  | "organisation_paused"
  | "factor_removed"
  | "trusted_browser_revoked"
  | "staff_removed"
  | "staff_factors_reset"
  | "staff_role_lowered"
  | "links_revoked"
  | "customer_erased"
  | "webhook_secret_rolled"
  | "webhook_endpoint_deleted"
  | "beneficiary_removed"
  | "switch_set"
  | "switch_cleared";

export const SCOPES: readonly AuditScope[] = ["organisation", "person", "staff"];
export const CATEGORIES: readonly AuditCategory[] = [
  "sign_in",
  "security",
  "team",
  "api_keys",
  "organisation",
  "customers",
  "going_live",
  "webhooks",
  "money",
  "staff",
  "operations",
  "system",
];
export const ACTOR_KINDS: readonly ActorKind[] = [
  "user",
  "api_key",
  "staff",
  "customer_link",
  "person_link",
  "system",
  "provider",
  "operator",
];
export const ROLES: readonly AuditRole[] = [
  "fin_edge",
  "fin_api",
  "fin_worker",
  "fin_payments",
  "fin_console",
  "fin_admin",
  "fin_owner",
];
export const JOURNAL_KINDS: readonly JournalKind[] = [
  "key_revoked",
  "key_rolled",
  "sessions_ended",
  "member_removed",
  "invitation_cancelled",
  "role_lowered",
  "organisation_deleted",
  "organisation_paused",
  "factor_removed",
  "trusted_browser_revoked",
  "staff_removed",
  "staff_factors_reset",
  "staff_role_lowered",
  "links_revoked",
  "customer_erased",
  "webhook_secret_rolled",
  "webhook_endpoint_deleted",
  "beneficiary_removed",
  "switch_set",
  "switch_cleared",
];

export const EVENT_NAME = /^[a-z][a-z_]*(\.[a-z][a-z_]*){1,2}$/;
const AREA = /^[a-z][a-z0-9-]{0,62}$/;
const METADATA_KEY = /^[a-z][A-Za-z0-9_]{0,63}$/;

// biome-ignore lint/suspicious/noExplicitAny: the shape of a fragment's metadata schema is checked at load.
export type MetadataSchema = z.ZodObject<any>;

export interface EventSpec<M extends MetadataSchema = MetadataSchema> {
  category: AuditCategory;
  scope: AuditScope;
  /** The login groups that may record it; audit.record() checks. */
  roles: readonly AuditRole[];
  /** The actor kinds that may record it; recordAudit checks. */
  actors: readonly ActorKind[];
  /** The target ID's prefix (`mem`), enforced for three-letter prefixes, or a label (`switch`). */
  target: string;
  /** z.object({...}).strict(): flat values only (§3.3). */
  metadata: M;
  /** The revocation-journal entry the event writes in the same transaction (§3.10). */
  journal?: { kind: JournalKind; when?: (metadata: z.infer<M>) => boolean };
  /** A retired event keeps its name, so old rows still resolve; it can no longer be recorded. */
  retired?: true;
}

export class AuditRegistryError extends Error {
  override readonly name = "AuditRegistryError";
}

const FLAT_TYPES = new Set(["string", "number", "boolean", "null", "enum", "literal"]);

function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (let i = 0; i < 4; i++) {
    const def = current._zod.def as { type: string; innerType?: z.ZodType };
    if (
      (def.type === "optional" || def.type === "nullable" || def.type === "default") &&
      def.innerType
    ) {
      current = def.innerType;
    } else {
      break;
    }
  }
  return current;
}

function isFlatScalar(schema: z.ZodType): boolean {
  return FLAT_TYPES.has((unwrap(schema)._zod.def as { type: string }).type);
}

/** True when the schema is z.object({...}).strict() over flat fields (scalars, or arrays of scalars). */
export function isFlatStrictObject(schema: unknown): boolean {
  if (!(schema instanceof z.ZodType)) return false;
  const def = schema._zod.def as {
    type: string;
    catchall?: z.ZodType;
    shape?: Record<string, z.ZodType>;
  };
  if (def.type !== "object" || def.shape === undefined) return false;
  if ((def.catchall?._zod.def as { type?: string } | undefined)?.type !== "never") return false;
  for (const [key, field] of Object.entries(def.shape)) {
    if (!METADATA_KEY.test(key)) return false;
    const inner = unwrap(field);
    const innerDef = inner._zod.def as { type: string; element?: z.ZodType };
    if (innerDef.type === "array") {
      if (innerDef.element === undefined || !isFlatScalar(innerDef.element)) return false;
    } else if (!FLAT_TYPES.has(innerDef.type)) {
      return false;
    }
  }
  return true;
}

const AREAS = new WeakMap<object, string>();

/** The area a fragment was defined for (read by the generator and the registry sync). */
export function areaOf(events: object): string | undefined {
  return AREAS.get(events);
}

export function defineEvents<const T extends Record<string, EventSpec>>(
  area: string,
  events: T,
): T {
  if (!AREA.test(area)) throw new AuditRegistryError(`area ${area} is not a lower-case name`);
  for (const [name, spec] of Object.entries(events)) {
    const where = `${area}: ${name}`;
    if (!EVENT_NAME.test(name)) throw new AuditRegistryError(`${where}: not an event name`);
    if (!CATEGORIES.includes(spec.category))
      throw new AuditRegistryError(`${where}: unknown category`);
    if (!SCOPES.includes(spec.scope)) throw new AuditRegistryError(`${where}: unknown scope`);
    if (spec.roles.length === 0) throw new AuditRegistryError(`${where}: roles is empty`);
    for (const role of spec.roles) {
      if (!ROLES.includes(role)) throw new AuditRegistryError(`${where}: unknown role ${role}`);
    }
    if (new Set(spec.roles).size !== spec.roles.length)
      throw new AuditRegistryError(`${where}: repeated role`);
    if (spec.actors.length === 0) throw new AuditRegistryError(`${where}: actors is empty`);
    for (const actor of spec.actors) {
      if (!ACTOR_KINDS.includes(actor))
        throw new AuditRegistryError(`${where}: unknown actor ${actor}`);
    }
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(spec.target))
      throw new AuditRegistryError(`${where}: bad target`);
    if (!isFlatStrictObject(spec.metadata)) {
      throw new AuditRegistryError(
        `${where}: metadata must be z.object({...}).strict() of flat fields`,
      );
    }
    if (spec.journal !== undefined && !JOURNAL_KINDS.includes(spec.journal.kind)) {
      throw new AuditRegistryError(`${where}: unknown journal kind`);
    }
  }
  const frozen = Object.freeze(events);
  AREAS.set(frozen, area);
  return frozen;
}

/** Merges fragments, refusing a name defined twice (the generator's cross-fragment check). */
export function mergeFragments(
  fragments: readonly { file: string; events: Record<string, EventSpec> }[],
): {
  events: Record<string, EventSpec>;
  areas: Record<string, string>;
} {
  const events: Record<string, EventSpec> = {};
  const areas: Record<string, string> = {};
  for (const fragment of fragments) {
    const area = areaOf(fragment.events);
    if (area === undefined)
      throw new AuditRegistryError(`${fragment.file}: not made with defineEvents`);
    if (`${area}.ts` !== fragment.file) {
      throw new AuditRegistryError(
        `${fragment.file}: defines area ${area}; the file must be ${area}.ts`,
      );
    }
    for (const [name, spec] of Object.entries(fragment.events)) {
      if (Object.hasOwn(events, name)) {
        throw new AuditRegistryError(
          `${fragment.file}: ${name} is already defined by ${areas[name]}.ts`,
        );
      }
      events[name] = spec;
      areas[name] = area;
    }
  }
  return { events, areas };
}
