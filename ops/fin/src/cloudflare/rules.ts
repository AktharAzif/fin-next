// The zone rules Fin owns (spec 01 §7.6, with BD-12 and BD-13), built from the public settings and
// the overlay's hostnames. Every rule matches Fin's own hosts only, because the zone is shared with
// another product: a rule written for "every host" would also change that product's traffic. Each
// rule's ref starts with `fin_next_`, which is how `zone apply` tells Fin's rules from any other.

import type { HostRole } from "../core/overlay.ts";
import type { Secret } from "../core/secret.ts";

export type Phase =
  | "http_request_dynamic_redirect"
  | "http_request_firewall_custom"
  | "http_request_cache_settings"
  | "http_config_settings"
  | "http_ratelimit"
  | "http_request_late_transform"
  | "http_response_headers_transform";

export const PHASES: readonly Phase[] = [
  "http_request_late_transform",
  "http_request_dynamic_redirect",
  "http_request_firewall_custom",
  "http_ratelimit",
  "http_config_settings",
  "http_request_cache_settings",
  "http_response_headers_transform",
];

export interface DesiredRule {
  phase: Phase;
  ref: string;
  description: string;
  expression: string;
  action: string;
  action_parameters?: Record<string, unknown>;
  ratelimit?: Record<string, unknown>;
  /** The hostnames the expression names, for the guard. */
  hosts: string[];
  /** The ingress proof the rule sets, when it is an ingress-proof rule. */
  proof?: { role: HostRole; value: Secret };
  /** When set, the rule is planned but held, and this says why. */
  held?: string;
  /**
   * An optional rule (the rate rule: Fin's own limits stand alone), applied after every required
   * change and every deletion, so a refusal of it never stops a required rule.
   */
  optional?: boolean;
}

export interface RuleHosts {
  /** Every browser host (the static apps): console, admin, verify, selfie, docs. */
  browser: Array<{ role: HostRole; host: string }>;
  /** The app hosts with an `/api/` path: console, admin, verify, selfie. */
  apiPaths: Array<{ role: HostRole; host: string }>;
  /** The public API host. */
  api: string;
}

export interface RuleInputs {
  hosts: RuleHosts;
  /** The current ingress proof of each host role (api and each apiPaths role). */
  proofs: ReadonlyMap<HostRole, Secret>;
  /**
   * The optional rate rule; absent while the zone is shared ([FD-09]): the Free plan's one rate
   * rule matches on path only, so it would also count and block the other product's requests.
   */
  rate?: {
    pathPrefix: string;
    periodSeconds: number;
    mitigationTimeoutSeconds: number;
    threshold?: number;
  };
}

function quote(value: string): string {
  if (!/^[a-z0-9.-]+$/.test(value)) throw new Error("a rule names only hostnames");
  return `"${value}"`;
}

/** `http.host in {"a" "b"}`, the hosts sorted so the expression is stable. */
export function hostIn(hosts: readonly string[]): string {
  return `http.host in {${[...hosts].sort().map(quote).join(" ")}}`;
}

export const PROOF_HEADER = "Fin-Ingress-Proof";

