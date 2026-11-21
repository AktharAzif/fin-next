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
  /** How many objects each product's token read, whether or not they carry a team name. */
  readonly counts: { readonly telemetry: number; readonly uptime: number };
  /** Every policy read, duplicates included (MA-08 checks each one). */
  readonly policies: readonly RemoteObject[];
  /** Policies and severities the files do not name: left in place, but checked (MA-06, MA-08). */
  readonly extraPolicies: readonly RemoteObject[];
  readonly urgenciesById: ReadonlyMap<string, RemoteObject>;
  /** Telemetry alerts on explorations Fin does not manage: left in place, but checked (MA-06). */
  readonly unmanagedAlerts: readonly RemoteObject[];
  /** Sources and Errors applications the files do not name: never deleted, only reported. */
  readonly strays: readonly RemoteObject[];
  /** Names more than one object of a kind holds, with how many: the apply works by name. */
  readonly duplicates: readonly {
    readonly kind: Kind;
    readonly key: string;
    readonly count: number;
  }[];
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
  /** The compared attribute (what `immutable` names). */
  readonly field: string;
  /** The changed part of it, as printed: `steps[0].step_members`, `metadata.runbook`. */
  readonly path: string;
  readonly from: string;
  readonly to: string;
}

export interface Plan {
  readonly actions: readonly Action[];
  readonly unchanged: number;
  readonly refusals: readonly string[];
  readonly notes: readonly string[];
  /**
   * Whether Better Stack differs from the files: an action to take, a source or Errors
   * application the files do not name, or a refusal Better Stack's own objects cause (two
   * objects with one name, a loud object outside the files, an ai_sre member). A refusal never
   * hides what the run found.
   */
  readonly drift: boolean;
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
  const allPolicies: RemoteObject[] = [];
  const seen = new Map<string, number>();
  const desiredKeys = new Set(desired.objects.map((o) => objectKey(o.kind, o.key)));
  const team = (set: Set<string>, r: Resource) => {
    const name = r.attributes.team_name;
    if (typeof name === "string" && name !== "") set.add(name);
  };
  const put = (kind: Kind, key: string, r: Resource, parentId?: string) => {
    const k = objectKey(kind, key);
    seen.set(k, (seen.get(k) ?? 0) + 1);
    objects.set(k, {
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
    allPolicies.push({ kind: "policy", key, id: r.id, attributes: r.attributes });
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
  for (const r of explorations) team(telemetryTeams, r);
  const metricCount = metricLists.reduce((n, m) => n + m.list.length, 0);
  const duplicates = [...seen]
    .filter(([, count]) => count > 1)
    .map(([k, count]) => {
      const at = k.indexOf(":");
      return { kind: k.slice(0, at) as Kind, key: k.slice(at + 1), count };
    });
  return {
    objects,
    teams: { telemetry: telemetryTeams, uptime: uptimeTeams },
    counts: {
      telemetry:
        sources.length + applications.length + explorations.length + alerts.length + metricCount,
      uptime: urgencies.length + policies.length + monitors.length + heartbeats.length,
    },
    policies: allPolicies,
    extraPolicies,
    urgenciesById,
    unmanagedAlerts,
    strays,
    duplicates,
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
  // What can silence or widen a monitor or heartbeat besides its channels: a maintenance window
  // and a team wait. Unset is the only accepted value.
  const quiet = {
    maintenance_from: attrs.maintenance_from == null ? "" : str(attrs.maintenance_from),
    maintenance_to: attrs.maintenance_to == null ? "" : str(attrs.maintenance_to),
    team_wait: attrs.team_wait == null ? "" : str(attrs.team_wait),
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
        type: str(attrs.type),
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
        alert_type: str(attrs.alert_type),
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
        ...channels,
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
        ...quiet,
        paused: bool(attrs.paused) || (attrs.paused_at != null && attrs.paused_at !== ""),
      };
    case "heartbeat":
      return {
        period: Number(attrs.period),
        grace: Number(attrs.grace),
        policy_id: str(attrs.policy_id),
        ...channels,
        ...quiet,
        paused: bool(attrs.paused) || (attrs.paused_at != null && attrs.paused_at !== ""),
      };
  }
}

const SECRET_FIELDS = new Set(["request_headers"]);

/** Names an object by its ID: `(another <kind>)` for an ID the run did not read. */
export type NameOf = (kind: Kind, id: string) => string;

/**
 * A compared value as it may be printed: the IDs a view holds (policies, sources, severities,
 * step members) replaced by names, so no Better Stack identifier reaches a log. The views are
 * still compared on the IDs themselves.
 */
function displayed(field: string, value: unknown, nameOf: NameOf): unknown {
  const id = (kind: Kind, v: unknown) => (v === "" || v == null ? "(none)" : nameOf(kind, str(v)));
  if (field === "policy" || field === "policy_id") return id("policy", value);
  if (field === "sources" && Array.isArray(value)) return value.map((v) => id("source", v));
  if (field === "steps" && Array.isArray(value)) {
    return value.filter(isRecord).map((step) => ({
      ...step,
      urgency_id: id("urgency", step.urgency_id),
      step_members: (Array.isArray(step.step_members) ? step.step_members : [])
        .filter(isRecord)
        .map((m) => (m.id === undefined ? m : { ...m, id: "(member)" })),
    }));
  }
  return value;
}

/** A compared value as printed: a string bare, anything else as JSON, a query by its digest. */
function text(field: string, shown: unknown): string {
  if (SECRET_FIELDS.has(field)) return "(not shown)";
  if (field === "query") return `(query ${digest(str(shown)).slice(0, 8)})`;
  if (shown === undefined || shown === "") return "(none)";
  return typeof shown === "string" ? shown : JSON.stringify(shown);
}

const WIDTH = 80;

/**
 * Both sides of a change cut to WIDTH around their first difference, so a long value whose
 * change lies past the cut never prints as the same text on both sides.
 */
function clipPair(a: string, b: string): [string, string] {
  if (a.length <= WIDTH && b.length <= WIDTH) return [a, b];
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
  const start = at > WIDTH / 2 ? at - 20 : 0;
  const clip = (s: string) => {
    const head = start > 0 ? "..." : "";
    const body = s.slice(start);
    return head.length + body.length > WIDTH
      ? `${head}${body.slice(0, WIDTH - head.length - 3)}...`
      : `${head}${body}`;
  };
  return [clip(a), clip(b)];
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * One change per differing part: an object by key and a list of objects of one length by index,
 * down to the value that differs, comparing the views themselves and printing what `displayed`
 * shows for them. Two sides that still print alike (an identifier shown by a placeholder) say so.
 */
function partChanges(
  field: string,
  path: string,
  [a, b]: readonly [unknown, unknown],
  [shownA, shownB]: readonly [unknown, unknown],
  out: Change[],
): void {
  if (sameValue(a, b)) return;
  const hidden = SECRET_FIELDS.has(field) || field === "query";
  if (!hidden && isRecord(a) && isRecord(b) && isRecord(shownA) && isRecord(shownB)) {
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      partChanges(field, `${path}.${key}`, [a[key], b[key]], [shownA[key], shownB[key]], out);
    }
    return;
  }
  const objects = (v: unknown): v is Record<string, unknown>[] =>
    Array.isArray(v) && v.every(isRecord);
  if (
    !hidden &&
    objects(a) &&
    objects(b) &&
    a.length === b.length &&
    Array.isArray(shownA) &&
    Array.isArray(shownB)
  ) {
    for (const [i, item] of a.entries()) {
      partChanges(field, `${path}[${i}]`, [item, b[i]], [shownA[i], shownB[i]], out);
    }
    return;
  }
  const [from, to] = clipPair(text(field, shownA), text(field, shownB));
  const differs = to.endsWith(")") ? `${to.slice(0, -1)}, differs)` : `${to} (differs)`;
  out.push({ field, path, from, to: from === to ? differs : to });
}

function diffViews(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  nameOf: NameOf,
): Change[] {
  const changes: Change[] = [];
  for (const field of Object.keys(b)) {
    partChanges(
      field,
      field,
      [a[field], b[field]],
      [displayed(field, a[field], nameOf), displayed(field, b[field], nameOf)],
      changes,
    );
  }
  return changes;
}

export interface PlanOptions {
  readonly team: string;
  readonly assertEmptyTeam?: string;
  readonly confirmDelete?: number;
  readonly headerValues: boolean;
  readonly today: string;
  /** A dry run deletes and pauses nothing, so MA-03's cap is a note for it, not a refusal. */
  readonly dryRun?: boolean;
}

const LOUD = ["call", "sms", "push", "critical_alert"] as const;

/** See makePlan: compared only when the remote object carries them. */
const COMPARED_WHEN_READ: Partial<Record<Kind, readonly string[]>> = {
  metric: ["type"],
  alert: ["alert_type", "email"],
};

/** Compares desired and remote, and decides what the run may do. */
export function makePlan(desired: Desired, remote: Remote, options: PlanOptions): Plan {
  const refusals: string[] = [];
  const notes: string[] = [];
  const actions: Action[] = [];
  let unchanged = 0;
  // Refusals Better Stack's own objects cause: they are differences from the files too.
  let remoteRefusals = 0;
  const refuseRemote = (text: string) => {
    refusals.push(text);
    remoteRefusals += 1;
  };

  // MA-10: every overlay key the files name has a value.
  for (const key of desired.missing) {
    refusals.push(`MA-10 the run's settings have no value for ${key}`);
  }
  // MA-02: the tokens belong to the environment's team. A token whose objects carry no team name
  // proves nothing, and --assert-empty-team speaks only for a product that holds nothing at all.
  for (const product of ["telemetry", "uptime"] as const) {
    const teams = remote.teams[product];
    const count = remote.counts[product];
    const others = [...teams].filter((t) => t !== options.team);
    if (others.length > 0) {
      refusals.push(`MA-02 the ${product} token reads another team's objects, not ${options.team}`);
    } else if (teams.size === 0 && count > 0) {
      refusals.push(
        `MA-02 the ${product} token reads ${count} object(s) but none carries a team name, so its team cannot be checked`,
      );
    } else if (teams.size === 0 && options.assertEmptyTeam !== options.team) {
      refusals.push(
        `MA-02 the ${product} token shows no object, so its team cannot be checked; if this is ${options.team}'s first apply, pass --assert-empty-team ${options.team}`,
      );
    }
  }
  // The apply matches objects by name, so a name two objects share leaves one unseen. Strays,
  // extra policies and severities are only read, so their duplicates do not matter here.
  const desiredKeySet = new Set(desired.objects.map((o) => objectKey(o.kind, o.key)));
  const acted: readonly Kind[] = ["monitor", "heartbeat", "metric", "exploration", "alert"];
  for (const dup of remote.duplicates) {
    if (!desiredKeySet.has(objectKey(dup.kind, dup.key)) && !acted.includes(dup.kind)) continue;
    refuseRemote(
      `Better Stack holds ${dup.count} ${PLURAL[dup.kind]} named ${dup.key}; the apply works by name, so remove the extra one by hand`,
    );
  }
  // MA-08: no AI responder anywhere, on every policy read (duplicates included).
  for (const policy of remote.policies) {
    const steps = Array.isArray(policy.attributes.steps) ? policy.attributes.steps : [];
    for (const step of steps.filter(isRecord)) {
      const members = Array.isArray(step.step_members) ? step.step_members : [];
      if (members.filter(isRecord).some((m) => m.type === "ai_sre")) {
        refuseRemote(`MA-08 policy ${policy.key} has an ai_sre member`);
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
        refuseRemote(
          `MA-06 policy ${policy.key} (not in the files) notifies by ${loud.join(", ")}; staging stays quiet: remove or quiet it`,
        );
      }
    }
  }
  for (const alert of remote.unmanagedAlerts) {
    const loud = LOUD.filter((c) => alert.attributes[c] === true);
    if (loud.length > 0) {
      refuseRemote(`MA-06 alert ${alert.key} (not in the files) notifies by ${loud.join(", ")}`);
    }
  }
  for (const object of desired.objects) {
    const loud = LOUD.filter((c) => object.body[c] === true);
    if (loud.length > 0)
      refusals.push(`MA-06 ${object.kind} ${object.key} asks for ${loud.join(", ")}`);
  }

  // IDs known now: everything that exists remotely; and back from an ID to its name, for output.
  const ids = new Map<string, string>();
  const names = new Map<string, string>();
  for (const [key, object] of remote.objects) {
    ids.set(key, object.id);
    names.set(objectKey(object.kind, object.id), object.key);
  }
  const nameOf: NameOf = (kind, id) => names.get(objectKey(kind, id)) ?? `(another ${kind})`;

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
          changes: [
            {
              field: "references",
              path: "references",
              from: "(current)",
              to: "(objects this run creates)",
            },
          ],
        });
        continue;
      }
      if (kind === "monitor" && !options.headerValues) {
        delete want.request_headers;
        delete have.request_headers;
      }
      // Fields sent on every write whose read-back the API reference does not promise: compared
      // when Better Stack reports them, so a response without one is not drift every day.
      for (const field of COMPARED_WHEN_READ[kind] ?? []) {
        if (existing.attributes[field] === undefined) {
          delete want[field];
          delete have[field];
        }
      }
      const changes = diffViews(have, want, nameOf);
      // MA-06: a managed object someone made loud is put back by this update; say so.
      const loud = LOUD.filter((c) => existing.attributes[c] === true && want[c] === false);
      if (loud.length > 0) {
        notes.push(
          `${kind} ${object.key} notifies by ${loud.join(", ")}; the apply quiets it (MA-06)`,
        );
      }
      const fixed = changes.filter((c) => object.immutable?.includes(c.field));
      for (const change of fixed) {
        actions.push({
          op: "manual",
          kind,
          key: object.key,
          note: `${change.path} is ${change.from}, the files say ${change.to}; Better Stack fixes it at creation, so recreate it by hand after review`,
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

  // MA-03: deletions are capped, and so are pauses: a paused heartbeat watches nothing, so a
  // wrong file must not silence every duty in one unconfirmed run. A dry run deletes and pauses
  // nothing, so it only says what a real run would need, and goes on to report the drift.
  const removals = actions.filter((a) => a.op === "delete" || a.op === "pause").length;
  const confirmed =
    options.confirmDelete === removals || (options.confirmDelete === undefined && removals <= 3);
  if (!confirmed && options.dryRun === true) {
    notes.push(
      `a real run would delete or pause ${removals} objects, so it needs --confirm-delete ${removals} (MA-03)`,
    );
  } else if (options.confirmDelete !== undefined && options.confirmDelete !== removals) {
    refusals.push(
      `MA-03 --confirm-delete ${options.confirmDelete} does not match the ${removals} deletion(s) and pause(s) this run would make`,
    );
  } else if (!confirmed) {
    refusals.push(
      `MA-03 this run would delete or pause ${removals} objects; pass --confirm-delete ${removals}`,
    );
  }
  const drift = actions.length > 0 || remote.strays.length > 0 || remoteRefusals > 0;
  return { actions, unchanged, refusals, notes, drift };
}

const PLURAL: Readonly<Record<Kind, string>> = {
  urgency: "urgencies",
  policy: "policies",
  source: "sources",
  metric: "metrics",
  application: "applications",
  exploration: "explorations",
  alert: "alerts",
  monitor: "monitors",
  heartbeat: "heartbeats",
};

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
            .map((c) => `${c.path} ${c.from} -> ${c.to}`)
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
