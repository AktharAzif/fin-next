// Railway's GraphQL API (P-13: `pnpm fin` drives it with fetch; spec 01 §6). The project token
// (CR-04) travels in the `Project-Access-Token` header. Reads go through query(); every write goes
// through mutate(), every variable write through setVariables(), which names a service the public
// settings list and sets each secret sealed.
//
// No deploy nobody asked for (the steward's ruling of 22 Nov; ARCHITECTURE §4.9: a changed variable
// stages a redeploy):
//   1. every environment patch commits with `skipDeploys: true`, so a variable write starts no
//      deployment of its own; a provisioning or configuration write stops there;
//   2. a rotation (a secret a running service holds) then redeploys each service that holds it as
//      a step of its own plan, and reads back (rollout.ts);
//   3. nothing removes a variable: Railway's variableDelete takes no skipDeploys, so every removal
//      would start a deployment. mutate() refuses it, and a value no deployment may carry is
//      overwritten with the inert value instead (inspect.ts INERT_VALUE), waiting for removal;
//   4. every commit also sets the plain WRITE_MARKER to `<run ID>:<n>`, which setVariables returns,
//      so a read-back counts only once it shows that write (rollout.ts confirmWritten).
// So `railway deploy` starts exactly one deployment per service it rolls, and migrate runs once
// per run, never a second time racing the password it gives fin_owner for the run.
//
// mutate() checks the mutation it is about to send, not a label beside it: outside a registered run
// it refuses; the mutation must call exactly one root field, one of WRITE_FIELDS, with no selection
// set; its `environmentId` must be the overlay's environment; and every service it names (its
// `serviceId`, or each service of an environment patch) must be one of the project's services. An
// environment patch must pass `skipDeploys: true` in the call itself.
//
// Operation shapes: the project's services, serviceInstanceUpdate and serviceInstanceDeployV2 are
// the ones the hand provisioning used; environmentPatchCommit with
// `{services: {<id>: {variables: {NAME: {value, isSealed: true}}}}}` and `skipDeploys: true` was
// verified on staging on 21 Nov (a sealed value is never read back: the variables read answers its
// name with a null value). Field names marked UNVERIFIED are SP-03's to confirm before a run
// depends on them.

import { ConfigError, ProviderError, RefusedError } from "../core/errors.ts";
import { send } from "../core/http.ts";
import type { Masker } from "../core/mask.ts";
import type { Overlay } from "../core/overlay.ts";
import type { Run } from "../core/run.ts";
import type { Runtime } from "../core/runtime.ts";
import { Secret } from "../core/secret.ts";
import { mustBeSealed, type Settings } from "../core/settings.ts";
import { WRITE_MARKER } from "./inspect.ts";

export const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

/** The longest provider error detail kept, counted after masking. */
const MAX_DETAIL = 400;

/**
 * The root fields a `pnpm fin` mutation may call: environmentPatchCommit (setVariables), and
 * serviceInstanceUpdate and serviceInstanceDeployV2 (`railway deploy`, and the redeploy a rotation
 * makes). Nothing creates and nothing deletes: Railway's variableDelete takes no skipDeploys, so it
 * would start a deployment nobody asked for (rule 3).
 */
const WRITE_FIELDS: ReadonlySet<string> = new Set([
  "environmentPatchCommit",
  "serviceInstanceUpdate",
  "serviceInstanceDeployV2",
]);

/** `mutation <name>(<args>) { <field>(<args>) }`: one root field call and no selection set. */
const ONE_FIELD = /^\s*mutation\s+\w+\s*(?:\([^)]*\))?\s*\{\s*(\w+)\s*\(([^(){}]*)\)\s*\}\s*$/;

/** `skipDeploys: true` as one argument of the field call. */
const SKIP_DEPLOYS = /(?:^|,)\s*skipDeploys\s*:\s*true\s*(?:,|$)/;

