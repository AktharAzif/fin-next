// Railway's GraphQL API (P-13: `pnpm fin` drives it with fetch; spec 01 §6). The project token
// (CR-04) travels in the `Project-Access-Token` header. Reads go through query(); every write goes
// through mutate(), and every variable write through setVariables(), which names a service the
// public settings list and sets each secret sealed.
//
// mutate() checks the mutation it is about to send, not a label beside it: outside a registered run
// it refuses; the mutation must call exactly one root field, one of WRITE_FIELDS, with no selection
// set; its `environmentId` must be the overlay's environment; and every service it names (its
// `serviceId`, or each service of an environment patch) must be one of the project's services. A
// variableDelete (whose arguments travel in one `input`) also names the overlay's project, and
// removes only a variable of DELETABLE_VARIABLES.
//
// Operation shapes: the project's services, serviceInstanceUpdate and serviceInstanceDeployV2 are
// the ones the hand provisioning used; environmentPatchCommit with
// `{services: {<id>: {variables: {NAME: {value, isSealed: true}}}}}` was verified on staging on
// 21 Nov (a sealed value is absent from reads afterwards). Field names marked UNVERIFIED in
// queries.ts are SP-03's to confirm before a run depends on them.

import { ConfigError, ProviderError, RefusedError } from "../core/errors.ts";
import { send } from "../core/http.ts";
import type { Masker } from "../core/mask.ts";
import type { Overlay } from "../core/overlay.ts";
import type { Run } from "../core/run.ts";
import type { Runtime } from "../core/runtime.ts";
import { Secret } from "../core/secret.ts";
import { mustBeSealed, type Settings } from "../core/settings.ts";

export const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

/** The longest provider error detail kept, counted after masking. */
const MAX_DETAIL = 400;

/**
 * The root fields a `pnpm fin` mutation may call: environmentPatchCommit (setVariables), and
 * serviceInstanceUpdate, serviceInstanceDeployV2 and variableDelete (`railway deploy`). Nothing
 * creates, and the one delete removes a variable of DELETABLE_VARIABLES.
 */
const WRITE_FIELDS: ReadonlySet<string> = new Set([
  "environmentPatchCommit",
  "serviceInstanceUpdate",
  "serviceInstanceDeployV2",
  "variableDelete",
]);

/** The variables a mutation may delete: migrate's superuser reference, after its run (spec 01 §6.6). */
const DELETABLE_VARIABLES: ReadonlySet<string> = new Set(["FIN_BOOTSTRAP_DATABASE_URL"]);

/** `mutation <name>(<args>) { <field>(<args>) }`: one root field call and no selection set. */
const ONE_FIELD = /^\s*mutation\s+\w+\s*(?:\([^)]*\))?\s*\{\s*(\w+)\s*\([^(){}]*\)\s*\}\s*$/;

interface GraphQlAnswer<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

export type VariableValue = Secret | string;

export class RailwayApi {
  readonly #token: Secret;
  readonly #runtime: Pick<Runtime, "fetch" | "sleep">;
  readonly #base: string;
  readonly #masker: Masker;
  readonly #projectId: string;
  readonly #environmentId: string;
  #services: Map<string, string> | undefined;

  constructor(
    token: Secret,
    runtime: Pick<Runtime, "fetch" | "sleep">,
    overlay: Overlay,
    masker: Masker,
    base = RAILWAY_API,
  ) {
    this.#token = token;
    this.#runtime = runtime;
    this.#base = base;
    this.#masker = masker;
    this.#projectId = overlay.railway.projectId;
    this.#environmentId = overlay.railway.environmentId;
  }

  get environmentId(): string {
    return this.#environmentId;
  }

  get projectId(): string {
    return this.#projectId;
  }

