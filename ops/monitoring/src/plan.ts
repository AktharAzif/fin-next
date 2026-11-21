// Reads what Better Stack holds for the team, compares it with the desired objects, and applies
// the guard rules of spec 08 §7.11 (MA-02 to MA-10) before anything is changed.
import { createHash } from "node:crypto";
import { type BetterStackClient, PATHS, type Resource } from "./betterstack.ts";
import {
  type Desired,
  type DesiredObject,
  EXPLORATION_PREFIX,
  isRef,
  KIND_ORDER,
  type Kind,
} from "./desired.ts";

export interface RemoteObject {
  readonly kind: Kind;
  readonly key: string;
  readonly id: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly parentId?: string;
}

export interface Remote {
  readonly objects: ReadonlyMap<string, RemoteObject>;
  /** Team names seen on each product's objects (MA-02). */
  readonly teams: { readonly telemetry: ReadonlySet<string>; readonly uptime: ReadonlySet<string> };
  /** Policies and severities the files do not name: left in place, but checked (MA-06, MA-08). */
  readonly extraPolicies: readonly RemoteObject[];
  readonly urgenciesById: ReadonlyMap<string, RemoteObject>;
  /** Telemetry alerts on explorations Fin does not manage: left in place, but checked (MA-06). */
  readonly unmanagedAlerts: readonly RemoteObject[];
  /** Sources and Errors applications the files do not name: never deleted, only reported. */
  readonly strays: readonly RemoteObject[];
}

export interface Clients {
  readonly telemetry: BetterStackClient;
  readonly errors: BetterStackClient;
  readonly uptime: BetterStackClient;
}

export type Action =
  | { readonly op: "create"; readonly object: DesiredObject }
  | {
      readonly op: "update";
      readonly object: DesiredObject;
      readonly remote: RemoteObject;
      readonly changes: readonly Change[];
    }
  | { readonly op: "delete"; readonly remote: RemoteObject; readonly why: string }
  | { readonly op: "pause"; readonly remote: RemoteObject; readonly reason: string }
  | { readonly op: "manual"; readonly key: string; readonly kind: Kind; readonly note: string };

