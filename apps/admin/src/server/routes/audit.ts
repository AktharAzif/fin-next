// Fin Admin's audit log routes (spec 02 §14.3, §14.5): a page of the staff log and one entry, each
// in the staff realm's unit of work behind requireStaff with `audit.read` at aal2. The read takes
// the session requireStaff read and the Access `sub` the front door verified, and the database
// checks both again (@fin/staff's audit log reads). The Staff member filter's people come with a
// page only for a reader who may see staff (`staff.read`).
import type { Realm } from "@fin/identity";
import {
  type AuditRange,
  type AuditShow,
  auditPeople,
  type StaffActor,
  type StaffAuditQuery,
  type StaffAuditReader,
  type StaffDeps,
  staffAuditEntry,
  staffAuditLog,
  type UnitTx,
} from "@fin/staff";
import type { PolicyId } from "../policy/index.ts";
import type { HandlerArgs, RouteAnswer, RouteHandler } from "./register.ts";

/** handlers.ts's runner: requireStaff as the policy says, then the work, in one unit. */
export type Guarded = <T>(
  realm: Realm,
  id: PolicyId,
  fn: (tx: UnitTx, who: StaffActor, args: HandlerArgs) => Promise<T>,
) => (args: HandlerArgs) => Promise<T>;

function readerOf(who: StaffActor, args: HandlerArgs): StaffAuditReader {
  return {
    staffId: who.staffId,
    sessionId: who.sessionId,
    accessSub: args.context.access?.sub ?? null,
  };
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.map(String) : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The route's parsed query as the read takes it. */
export function auditQueryOf(query: Record<string, unknown>): StaffAuditQuery {
  return {
    show: text(query.show) as AuditShow | undefined,
    actors: strings(query.actor),
    actions: strings(query.action),
    orgs: strings(query.org),
    range: text(query.date) as AuditRange | undefined,
    from: text(query.from),
    to: text(query.to),
    cursor: text(query.cursor),
    before: text(query.before),
    limit: Number(query.limit),
  };
}

const ok = (body: unknown): RouteAnswer => ({ status: 200, body });

export function auditHandlers(
  deps: StaffDeps,
  guarded: Guarded,
): Readonly<Record<"audit.list" | "audit.get", RouteHandler>> {
  const { realm } = deps;
  return {
    "audit.list": async (args) =>
      ok(
        await guarded(realm, "audit.list", async (tx, who, { input }) => {
          const page = await staffAuditLog(
            deps,
            tx,
            readerOf(who, args),
            auditQueryOf(input.query),
          );
          const people = who.permissions.has("staff.read") ? await auditPeople(tx) : [];
          return { ...page, people };
        })(args),
      ),

    "audit.get": async (args) =>
      ok({
        entry: await guarded(realm, "audit.get", (tx, who, { input }) =>
          staffAuditEntry(deps, tx, readerOf(who, args), String(input.params.eventId)),
        )(args),
      }),
  };
}