  async #post<T>(
    query: string,
    variables: Record<string, unknown>,
    idempotent: boolean,
  ): Promise<T> {
    const operation = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "operation";
    const response = await send(
      "railway",
      {
        method: "POST",
        url: this.#base,
        headers: {
          "project-access-token": this.#token.reveal(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        idempotent,
      },
      this.#runtime,
    );
    let answer: GraphQlAnswer<T>;
    try {
      answer = JSON.parse(response.text) as GraphQlAnswer<T>;
    } catch {
      throw new ProviderError(
        "railway",
        `railway ${operation} answered ${response.status} with no JSON`,
        response.status,
      );
    }
    if (
      response.status >= 300 ||
      (answer.errors !== undefined && answer.errors.length > 0) ||
      answer.data === undefined
    ) {
      // Masked before it is cut: Railway may echo the patch it refused, and a sealed value cut in
      // two would no longer match the masker.
      const masked = this.#masker.mask(
        (answer.errors ?? []).map((e) => e.message ?? "").join("; "),
      );
      const detail = masked.length <= MAX_DETAIL ? masked : `${masked.slice(0, MAX_DETAIL)}...`;
      throw new ProviderError(
        "railway",
        `railway ${operation} answered ${response.status}${detail === "" ? "" : `: ${detail}`}`,
        response.status,
      );
    }
    return answer.data;
  }

  /** A read. Queries are retried on network errors and 5xx. */
  query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (!/^\s*query\s/.test(query)) throw new RefusedError("railway: query() only reads");
    return this.#post<T>(query, variables, true);
  }

  /**
   * A write, only inside a registered run, and only one of the mutations `pnpm fin` makes, to this
   * environment and the project's own services (checked on the mutation and its variables).
   */
  async mutate<T>(run: Run, query: string, variables: Record<string, unknown>): Promise<T> {
    if (!/^\s*mutation\s/.test(query)) throw new RefusedError("railway: mutate() only writes");
    run.assertWritable("railway mutation");
    const field = ONE_FIELD.exec(query)?.[1];
    if (field === undefined || !WRITE_FIELDS.has(field)) {
      throw new RefusedError(
        "railway: a mutation calls one of the fields pnpm fin writes (environment patch, instance update, deploy, variable delete)",
      );
    }
    // variableDelete carries its arguments in one input object.
    const args =
      field === "variableDelete" ? ((variables.input ?? {}) as Record<string, unknown>) : variables;
    if (args.environmentId !== this.#environmentId) {
      throw new RefusedError("railway: a mutation names the overlay's environment");
    }
    if (
      field === "variableDelete" &&
      (args.projectId !== this.#projectId || !DELETABLE_VARIABLES.has(String(args.name)))
    ) {
      throw new RefusedError(
        "railway: a variable delete names the overlay's project and only migrate's superuser reference",
      );
    }
    const known = new Set((await this.services()).values());
    const patch = args.patch as { services?: Record<string, unknown> } | undefined;
    const named = [
      ...(args.serviceId === undefined ? [] : [String(args.serviceId)]),
      ...Object.keys(patch?.services ?? {}),
    ];
    if (field !== "environmentPatchCommit" && args.serviceId === undefined) {
      throw new RefusedError(`railway: ${field} names its service`);
    }
    if (named.some((id) => !known.has(id))) {
      throw new RefusedError("railway: a mutation names a service that is not the project's");
    }
    return this.#post<T>(query, variables, false);
  }

  /** The project's services by name (their IDs are masked as soon as they are read). */
  async services(): Promise<Map<string, string>> {
    if (this.#services !== undefined) return this.#services;
    const data = await this.query<{
      project: { services: { edges: Array<{ node: { id: string; name: string } }> } };
    }>(
      "query finServices($projectId: String!) { project(id: $projectId) { services { edges { node { id name } } } } }",
      { projectId: this.#projectId },
    );
    const map = new Map<string, string>();
    for (const edge of data.project.services.edges) {
      this.#masker.register(edge.node.id, `<railway:${edge.node.name}>`);
      map.set(edge.node.name, edge.node.id);
    }
    this.#services = map;
    return map;
  }

  async serviceId(name: string): Promise<string> {
    const id = (await this.services()).get(name);
    if (id === undefined)
      throw new ConfigError(`railway: the project has no service named ${name}`);
    return id;
  }

  /**
   * Sets variables on one service in one environment commit. A Secret is set sealed; a plain
   * string is set unsealed, and is refused for any name the settings say must be sealed.
   */
  async setVariables(
    run: Run,
    settings: Settings,
    service: string,
    variables: Record<string, VariableValue>,
    message: string,
  ): Promise<void> {
    if (settings.railway.services[service] === undefined) {
      throw new RefusedError(`railway: ${service} is not a service the public settings list`);
    }
    const patch: Record<string, { value: string; isSealed?: true }> = {};
    for (const [name, value] of Object.entries(variables)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name))
        throw new RefusedError(`railway: ${name} is not a variable name`);
      if (value instanceof Secret) patch[name] = { value: value.reveal(), isSealed: true };
      else {
        if (mustBeSealed(settings, name)) {
          throw new RefusedError(`railway: ${name} must be sealed, and a plain value was given`);
        }
        patch[name] = { value };
      }
    }
    const serviceId = await this.serviceId(service);
    await this.mutate(
      run,
      "mutation finPatch($environmentId: String!, $patch: EnvironmentConfig, $commitMessage: String) { environmentPatchCommit(environmentId: $environmentId, patch: $patch, commitMessage: $commitMessage) }",
      {
        environmentId: this.#environmentId,
        patch: { services: { [serviceId]: { variables: patch } } },
        commitMessage: message.slice(0, 200),
      },
    );
  }

  /** The static egress addresses of a service (UNVERIFIED field names, SP-08 and SP-03). */
  async egressAddresses(service: string): Promise<string[]> {
    const serviceId = await this.serviceId(service);
    const data = await this.query<{ egressGateways: Array<{ ipv4?: string | null }> }>(
      "query finEgress($environmentId: String!, $serviceId: String!) { egressGateways(environmentId: $environmentId, serviceId: $serviceId) { ipv4 } }",
      { environmentId: this.#environmentId, serviceId },
    );
    return data.egressGateways.map((g) => g.ipv4 ?? "").filter((ip) => ip !== "");
  }
}