export interface Change {
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

export interface Plan {
  readonly actions: readonly Action[];
  readonly unchanged: number;
  readonly refusals: readonly string[];
  readonly notes: readonly string[];
}

const objectKey = (kind: Kind, key: string) => `${kind}:${key}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

/** Reads everything the plan compares. */
export async function readRemote(
  clients: Clients,
  desired: Desired,
  namePrefix: string,
): Promise<Remote> {
  const objects = new Map<string, RemoteObject>();
  const telemetryTeams = new Set<string>();
  const uptimeTeams = new Set<string>();
  const strays: RemoteObject[] = [];
  const desiredKeys = new Set(desired.objects.map((o) => objectKey(o.kind, o.key)));
  const team = (set: Set<string>, r: Resource) => {
    const name = r.attributes.team_name;
    if (typeof name === "string" && name !== "") set.add(name);
  };
  const put = (kind: Kind, key: string, r: Resource, parentId?: string) => {
    objects.set(objectKey(kind, key), {
      kind,
      key,
      id: r.id,
      attributes: r.attributes,
      ...(parentId === undefined ? {} : { parentId }),
    });
  };

  const [urgencies, policies, monitors, heartbeats, sources, applications, explorations, alerts] =
    await Promise.all([
      clients.uptime.list(PATHS.urgencies),
      clients.uptime.list(PATHS.policies),
      clients.uptime.list(PATHS.monitors),
      clients.uptime.list(PATHS.heartbeats),
      clients.telemetry.list(PATHS.sources),
      clients.errors.list(PATHS.applications),
      clients.telemetry.list(PATHS.explorations),
      clients.telemetry.list(PATHS.alerts),
    ]);

  const urgenciesById = new Map<string, RemoteObject>();
  for (const r of urgencies) {
    team(uptimeTeams, r);
    const key = str(r.attributes.name);
    put("urgency", key, r);
    urgenciesById.set(r.id, { kind: "urgency", key, id: r.id, attributes: r.attributes });
  }
  const extraPolicies: RemoteObject[] = [];
  for (const r of policies) {
    team(uptimeTeams, r);
    const key = str(r.attributes.name);
    put("policy", key, r);
    if (!desiredKeys.has(objectKey("policy", key))) {
      extraPolicies.push({ kind: "policy", key, id: r.id, attributes: r.attributes });
    }
  }
  for (const r of monitors) {
    team(uptimeTeams, r);
    put("monitor", str(r.attributes.pronounceable_name), r);
  }
  for (const r of heartbeats) {
    team(uptimeTeams, r);
    put("heartbeat", str(r.attributes.name), r);
  }
  for (const r of sources) {
    team(telemetryTeams, r);
    const key = str(r.attributes.name);
    put("source", key, r);
    if (!desiredKeys.has(objectKey("source", key))) {
      strays.push({ kind: "source", key, id: r.id, attributes: r.attributes });
    }
  }
  for (const r of applications) {
    team(telemetryTeams, r);
    const key = str(r.attributes.name);
    put("application", key, r);
    if (!desiredKeys.has(objectKey("application", key))) {
      strays.push({ kind: "application", key, id: r.id, attributes: r.attributes });
    }
  }
  // Metrics of the sources Fin manages.
  const managedSources = sources.filter((r) => str(r.attributes.name).startsWith(namePrefix));
  const metricLists = await Promise.all(
    managedSources.map(async (s) => ({
      s,
      list: await clients.telemetry.list(PATHS.metrics(s.id)),
    })),
  );
  for (const { s, list } of metricLists) {
    for (const m of list)
      put("metric", `${str(s.attributes.name)}/${str(m.attributes.name)}`, m, s.id);
  }
  // Explorations Fin manages carry the prefix; read each one whole (its queries and variables).
  const managedExplorations = explorations.filter((r) =>
    str(r.attributes.name).startsWith(EXPLORATION_PREFIX),
  );
  const details = await Promise.all(
    managedExplorations.map(async (r) =>
      Array.isArray(r.attributes.queries) && Array.isArray(r.attributes.variables)
        ? r
        : clients.telemetry.get(`${PATHS.explorations}/${encodeURIComponent(r.id)}`),
    ),
  );
  const explorationIds = new Set<string>();
  for (const r of details) {
    team(telemetryTeams, r);
    put("exploration", str(r.attributes.name), r);
    explorationIds.add(r.id);
  }
  const unmanagedAlerts: RemoteObject[] = [];
  for (const r of alerts) {
    team(telemetryTeams, r);
    const key = str(r.attributes.name);
    const exploration = str(r.attributes.exploration_id);
    if (explorationIds.has(exploration)) put("alert", key, r, exploration);
    else unmanagedAlerts.push({ kind: "alert", key, id: r.id, attributes: r.attributes });
  }
  return {
    objects,
    teams: { telemetry: telemetryTeams, uptime: uptimeTeams },
    extraPolicies,
    urgenciesById,
    unmanagedAlerts,
    strays,
  };
}

/** Replaces each { $ref } with its ID; returns undefined when a referenced object does not exist. */
export function resolveRefs(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (isRef(value)) {
    const id = ids.get(value.$ref);
    if (id === undefined) return undefined;
    return value.as === "number" && /^\d+$/.test(id) ? Number(id) : id;
  }
  if (Array.isArray(value)) {
    const out = value.map((v) => resolveRefs(v, ids));
    return out.some((v) => v === undefined) ? undefined : out;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolveRefs(v, ids);
      if (r === undefined && v !== undefined) return undefined;
      out[k] = r;
    }
    return out;
  }
  return value;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const bool = (value: unknown) => value === true;
const sortedStrings = (value: unknown) =>
  Array.isArray(value) ? value.map((v) => String(v)).sort() : [];

function metadataView(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    out[key] = Array.isArray(v) ? v.map(String).join(",") : String(v);
  }
  return out;
}

function headersView(value: unknown, withValues: boolean): unknown {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((h) => ({
      name: str(h.name).toLowerCase(),
      ...(withValues ? { value: h.value === null ? "(unset)" : digest(str(h.value)) } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The attributes compared for each kind, made comparable (IDs as strings, lists sorted). The same
 * function views a desired body (after reference resolution) and a remote object.
 */
export function view(
  kind: Kind,
  attrs: Readonly<Record<string, unknown>>,
  options: { headerValues: boolean },
): Record<string, unknown> {
  const channels = {
    email: bool(attrs.email),
    sms: bool(attrs.sms),
    call: bool(attrs.call),
    push: bool(attrs.push),
    critical_alert: bool(attrs.critical_alert),
  };
  switch (kind) {
    case "urgency":
      return channels;
    case "policy":
      return {
        repeat_count: Number(attrs.repeat_count ?? 0),
        repeat_delay: Number(attrs.repeat_delay ?? 0),
        steps: (Array.isArray(attrs.steps) ? attrs.steps : []).filter(isRecord).map((s) => ({
          type: str(s.type),
          wait_before: Number(s.wait_before ?? 0),
          urgency_id: str(s.urgency_id),
          step_members: (Array.isArray(s.step_members) ? s.step_members : [])
            .filter(isRecord)
            .map((m) => ({ type: str(m.type), ...(m.id == null ? {} : { id: str(m.id) }) })),
        })),
      };
    case "source":
      return { platform: str(attrs.platform), data_region: str(attrs.data_region) };
    case "metric":
      return {
        sql_expression: str(attrs.sql_expression),
        aggregations: sortedStrings(attrs.aggregations),
      };
    case "application":
      return { platform: str(attrs.platform), errors_retention: Number(attrs.errors_retention) };
    case "exploration": {
      const queries = Array.isArray(attrs.queries) ? attrs.queries.filter(isRecord) : [];
      const variables = Array.isArray(attrs.variables) ? attrs.variables.filter(isRecord) : [];
      const source = variables.find((v) => str(v.name) === "source");
      return {
        query: queries.map((q) => str(q.sql_query)).join("\n"),
        sources: sortedStrings(source?.values),
      };
    }
    case "alert": {
      const target = isRecord(attrs.escalation_target) ? attrs.escalation_target : {};
      return {
        operator: str(attrs.operator),
        value: Number(attrs.value),
        check_period: Number(attrs.check_period),
        query_period: Number(attrs.query_period),
        confirmation_period: Number(attrs.confirmation_period),
        recovery_period: Number(attrs.recovery_period),
        on_missing_data: str(attrs.on_missing_data),
        incident_cause: str(attrs.incident_cause),
        incident_per_series: bool(attrs.incident_per_series),
        policy: str(target.policy_id),
        metadata: metadataView(attrs.metadata),
        paused: bool(attrs.paused),
      };
    }
    case "monitor":
      return {
        url: str(attrs.url),
        monitor_type: str(attrs.monitor_type),
        check_frequency: Number(attrs.check_frequency),
        regions: sortedStrings(attrs.regions),
        request_timeout: Number(attrs.request_timeout),
        confirmation_period: Number(attrs.confirmation_period),
        recovery_period: Number(attrs.recovery_period),
        verify_ssl: bool(attrs.verify_ssl),
        ssl_expiration: Number(attrs.ssl_expiration),
        domain_expiration: Number(attrs.domain_expiration),
        follow_redirects: bool(attrs.follow_redirects),
        http_method: str(attrs.http_method ?? "get").toLowerCase(),
        expected_status_codes: sortedStrings(attrs.expected_status_codes),
        required_keyword: str(attrs.required_keyword),
        request_headers: headersView(attrs.request_headers, options.headerValues),
        policy_id: str(attrs.policy_id),
        ...channels,
        paused: bool(attrs.paused) || (attrs.paused_at != null && attrs.paused_at !== ""),
      };
    case "heartbeat":
      return {
        period: Number(attrs.period),
        grace: Number(attrs.grace),
        policy_id: str(attrs.policy_id),
        ...channels,
        paused: bool(attrs.paused) || (attrs.paused_at != null && attrs.paused_at !== ""),
      };
  }
}

const SECRET_FIELDS = new Set(["request_headers"]);

function show(field: string, value: unknown): string {
  if (SECRET_FIELDS.has(field)) return "(not shown)";
  if (field === "query") return "(query)";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function diffViews(a: Record<string, unknown>, b: Record<string, unknown>): Change[] {
  const changes: Change[] = [];
  for (const field of Object.keys(b)) {
    if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) {
      changes.push({ field, from: show(field, a[field]), to: show(field, b[field]) });
    }
  }
  return changes;
}

export interface PlanOptions {
  readonly team: string;
  readonly assertEmptyTeam?: string;
  readonly confirmDelete?: number;
  readonly headerValues: boolean;
  readonly today: string;
}

const LOUD = ["call", "sms", "push", "critical_alert"] as const;

/** Compares desired and remote, and decides what the run may do. */
export function makePlan(desired: Desired, remote: Remote, options: PlanOptions): Plan {
  const refusals: string[] = [];
  const notes: string[] = [];
  const actions: Action[] = [];
  let unchanged = 0;

  // MA-10: every overlay key the files name has a value.
  for (const key of desired.missing) {
    refusals.push(`MA-10 the run's settings have no value for ${key}`);
  }
  // MA-02: the tokens belong to the environment's team.
  for (const [product, teams] of Object.entries(remote.teams)) {
    const others = [...teams].filter((t) => t !== options.team);
    if (others.length > 0) {
      refusals.push(`MA-02 the ${product} token reads another team's objects, not ${options.team}`);
    } else if (teams.size === 0 && options.assertEmptyTeam !== options.team) {
      refusals.push(
        `MA-02 the ${product} token shows no object, so its team cannot be checked; if this is ${options.team}'s first apply, pass --assert-empty-team ${options.team}`,
      );
    }
  }
  // MA-08: no AI responder anywhere.
  for (const policy of [...remote.objects.values()].filter((o) => o.kind === "policy")) {
    const steps = Array.isArray(policy.attributes.steps) ? policy.attributes.steps : [];
    for (const step of steps.filter(isRecord)) {
      const members = Array.isArray(step.step_members) ? step.step_members : [];
      if (members.filter(isRecord).some((m) => m.type === "ai_sre")) {
        refusals.push(`MA-08 policy ${policy.key} has an ai_sre member`);
      }
    }
  }
  // MA-06: nothing left in the team may call, text or push.
  for (const policy of remote.extraPolicies) {
    const steps = Array.isArray(policy.attributes.steps) ? policy.attributes.steps : [];
    for (const step of steps.filter(isRecord)) {
      const urgency = remote.urgenciesById.get(str(step.urgency_id));
      const loud = LOUD.filter((c) => urgency?.attributes[c] === true);
      if (loud.length > 0) {
        refusals.push(
          `MA-06 policy ${policy.key} (not in the files) notifies by ${loud.join(", ")}; staging stays quiet: remove or quiet it`,
        );
      }
    }
  }
  for (const alert of remote.unmanagedAlerts) {
    const loud = LOUD.filter((c) => alert.attributes[c] === true);
    if (loud.length > 0) {
      refusals.push(`MA-06 alert ${alert.key} (not in the files) notifies by ${loud.join(", ")}`);
    }
  }
  for (const object of desired.objects) {
    const loud = LOUD.filter((c) => object.body[c] === true);
    if (loud.length > 0)
      refusals.push(`MA-06 ${object.kind} ${object.key} asks for ${loud.join(", ")}`);
  }

  // IDs known now: everything that exists remotely.
  const ids = new Map<string, string>();
  for (const [key, object] of remote.objects) ids.set(key, object.id);

  const desiredKeys = new Set<string>();
  for (const kind of KIND_ORDER) {
    for (const object of desired.objects.filter((o) => o.kind === kind)) {
      const key = objectKey(kind, object.key);
      desiredKeys.add(key);
      const existing = remote.objects.get(key);
      if (existing === undefined) {
        actions.push({ op: "create", object });
        continue;
      }
      const resolved = resolveRefs(object.body, ids);
      const want =
        resolved === undefined
          ? undefined
          : view(kind, resolved as Record<string, unknown>, options);
      const have = view(kind, existing.attributes, options);
      if (want === undefined) {
        actions.push({
          op: "update",
          object,
          remote: existing,
          changes: [{ field: "references", from: "(current)", to: "(objects this run creates)" }],
        });
        continue;
      }
      if (kind === "monitor" && !options.headerValues) {
        delete want.request_headers;
        delete have.request_headers;
      }
      const changes = diffViews(have, want);
      const fixed = changes.filter((c) => object.immutable?.includes(c.field));
      for (const change of fixed) {
        actions.push({
          op: "manual",
          kind,
          key: object.key,
          note: `${change.field} is ${change.from}, the files say ${change.to}; Better Stack fixes it at creation, so recreate it by hand after review`,
        });
      }
      const sendable = changes.filter((c) => !object.immutable?.includes(c.field));
      if (sendable.length === 0) unchanged += 1;
      else actions.push({ op: "update", object, remote: existing, changes: sendable });
      if (kind === "alert" && existing.attributes.paused === true) {
        const reason = str(existing.attributes.paused_reason);
        notes.push(
          `alert ${object.key} was paused${reason === "" ? " with no recorded reason (MA-09)" : ` (${reason})`}; the apply resumes it`,
        );
      }
    }
  }

  // What the files no longer name.
  const explorationsDeleted = new Set<string>();
  for (const object of remote.objects.values()) {
    if (desiredKeys.has(objectKey(object.kind, object.key))) continue;
    switch (object.kind) {
      case "heartbeat":
        if (!view("heartbeat", object.attributes, options).paused) {
          actions.push({
            op: "pause",
            remote: object,
            reason: `not in ops/monitoring; paused by pnpm fin monitoring apply on ${options.today}`,
          });
        }
        break;
      case "monitor":
      case "metric":
        actions.push({ op: "delete", remote: object, why: "not in the files" });
        break;
      case "exploration":
        explorationsDeleted.add(object.id);
        actions.push({ op: "delete", remote: object, why: "its alert left the files" });
        break;
      case "alert":
        actions.push({ op: "delete", remote: object, why: "not in the files" });
        break;
      default:
        break;
    }
  }
  for (const stray of remote.strays) {
    notes.push(
      `${stray.kind} ${stray.key} is not in the files; sources and Errors applications are never deleted by the apply (remove it by hand after review)`,
    );
  }
  for (const policy of remote.extraPolicies) {
    notes.push(`policy ${policy.key} is not in the files; left in place`);
  }

  // MA-03: deletions are capped.
  const deletes = actions.filter((a) => a.op === "delete").length;
  if (options.confirmDelete !== undefined && options.confirmDelete !== deletes) {
    refusals.push(
      `MA-03 --confirm-delete ${options.confirmDelete} does not match the ${deletes} deletion(s) this run would make`,
    );
  } else if (deletes > 3 && options.confirmDelete !== deletes) {
    refusals.push(
      `MA-03 this run would delete ${deletes} objects; pass --confirm-delete ${deletes}`,
    );
  }
  return { actions, unchanged, refusals, notes };
}

