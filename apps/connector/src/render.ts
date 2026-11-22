// Renders cloudflared's configuration from the map and FIN_TUNNEL_HOSTS (spec 01 §7.3). It refuses
// (a ConfigError, exit 78) a hostname outside FIN_ZONE or more than one level below it, a role the
// tunnel's map does not hold, a role the map holds but the hosts leave out, a hostname used twice,
// and any target that is not the map's own.
import { ConfigError } from "@fin/core";
import {
  ALLOWED_TARGETS,
  CATCH_ALL,
  INGRESS_MAP,
  type MappedRole,
  type TunnelRole,
} from "./map.ts";

export interface AccessSettings {
  team: string;
  aud: string;
}

export interface RenderInput {
  tunnel: TunnelRole;
  zone: string;
  /** Host role to hostname, as FIN_TUNNEL_HOSTS holds it. */
  hosts: Readonly<Record<string, string>>;
  access?: AccessSettings;
}

export interface IngressRule {
  hostname?: string;
  path?: string;
  service: string;
  httpHostHeader?: string;
  access?: { required: true; teamName: string; audTag: string[] };
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ZONE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Builds the ordered rules, ending with the catch-all. */
export function buildRules(input: RenderInput): IngressRule[] {
  if (!ZONE.test(input.zone)) throw new ConfigError("FIN_ZONE", "malformed");
  const entries = INGRESS_MAP[input.tunnel];
  const known = new Set<string>(entries.map((entry) => entry.role));
  for (const role of Object.keys(input.hosts)) {
    if (!known.has(role)) throw new ConfigError("FIN_TUNNEL_HOSTS", "refused");
  }
  const seen = new Set<string>();
  const rules: IngressRule[] = [];
  for (const entry of entries) {
    const hostname = input.hosts[entry.role as MappedRole];
    if (hostname === undefined) throw new ConfigError("FIN_TUNNEL_HOSTS", "malformed");
    const suffix = `.${input.zone}`;
    const label = hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : undefined;
    if (label === undefined || !LABEL.test(label) || hostname !== hostname.toLowerCase()) {
      throw new ConfigError("FIN_TUNNEL_HOSTS", "refused");
    }
    if (seen.has(hostname)) throw new ConfigError("FIN_TUNNEL_HOSTS", "malformed");
    seen.add(hostname);
    if (!ALLOWED_TARGETS.has(entry.service)) throw new ConfigError("FIN_TUNNEL_HOSTS", "refused");
    const rule: IngressRule = { hostname, service: entry.service, httpHostHeader: hostname };
    if (entry.path !== undefined) rule.path = entry.path;
    if (entry.access === true) {
      if (input.access === undefined) throw new ConfigError("FIN_ACCESS_TEAM", "missing");
      rule.access = { required: true, teamName: input.access.team, audTag: [input.access.aud] };
    }
    rules.push(rule);
  }
  rules.push({ service: CATCH_ALL });
  return rules;
}

const q = (value: string): string => JSON.stringify(value);

/** The YAML cloudflared reads with --config. Strings are JSON-quoted, which YAML accepts. */
export function renderYaml(rules: readonly IngressRule[]): string {
  const lines = [
    "# Rendered at start by the connector supervisor from apps/connector/src/map.ts and",
    "# FIN_TUNNEL_HOSTS. Never edited; a change to the map is a reviewed image.",
    "ingress:",
  ];
  for (const rule of rules) {
    if (rule.hostname === undefined) {
      lines.push(`  - service: ${q(rule.service)}`);
      continue;
    }
    lines.push(`  - hostname: ${q(rule.hostname)}`);
    if (rule.path !== undefined) lines.push(`    path: ${q(rule.path)}`);
    lines.push(`    service: ${q(rule.service)}`);
    lines.push("    originRequest:");
    lines.push(`      httpHostHeader: ${q(rule.httpHostHeader ?? rule.hostname)}`);
    if (rule.access !== undefined) {
      lines.push("      access:");
      lines.push("        required: true");
      lines.push(`        teamName: ${q(rule.access.teamName)}`);
      lines.push("        audTag:");
      for (const tag of rule.access.audTag) lines.push(`          - ${q(tag)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderConfig(input: RenderInput): { rules: IngressRule[]; yaml: string } {
  const rules = buildRules(input);
  return { rules, yaml: renderYaml(rules) };
}

/**
 * The path cloudflared matches a rule's regex against: Go's `URL.Path`, every `%XX` decoded (so
 * `/api%2Fping` and `/%61pi/ping` are `/api/ping`), dot segments and repeated slashes kept as sent
 * (cloudflared's path normalisation is off by default). A malformed escape is no URL at all.
 */
export function cloudflaredPath(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charAt(i);
    if (char !== "%") {
      out += char;
      continue;
    }
    const hex = raw.slice(i + 1, i + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw new Error("not a valid URL: a malformed escape");
    out += String.fromCharCode(Number.parseInt(hex, 16));
    i += 2;
  }
  return out;
}

/**
 * Which rule cloudflared picks for a request (the first rule whose hostname equals the request's,
 * case-insensitively, and whose path regex matches the decoded path; a rule with neither matches
 * everything). Checked against the pinned cloudflared by the test of S-01's paths.
 */
export function matchRule(rules: readonly IngressRule[], url: string): IngressRule {
  const parsed = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  const host = (parsed?.[1] ?? "").toLowerCase().replace(/:\d+$/, "");
  const raw = parsed?.[2] === "" || parsed?.[2] === undefined ? "/" : parsed[2];
  const path = cloudflaredPath(raw);
  for (const rule of rules) {
    if (rule.hostname !== undefined && rule.hostname !== host) continue;
    if (rule.path !== undefined && !new RegExp(rule.path).test(path)) continue;
    return rule;
  }
  throw new Error("no rule matched: the map has no catch-all");
}
