// How sessions reach Claude (decision BD-22): `direct`, the default, or `pool`, opt-in.
//
// `direct` is spec 07 §4.3 as the trimmed Phase 0 runs it: the session keeps the engine's HOME and
// its Claude Code login (or CLAUDE_CODE_OAUTH_TOKEN), and every endpoint, credential and
// configuration-directory variable is refused (config/env-refusals.json).
//
// `pool` is for the build machine, where every Claude Code session reaches Claude through a local
// pool forwarder: ANTHROPIC_BASE_URL is a loopback URL, ANTHROPIC_AUTH_TOKEN the forwarder's token
// and CLAUDE_CONFIG_DIR its configuration directory. Under pool those three, and only those, are
// accepted, each checked here, and passed into every session's environment in place of the login;
// every model, effort, provider and other credential variable is still refused, and the post-session
// modelUsage check still decides which model ran. The base URL must be http or https to
// 127.0.0.1, ::1 or localhost, with an explicit port and no path beyond "/", no user, query or
// fragment: a forwarder on this machine, never another endpoint.
//
// The transport is read only from the engine's own environment (FIN_REVIEW_TRANSPORT), never from an
// R11 option, a machine config file or a spool request, so nothing a run is asked to do can change
// where its sessions go. Values are never printed: errors name the variable only.

export type TransportKind = "direct" | "pool";

export type Transport =
  | { readonly kind: "direct" }
  | {
      readonly kind: "pool";
      /** The forwarder's URL, exactly as the engine's environment gave it. */
      readonly baseUrl: string;
      /** host:port of the forwarder, recorded as each session's API host. */
      readonly host: string;
      readonly authToken: string;
      /** The forwarder's Claude Code configuration directory, absolute. */
      readonly configDir: string;
    };

export const TRANSPORT_VARIABLE = "FIN_REVIEW_TRANSPORT";
/** The variables a pool transport accepts and passes into each session, and nothing else. */
export const POOL_VARIABLES: readonly string[] = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR"];
export const DIRECT: Transport = Object.freeze({ kind: "direct" });

const POOL_URL_RE = /^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\/?$/;
const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;
const ABSOLUTE_RE = /^\/[^\0\n\r]*$/;

/** The names in `env` that equal `name` when case is ignored (Windows reads names that way). */
function spellings(env: Readonly<Record<string, string | undefined>>, name: string): string[] {
  return Object.keys(env).filter((key) => env[key] !== undefined && key.toUpperCase() === name);
}

/** Why `value` is not a pool forwarder's base URL, or null when it is one. */
export function poolUrlProblem(value: string): string | null {
  const match = POOL_URL_RE.exec(value);
  if (match === null) return "must be http:// or https:// to 127.0.0.1, [::1] or localhost with an explicit port and no path, user, query or fragment";
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || (match[3] ?? "").startsWith("0")) return "must name a port from 1 to 65535";
  return null;
}

/**
 * The transport the engine's environment asks for, or why it cannot be used. Under `direct` the
 * pool variables are left to the ordinary refusals; under `pool` each is checked here.
 */
export function resolveTransport(env: Readonly<Record<string, string | undefined>>): { ok: true; value: Transport } | { ok: false; errors: string[] } {
  const names = spellings(env, TRANSPORT_VARIABLE);
  if (names.length > 1 || (names.length === 1 && names[0] !== TRANSPORT_VARIABLE)) {
    return { ok: false, errors: [`${TRANSPORT_VARIABLE} must be set once, in upper case`] };
  }
  const kind = env[TRANSPORT_VARIABLE];
  if (kind === undefined || kind === "" || kind === "direct") return { ok: true, value: DIRECT };
  if (kind !== "pool") return { ok: false, errors: [`${TRANSPORT_VARIABLE} must be direct or pool`] };
  const errors: string[] = [];
  for (const name of POOL_VARIABLES) {
    const found = spellings(env, name);
    if (found.length === 0 || (env[name] ?? "") === "") errors.push(`the pool transport needs ${name}`);
    else if (found.length > 1 || found[0] !== name) errors.push(`${name} must be set once, in upper case`);
  }
  if (errors.length > 0) return { ok: false, errors };
  const baseUrl = env["ANTHROPIC_BASE_URL"] ?? "";
  const authToken = env["ANTHROPIC_AUTH_TOKEN"] ?? "";
  const configDir = env["CLAUDE_CONFIG_DIR"] ?? "";
  const urlProblem = poolUrlProblem(baseUrl);
  if (urlProblem !== null) errors.push(`ANTHROPIC_BASE_URL ${urlProblem}`);
  if (!TOKEN_RE.test(authToken)) errors.push("ANTHROPIC_AUTH_TOKEN must be printable ASCII with no space, at most 4096 characters");
  if (!ABSOLUTE_RE.test(configDir) || configDir.split("/").includes("..")) errors.push("CLAUDE_CONFIG_DIR must be an absolute path with no .. segment");
  // One credential: the forwarder's token. A second would leave the client to choose between them.
  if (spellings(env, "CLAUDE_CODE_OAUTH_TOKEN").length > 0) errors.push("the pool transport takes its credential from ANTHROPIC_AUTH_TOKEN only; unset CLAUDE_CODE_OAUTH_TOKEN");
  if (errors.length > 0) return { ok: false, errors };
  const match = POOL_URL_RE.exec(baseUrl);
  const host = `${match?.[2] ?? ""}:${match?.[3] ?? ""}`;
  return { ok: true, value: Object.freeze({ kind: "pool", baseUrl, host, authToken, configDir }) };
}

/**
 * `env` less the variables the transport itself accepts (exact names only), for the refusal
 * check: under `pool`, the three pool variables; under `direct`, nothing.
 */
export function withoutTransportVariables(env: Readonly<Record<string, string | undefined>>, transport: Transport): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  if (transport.kind === "pool") for (const name of POOL_VARIABLES) delete out[name];
  return out;
}