const PATCH_COMMIT =
  "mutation finPatch($environmentId: String!, $patch: EnvironmentConfig, $commitMessage: String) { environmentPatchCommit(environmentId: $environmentId, patch: $patch, commitMessage: $commitMessage, skipDeploys: true) }";

interface GraphQlAnswer<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

export type VariableValue = Secret | string;

/**
 * One variable commit, as a read-back checks it (rule 4): the service, the marker the commit set,
 * the names it set sealed (a read shows each by its name, with a null value) and the plain values
 * it set (held here for the comparison only, never printed).
 */
export interface Written {
  service: string;
  serviceId: string;
  marker: string;
  sealed: readonly string[];
  plain: Readonly<Record<string, string>>;
}

export class RailwayApi {
  readonly #token: Secret;
  readonly #runtime: Pick<Runtime, "fetch" | "sleep">;
  readonly #base: string;
  readonly #masker: Masker;
  readonly #projectId: string;
  readonly #environmentId: string;
  #services: Map<string, string> | undefined;
  /** The variable commits this client has sent, for each one's marker (`<run ID>:<n>`). */
  #commits = 0;

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
    const call = ONE_FIELD.exec(query);
    const field = call?.[1];
    if (field === "variableDelete") {
      throw new RefusedError(
        "railway: no variable is deleted: Railway's variableDelete takes no skipDeploys, so it would start a deployment; overwrite the value with the inert one instead",
      );
    }
    if (field === undefined || !WRITE_FIELDS.has(field)) {
      throw new RefusedError(
        "railway: a mutation calls one of the fields pnpm fin writes (environment patch, instance update, deploy)",
      );
    }
    if (field === "environmentPatchCommit" && !SKIP_DEPLOYS.test(call?.[2] ?? "")) {
      throw new RefusedError(
        "railway: an environment patch commits with skipDeploys: true, so it starts no deployment of its own",
      );
    }
    const args = variables;
    if (args.environmentId !== this.#environmentId) {
      throw new RefusedError("railway: a mutation names the overlay's environment");
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
   * Sets variables on one service in one environment commit, which starts no deployment
   * (`skipDeploys: true`): the service takes them at its next deployment. A Secret is set sealed; a
   * plain string is set unsealed, and is refused for any name the settings say must be sealed. The
   * same commit sets WRITE_MARKER to `<run ID>:<n>`; the commit is returned for its read-back.
   */
  async setVariables(
    run: Run,
    settings: Settings,
    service: string,
    variables: Record<string, VariableValue>,
    message: string,
  ): Promise<Written> {
    if (settings.railway.services[service] === undefined) {
      throw new RefusedError(`railway: ${service} is not a service the public settings list`);
    }
    if (Object.hasOwn(variables, WRITE_MARKER)) {
      throw new RefusedError(`railway: ${WRITE_MARKER} is set by every commit itself`);
    }
    const patch: Record<string, { value: string; isSealed?: true }> = {};
    const sealed: string[] = [];
    const plain: Record<string, string> = {};
    for (const [name, value] of Object.entries(variables)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name))
        throw new RefusedError(`railway: ${name} is not a variable name`);
      if (value instanceof Secret) {
        patch[name] = { value: value.reveal(), isSealed: true };
        sealed.push(name);
      } else {
        if (mustBeSealed(settings, name)) {
          throw new RefusedError(`railway: ${name} must be sealed, and a plain value was given`);
        }
        patch[name] = { value };
        plain[name] = value;
      }
    }
    const serviceId = await this.serviceId(service);
    this.#commits++;
    const marker = `${run.id}:${this.#commits}`;
    patch[WRITE_MARKER] = { value: marker };
    plain[WRITE_MARKER] = marker;
    await this.mutate(run, PATCH_COMMIT, {
      environmentId: this.#environmentId,
      patch: { services: { [serviceId]: { variables: patch } } },
      commitMessage: message.slice(0, 200),
    });
    return { service, serviceId, marker, sealed, plain };
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
