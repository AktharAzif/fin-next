// One of a web app's own JSON routes under `<app host>/api/*` (FW-C08, spec 06 §2.4). A contract
// names the method, the path under /api, the input and the output as Zod schemas, and what
// `api()` in @fin/frame must add to the request. The server half validates the same schemas.
import { z } from "./zod.ts";

/** The three web apps that have an API half. The docs site has none. */
export const APP_NAMES = ["console", "admin", "verify"] as const;
export type AppName = (typeof APP_NAMES)[number];

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Methods the origin gate checks (FW-C09): everything but GET, HEAD and OPTIONS. */
export function isUnsafeMethod(method: HttpMethod): boolean {
  return method !== "GET";
}

export interface AppContract<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  /** A stable name for reports and logs, such as `viewer.get`. Never a raw path. */
  readonly name: string;
  readonly method: HttpMethod;
  /** The path under `/api`, with `:param` segments filled from the input: `/team/members/:memberId`. */
  readonly path: `/${string}`;
  readonly input: I;
  readonly output: O;
  /** Console only: the route reads `Fin-Organization` (spec 02 S2-10). */
  readonly organization?: boolean;
  /** A create: `api()` sends an `Idempotency-Key`, kept across that action's retries. */
  readonly creates?: boolean;
  /** Milliseconds before `api()` aborts the request; 30 s when absent (spec 06 §2.4). */
  readonly timeoutMs?: number;
}

const PARAM = /^:([A-Za-z][A-Za-z0-9]*)$/;

/** The `:param` names of a contract path, in order. */
export function pathParams(path: string): string[] {
  return path
    .split("/")
    .map((segment) => PARAM.exec(segment)?.[1])
    .filter((name): name is string => name !== undefined);
}

/** An input with nothing in it: a GET with no query, or a body-less POST. */
export const noInput = z.object({}).strict();

/** The answer of a route that answers 204 No Content (`api()` resolves it as `null`). */
export const noContent = z.null();

/**
 * Declares a contract and checks its shape once, at module load: the path sits under `/api`
 * without repeating it, has no query string, and every `:param` is a string field of an object
 * input. A mistake here is a programming error, so it throws.
 */
export function defineContract<I extends z.ZodType, O extends z.ZodType>(
  contract: AppContract<I, O>,
): AppContract<I, O> {
  const { name, method, path, input } = contract;
  if (!/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/.test(name)) {
    throw new Error(`contract name ${JSON.stringify(name)} must be dotted lower camel case`);
  }
  if (!path.startsWith("/") || path === "/api" || path.startsWith("/api/")) {
    throw new Error(`contract ${name}: the path is relative to /api and must not repeat it`);
  }
  if (path.includes("?") || path.includes("#") || path.includes("//")) {
    throw new Error(`contract ${name}: the path holds no query, fragment or empty segment`);
  }
  // The URL parser resolves "." and ".." (and `%2e`, either case) away, so the request would reach
  // another route. api() refuses the same in a parameter's value.
  if (path.split("/").some((segment) => /^(\.|%2e){1,2}$/i.test(segment))) {
    throw new Error(`contract ${name}: the path holds no dot segment`);
  }
  const params = pathParams(path);
  if (params.length > 0) {
    if (!(input instanceof z.ZodObject)) {
      throw new Error(`contract ${name}: a path with parameters needs an object input`);
    }
    for (const param of params) {
      if (!(param in input.shape)) {
        throw new Error(`contract ${name}: the input has no field for :${param}`);
      }
    }
  }
  if (contract.creates === true && method === "GET") {
    throw new Error(`contract ${name}: a GET never creates`);
  }
  if (contract.timeoutMs !== undefined && !(contract.timeoutMs > 0)) {
    throw new Error(`contract ${name}: timeoutMs must be positive`);
  }
  return contract;
}

export type ContractInput<C extends AppContract> = z.input<C["input"]>;
export type ContractOutput<C extends AppContract> = z.output<C["output"]>;