/** The plan as text, one line per action. `mask` hides hostnames before anything is printed. */
export function formatPlan(plan: Plan, mask: (text: string) => string): string {
  const lines: string[] = [];
  for (const action of plan.actions) {
    switch (action.op) {
      case "create":
        lines.push(`+ ${action.object.kind} ${action.object.key}`);
        break;
      case "update":
        lines.push(
          `~ ${action.object.kind} ${action.object.key}: ${action.changes
            .map((c) => `${c.field} ${c.from} -> ${c.to}`)
            .join("; ")}`,
        );
        break;
      case "delete":
        lines.push(`- ${action.remote.kind} ${action.remote.key} (${action.why})`);
        break;
      case "pause":
        lines.push(`|| ${action.remote.kind} ${action.remote.key} (${action.reason})`);
        break;
      case "manual":
        lines.push(`! ${action.kind} ${action.key}: ${action.note}`);
        break;
    }
  }
  for (const note of plan.notes) lines.push(`  note: ${note}`);
  const count = (op: Action["op"]) => plan.actions.filter((a) => a.op === op).length;
  lines.push(
    `summary: ${count("create")} to create, ${count("update")} to update, ${count("delete")} to delete, ${count("pause")} to pause, ${count("manual")} for review, ${plan.unchanged} unchanged`,
  );
  return mask(lines.join("\n"));
}