export function desiredRules(inputs: RuleInputs): DesiredRule[] {
  const browser = inputs.hosts.browser.map((h) => h.host);
  const apiPaths = inputs.hosts.apiPaths.map((h) => h.host);
  const api = inputs.hosts.api;
  const apiTraffic = `(http.host eq ${quote(api)} or (${hostIn(apiPaths)} and starts_with(http.request.uri.path, "/api/")))`;
  const rules: DesiredRule[] = [];

  // Ingress proofs (spec 01 §7.6, S0-08): the API host whole, the app hosts on /api/ only, so the
  // static half never sees a proof. A client-sent header of the same name is overwritten.
  const proofRule = (role: HostRole, host: string, expression: string): void => {
    const value = inputs.proofs.get(role);
    if (value === undefined) throw new Error(`no ingress proof for ${role}`);
    rules.push({
      phase: "http_request_late_transform",
      ref: `fin_next_ingress_proof_${role}`,
      description: `fin-next: ${PROOF_HEADER} for the ${role} host`,
      expression,
      action: "rewrite",
      action_parameters: {
        headers: { [PROOF_HEADER]: { operation: "set", value: value.reveal() } },
      },
      hosts: [host],
      proof: { role, value },
    });
  };
  proofRule("api", api, `(http.host eq ${quote(api)})`);
  for (const { role, host } of inputs.hosts.apiPaths) {
    proofRule(
      role,
      host,
      `(http.host eq ${quote(host)} and starts_with(http.request.uri.path, "/api/"))`,
    );
  }

  // Plain http on the browser hosts: GET and HEAD go to https with 308; anything else is blocked.
  // The API host is left out on purpose: plain http reaches the edge ([FD-03]).
  rules.push({
    phase: "http_request_dynamic_redirect",
    ref: "fin_next_https_browser_hosts",
    description: "fin-next: GET and HEAD over http to https (308) on the browser hosts",
    expression: `(not ssl and ${hostIn(browser)} and http.request.method in {"GET" "HEAD"})`,
    action: "redirect",
    action_parameters: {
      from_value: {
        status_code: 308,
        target_url: { expression: 'concat("https://", http.host, http.request.uri.path)' },
        preserve_query_string: true,
      },
    },
    hosts: browser,
  });
  rules.push({
    phase: "http_request_firewall_custom",
    ref: "fin_next_http_unsafe_block",
    description: "fin-next: any other method over http on the browser hosts",
    expression: `(not ssl and ${hostIn(browser)} and not http.request.method in {"GET" "HEAD"})`,
    action: "block",
    hosts: browser,
  });

  // BD-13 (S-01 (g)): the edge and cloudflared do not agree on dot segments, doubled slashes and
  // encoded slashes, so the browser hosts refuse them outright, on the raw path, with backslashes,
  // semicolons and source maps (AC-P0-23). Encoded dots count too: the edge's URL normalisation
  // decodes `%2e` (an unreserved character) before it removes dot segments, so `/x/%2e%2e/api/`
  // is `/api/` at the edge and something else at the tunnel. An encoded backslash is refused for
  // the same reason.
  const raw = "raw.http.request.uri.path";
  rules.push({
    phase: "http_request_firewall_custom",
    ref: "fin_next_path_refuse",
    description:
      "fin-next: refuse .., //, %2E, %2F, \\, %5C, ; and *.map paths on the browser hosts (BD-13)",
    expression:
      `(${hostIn(browser)} and (${raw} contains ".." or ${raw} contains "//" or ` +
      `lower(${raw}) contains "%2e" or lower(${raw}) contains "%2f" or ` +
      `${raw} contains "\\\\" or lower(${raw}) contains "%5c" or ${raw} contains ";" or ` +
      `ends_with(lower(${raw}), ".map")))`,
    action: "block",
    hosts: browser,
  });
  rules.push({
    phase: "http_config_settings",
    ref: "fin_next_api_no_challenge",
    description:
      "fin-next: Browser Integrity Check off and Security Level essentially off on API traffic",
    expression: apiTraffic,
    action: "set_config",
    action_parameters: { bic: false, security_level: "essentially_off" },
    hosts: [api, ...apiPaths],
  });
  rules.push({
    phase: "http_request_cache_settings",
    ref: "fin_next_api_bypass_cache",
    description: "fin-next: bypass the cache for the API host and /api/ on the app hosts",
    expression: apiTraffic,
    action: "set_cache_settings",
    action_parameters: { cache: false },
    hosts: [api, ...apiPaths],
  });

  // BD-12 (S-01 NF-1): the single-page fallback answers a missing /assets/ path with index.html
  // under the assets' immutable Cache-Control; such an answer must never be cached.
  rules.push({
    phase: "http_response_headers_transform",
    ref: "fin_next_assets_html_no_store",
    description:
      "fin-next: no-store when a browser host answers an /assets/ path with HTML (BD-12)",
    expression: `(${hostIn(browser)} and starts_with(http.request.uri.path, "/assets/") and http.response.content_type.media_type eq "text/html")`,
    action: "rewrite",
    action_parameters: { headers: { "Cache-Control": { operation: "set", value: "no-store" } } },
    hosts: browser,
  });

  // The optional rate rule on the API's /v4/ prefix, last: Fin's own limits stand alone, so a
  // refusal of this rule (a plan limit, say) must never stop the required rules above. Its
  // threshold is private ([OB-13]). Not written at all while the zone is shared ([FD-09]).
  if (inputs.rate !== undefined) {
    const threshold = inputs.rate.threshold;
    const rate: DesiredRule = {
      phase: "http_ratelimit",
      ref: "fin_next_api_v4_rate",
      description: `fin-next: per-address limit on ${inputs.rate.pathPrefix} of the API host`,
      expression: `(http.host eq ${quote(api)} and starts_with(http.request.uri.path, "${inputs.rate.pathPrefix}"))`,
      action: "block",
      ratelimit: {
        characteristics: ["cf.colo.id", "ip.src"],
        period: inputs.rate.periodSeconds,
        requests_per_period: threshold ?? 0,
        mitigation_timeout: inputs.rate.mitigationTimeoutSeconds,
      },
      hosts: [api],
      optional: true,
    };
    if (threshold === undefined) rate.held = "the overlay has no thresholds.api-v4";
    rules.push(rate);
  }
  return rules;
}

/** The fields a rule is compared on (what `zone apply` sets and the watcher hashes). */
export function comparable(rule: {
  description?: string;
  expression?: string;
  action?: string;
  action_parameters?: unknown;
  ratelimit?: unknown;
  enabled?: boolean;
}): Record<string, unknown> {
  return {
    description: rule.description,
    expression: rule.expression,
    action: rule.action,
    action_parameters: rule.action_parameters ?? null,
    ratelimit: rule.ratelimit ?? null,
    enabled: rule.enabled ?? true,
  };
}

/** The body of a rule write. */
export function ruleBody(rule: DesiredRule): Record<string, unknown> {
  return {
    ref: rule.ref,
    description: rule.description,
    expression: rule.expression,
    action: rule.action,
    ...(rule.action_parameters === undefined ? {} : { action_parameters: rule.action_parameters }),
    ...(rule.ratelimit === undefined ? {} : { ratelimit: rule.ratelimit }),
    enabled: true,
  };
}
